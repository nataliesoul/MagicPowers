/**
 * MagicPowersPortalPower — Portal magic: trace a circle to open a glowing ring onto another world.
 *
 * Owns: the single portal (open / size / close state), its rim (rings, runes, rim sparks, outer glow),
 *       the "other world" seen through it (a dark disc with a soft edge drawn in normal blend, a
 *       recessed parallax star field, swirling nebula clouds and motes spiralling into the centre),
 *       the hand-spread size control and the portal SFX.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager;
 *          GestureType.CircleTrace from MagicPowersGestureRecognizer.
 * Must not: read SIK directly or decide which power is active.
 *
 * Gesture map:  index finger traces a circle → a portal bursts open at the circle, facing the user
 *               both open palms near the portal: spreading them expands it, closing them shrinks it
 *               hands together (fast or < closeDistanceCm) → the portal collapses
 *
 * Why no stencil: the interior is kept inside the rim geometrically (coplanar disc + a shallow parallax
 * well whose layers shrink faster than perspective offsets them), so it needs no stencil buffer — the
 * Specs default render target has none, and a failed stencil test would silently hide the interior.
 */

import { GestureEvent, GestureType, HandPose, MagicPower, PowerId, TwoHandState } from "./MagicPowersTypes"
import {
  ParticlePool,
  QuadBatch,
  approach,
  cameraBasis,
  clamp01,
  cloneGlowMaterial,
  flickerNoise,
  hash1,
  lerp,
  perpendicularBasis,
  randRange,
  randomUnitVector,
  smoothstep,
  tint,
} from "./MagicPowersEffectsLib"
import { SfxEmitter, playOneShotAt } from "./MagicPowersAudioLib"
import { MagicSfx } from "./MagicPowersAssetManifest"

type CamBasis = { pos: vec3; right: vec3; up: vec3; look: vec3 }
type PortalState = "closed" | "open" | "closing"

interface Star {
  /** polar position inside the unit disc */
  r: number
  angle: number
  /** 0 = on the portal plane, 1 = deepest */
  depth: number
  size: number
  speed: number
  phase: number
  hue: number
}

interface Ripple {
  age: number
  outward: boolean
}

/** Filled disc (triangle fan) on a plane, drawn with a normal-blend clone of the glow material. */
class DiscVisual {
  readonly obj: SceneObject
  private builder: MeshBuilder
  private rmv: RenderMeshVisual
  private verts: number[]
  private readonly segments = 40

  constructor(parent: SceneObject, name: string, material: Material) {
    this.obj = global.scene.createSceneObject(name)
    this.obj.setParent(parent)
    const t = this.obj.getTransform()
    t.setWorldPosition(vec3.zero())
    t.setWorldRotation(quat.quatIdentity())
    t.setWorldScale(vec3.one())
    this.builder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "color", components: 4 },
      { name: "texture0", components: 2 },
    ])
    this.builder.topology = MeshTopology.Triangles
    this.builder.indexType = MeshIndexType.UInt16
    this.verts = new Array<number>((this.segments + 1) * 9).fill(0)
    this.builder.appendVerticesInterleaved(this.verts)
    const idx: number[] = []
    for (let i = 0; i < this.segments; i++) idx.push(0, 1 + ((i + 1) % this.segments), 1 + i)
    this.builder.appendIndices(idx)
    this.rmv = this.obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    this.rmv.mesh = this.builder.getMesh()
    this.rmv.mainMaterial = material
    this.builder.updateMesh()
    this.rmv.enabled = false
  }

  /** `uvRim` = texture radius at the rim (0.5 = the texture edge); smaller keeps more of the soft texture inside. */
  update(centre: vec3, n1: vec3, n2: vec3, radius: number, color: vec4, uvRim: number): void {
    const d = this.verts
    const write = (o: number, p: vec3, u: number, v: number) => {
      d[o] = p.x
      d[o + 1] = p.y
      d[o + 2] = p.z
      d[o + 3] = color.x
      d[o + 4] = color.y
      d[o + 5] = color.z
      d[o + 6] = color.w
      d[o + 7] = u
      d[o + 8] = v
    }
    write(0, centre, 0.5, 0.5)
    for (let i = 0; i < this.segments; i++) {
      const a = (i / this.segments) * Math.PI * 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      write((1 + i) * 9, centre.add(n1.uniformScale(c * radius)).add(n2.uniformScale(s * radius)), 0.5 + c * uvRim, 0.5 + s * uvRim)
    }
    const n = this.builder.getVerticesCount()
    if (n > 0) this.builder.eraseVertices(0, n)
    this.builder.appendVerticesInterleaved(this.verts)
    if (this.builder.isValid()) this.builder.updateMesh()
    this.rmv.enabled = true
  }

  setEnabled(v: boolean): void {
    this.rmv.enabled = v
  }
}

@component
export class MagicPowersPortalPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersPortalPower – trace a circle to open a portal</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Portal</span>')
  @ui.group_start("Portal")
  @input
  @hint("Smallest portal radius (cm)")
  @widget(new SliderWidget(5, 40, 1))
  minRadiusCm: number = 12

  @input
  @hint("Largest portal radius (cm)")
  @widget(new SliderWidget(20, 150, 1))
  maxRadiusCm: number = 60

  @input
  @hint("Portal radius = inter-palm distance × this while both open palms are near the portal")
  @widget(new SliderWidget(0.3, 3, 0.05))
  spreadGain: number = 1.2

  @input
  @hint("Both palms must be within this distance (cm) of the portal centre to resize it")
  @widget(new SliderWidget(20, 200, 5))
  engageRangeCm: number = 90

  @input
  @hint("Inter-palm distance (cm) below which the engaged hands close the portal")
  @widget(new SliderWidget(3, 30, 0.5))
  closeDistanceCm: number = 10

  @input
  @hint("Seconds the portal takes to burst open")
  @widget(new SliderWidget(0.1, 2, 0.05))
  openSec: number = 0.55

  @input
  @hint("Seconds the portal takes to collapse")
  @widget(new SliderWidget(0.1, 2, 0.05))
  closeSec: number = 0.45
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input
  @hint("Stars visible through the portal")
  @widget(new SliderWidget(10, 160, 5))
  starCount: number = 90

  @input("vec4", "{1.0, 0.82, 0.35, 1.0}")
  @hint("Rim colour (rings and runes)")
  @widget(new ColorWidget())
  colorRim: vec4

  @input("vec4", "{1.0, 0.97, 0.85, 1.0}")
  @hint("Hottest rim / star core colour")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{0.03, 0.01, 0.1, 0.92}")
  @hint("Colour of the dark space seen through the portal (alpha = opacity; black is transparent on Specs)")
  @widget(new ColorWidget())
  colorVoid: vec4

  @input("vec4", "{0.2, 0.95, 0.9, 1.0}")
  @hint("First nebula colour inside the portal")
  @widget(new ColorWidget())
  colorNebulaA: vec4

  @input("vec4", "{0.85, 0.25, 1.0, 1.0}")
  @hint("Second nebula colour inside the portal")
  @widget(new ColorWidget())
  colorNebulaB: vec4

  @input
  @hint("Volume of the otherworldly hum while the portal is open")
  @widget(new SliderWidget(0, 1, 0.05))
  humVolume: number = 0.5
  @ui.group_end

  readonly powerId = PowerId.Portal

  private state: PortalState = "closed"
  private centre: vec3 = vec3.zero()
  private normal: vec3 = new vec3(0, 0, 1)
  private n1: vec3 = vec3.right()
  private n2: vec3 = vec3.up()
  private radius = 20
  private radiusTarget = 20
  private openAmt = 0
  private rimSpin = 0
  private stars: Star[] = []
  private ripples: Ripple[] = []
  private engaged = 0
  private disc: DiscVisual | null = null
  private glows: QuadBatch | null = null
  private rings: QuadBatch | null = null
  private runes: QuadBatch | null = null
  private starBatch: QuadBatch | null = null
  private nebula: QuadBatch | null = null
  private motePool = new ParticlePool(120)
  private hum: SfxEmitter | null = null
  private humHost: SceneObject | null = null
  private time = 0
  private built = false
  private vfxRoot: SceneObject | null = null
  private fingerGlow = 0

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("PortalVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    const white = new vec4(1, 1, 1, 1)
    // Hierarchy order = draw order: the void disc first, then everything additive on top of it.
    const voidMat = cloneGlowMaterial(ctx.glowMaterial, tex.glow, white)
    voidMat.mainPass.blendMode = BlendMode.Normal
    this.disc = new DiscVisual(this.vfxRoot, "PortalVoid", voidMat)
    this.nebula = new QuadBatch(this.vfxRoot, "PortalNebula", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 16)
    this.starBatch = new QuadBatch(this.vfxRoot, "PortalStars", cloneGlowMaterial(ctx.glowMaterial, tex.star, white), 320)
    this.glows = new QuadBatch(this.vfxRoot, "PortalGlows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 24)
    this.rings = new QuadBatch(this.vfxRoot, "PortalRings", cloneGlowMaterial(ctx.glowMaterial, tex.ring, white), 12)
    this.runes = new QuadBatch(this.vfxRoot, "PortalRunes", cloneGlowMaterial(ctx.glowMaterial, tex.spark, white), 48)
    this.humHost = global.scene.createSceneObject("PortalHum")
    this.humHost.setParent(this.vfxRoot)
    this.hum = new SfxEmitter(this.humHost, MagicSfx.portalHum, this.humVolume, false)
    const n = Math.round(this.starCount)
    for (let i = 0; i < n; i++) {
      const h = (k: number) => hash1(i * 2.17 + k * 5.3 + 0.7)
      this.stars.push({
        r: Math.sqrt(Math.abs(h(1))),
        angle: h(2) * Math.PI,
        depth: Math.abs(h(3)),
        size: 0.35 + 0.65 * Math.abs(h(4)) * Math.abs(h(4)),
        speed: 0.05 + 0.2 * Math.abs(h(5)),
        phase: h(6) * Math.PI,
        hue: Math.abs(h(7)),
      })
    }
    this.built = true
  }

  protected onActivate(): void {
    this.ensureBuilt()
    if (this.vfxRoot) this.vfxRoot.enabled = true
  }

  protected onDeactivate(): void {
    this.state = "closed"
    this.openAmt = 0
    this.ripples.length = 0
    this.motePool.clear()
    if (this.hum) this.hum.stop(true)
    if (this.disc) this.disc.setEnabled(false)
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  // ── Gestures ────────────────────────────────────────────────────────────────

  onGesture(e: GestureEvent): void {
    if (!this.built) return
    switch (e.type) {
      case GestureType.CircleTrace:
        if (this.state !== "open") this.open(e.position, e.direction, e.strength)
        break
      case GestureType.HandsSpread:
        if (this.state === "open" && this.engaged > 0.5) this.ripples.push({ age: 0, outward: true })
        break
      case GestureType.HandsTogether:
        if (this.state === "open" && this.engaged > 0.5) this.close()
        break
      default:
        break
    }
  }

  private open(at: vec3, normal: vec3, traceRadius: number): void {
    const ctx = this.ctx!
    let n = normal
    if (n.length < 1e-3) n = ctx.camera.back.uniformScale(-1)
    n = n.normalize()
    this.centre = at
    this.normal = n
    const basis = perpendicularBasis(n)
    this.n1 = basis.n1
    this.n2 = basis.n2
    this.radius = 1
    this.radiusTarget = Math.max(this.minRadiusCm, Math.min(this.maxRadiusCm, traceRadius * 1.4))
    this.openAmt = 0
    this.state = "open"
    this.ripples.length = 0
    this.ripples.push({ age: 0, outward: true })
    playOneShotAt(ctx.effectsRoot, MagicSfx.portalOpen, at, 0.9)
    if (this.humHost) this.humHost.getTransform().setWorldPosition(at)
    if (this.hum) this.hum.playIfSilent(-1)
    for (let i = 0; i < 30; i++) this.spawnMote(at, 1.3, randomUnitVector().uniformScale(randRange(40, 120)), true)
  }

  private close(): void {
    if (this.state !== "open") return
    this.state = "closing"
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.portalClose, this.centre, 0.9)
    for (let i = 0; i < 24; i++) this.spawnMote(this.centre.add(this.n1.uniformScale(randRange(-1, 1) * this.radius)).add(this.n2.uniformScale(randRange(-1, 1) * this.radius)), 1, vec3.zero(), false)
  }

  private spawnMote(at: vec3, scale: number, vel: vec3, rim: boolean): void {
    this.motePool.spawn({
      pos: at,
      vel,
      life: randRange(0.5, 1.2),
      size: randRange(0.5, 1.2) * scale,
      sizeEnd: 0.1,
      color: rim ? (Math.random() < 0.5 ? this.colorRim : this.colorCore) : Math.random() < 0.5 ? this.colorNebulaA : this.colorNebulaB,
      drag: 1.5,
      turbulence: 20,
      spin: randRange(-8, 8),
    })
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)

    this.nebula!.begin()
    this.starBatch!.begin()
    this.glows!.begin()
    this.rings!.begin()
    this.runes!.begin()

    // Pointing feedback: a glowing trail tip on a pointing index finger so the circle trace reads.
    const pointing = (left.pointing && left.confidence > 0.3) || (right.pointing && right.confidence > 0.3)
    this.fingerGlow = approach(this.fingerGlow, pointing ? 1 : 0, 8, dt)
    if (this.fingerGlow > 0.02) {
      for (const pose of [left, right]) {
        if (!pose.pointing || pose.confidence <= 0.3) continue
        const g = this.fingerGlow * pose.confidence
        this.glows!.quad(pose.indexTip, cam.right, cam.up, 2.2 * g, 2.2 * g, tint(this.colorRim, 1, 0.7 * g))
        this.runes!.quadRotated(pose.indexTip, cam.right, cam.up, 0.9 * g, 0.9 * g, tint(this.colorCore, 1, 0.9 * g), this.time * 4)
        if (Math.random() < 30 * dt) this.spawnMote(pose.indexTip, 0.8, randomUnitVector().uniformScale(8), true)
      }
    }

    // State: open / close animation and the hand-spread size control
    if (this.state === "open") {
      this.openAmt = Math.min(1, this.openAmt + dt / this.openSec)
      const bothOpen = left.isOpen && right.isOpen && left.confidence > 0.3 && right.confidence > 0.3 && !left.isPalmUp && !right.isPalmUp
      const near = bothOpen && left.palmCenter.distance(this.centre) < this.engageRangeCm && right.palmCenter.distance(this.centre) < this.engageRangeCm
      this.engaged = approach(this.engaged, near ? 1 : 0, 8, dt)
      if (near) {
        if (two.distance < this.closeDistanceCm) this.close()
        else this.radiusTarget = Math.max(this.minRadiusCm, Math.min(this.maxRadiusCm, two.distance * this.spreadGain))
      }
    } else if (this.state === "closing") {
      this.openAmt = Math.max(0, this.openAmt - dt / this.closeSec)
      this.engaged = approach(this.engaged, 0, 8, dt)
      if (this.openAmt <= 0) {
        this.state = "closed"
        if (this.hum) this.hum.stop(true)
      }
    }
    this.radius = approach(this.radius, this.radiusTarget, 6, dt)
    this.rimSpin += dt * (0.6 + 1.5 * (1 - this.openAmt))

    if (this.openAmt > 0.001) this.drawPortal(dt, cam)
    else if (this.disc) this.disc.setEnabled(false)

    if (this.hum) {
      this.hum.setLevel(this.openAmt * (0.7 + 0.3 * smoothstep(this.minRadiusCm, this.maxRadiusCm, this.radius)))
      this.hum.update(dt)
    }

    this.motePool.update(dt, this.time)
    this.motePool.draw(this.starBatch!, cam.right, cam.up, 1)

    this.nebula!.end()
    this.starBatch!.end()
    this.glows!.end()
    this.rings!.end()
    this.runes!.end()
  }

  private drawPortal(dt: number, cam: CamBasis): void {
    const a = smoothstep(0, 1, this.openAmt)
    // the opening overshoots slightly then settles (a burst), the closing shrinks to a point
    const burst = this.state === "open" ? 1 + 0.12 * Math.sin(a * Math.PI) : 1
    const R = this.radius * a * burst
    if (R < 0.5) {
      if (this.disc) this.disc.setEnabled(false)
      return
    }
    const c = this.centre
    const n = this.normal
    const n1 = this.n1
    const n2 = this.n2
    const facing = clamp01(n.dot(cam.pos.sub(c).normalize()) * 1.4) // interior fades when seen edge-on

    // ── Other world: dark void disc with a soft rim
    this.disc!.update(c.sub(n.uniformScale(0.3)), n1, n2, R * 0.98, tint(this.colorVoid, 1, this.colorVoid.w * a * facing), 0.47)

    // nebula clouds swirling in a shallow well behind the plane
    const clouds = 5
    for (let i = 0; i < clouds; i++) {
      const ang = this.time * (0.25 + 0.08 * i) * (i % 2 === 0 ? 1 : -1) + i * 1.9
      const depth = 0.25 + 0.12 * i
      const rr = R * (0.15 + 0.25 * (i % 3)) * (1 - 0.35 * depth)
      const p = c.sub(n.uniformScale(depth * R * 0.5)).add(n1.uniformScale(Math.cos(ang) * rr)).add(n2.uniformScale(Math.sin(ang) * rr))
      const size = R * (0.28 + 0.12 * (i % 2)) * (1 - 0.3 * depth)
      const col = i % 2 === 0 ? this.colorNebulaA : this.colorNebulaB
      const breathe = 0.8 + 0.2 * Math.sin(this.time * 0.9 + i)
      this.nebula!.quad(p, n1, n2, size, size, tint(col, 1, 0.28 * a * facing * breathe))
    }
    // a bright core deep in the well
    this.nebula!.quad(c.sub(n.uniformScale(R * 0.45)), n1, n2, R * 0.22, R * 0.22, tint(this.colorCore, 1, 0.35 * a * facing))

    // star field with parallax (deeper stars sit further behind the plane and are kept inside the rim)
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i]
      s.angle += s.speed * dt * (0.4 + 0.6 * (1 - s.depth))
      const depthCm = s.depth * R * 0.5
      const rr = s.r * R * (0.92 - 0.4 * s.depth)
      const p = c.sub(n.uniformScale(depthCm)).add(n1.uniformScale(Math.cos(s.angle) * rr)).add(n2.uniformScale(Math.sin(s.angle) * rr))
      const twinkle = 0.55 + 0.45 * Math.sin(this.time * (2 + s.speed * 10) + s.phase)
      const size = s.size * R * 0.035 * (1 - 0.4 * s.depth) * twinkle
      const col = s.hue < 0.5 ? vec4.lerp(this.colorCore, this.colorNebulaA, s.hue * 1.2) : vec4.lerp(this.colorCore, this.colorNebulaB, (s.hue - 0.5) * 1.2)
      this.starBatch!.quadRotated(p, cam.right, cam.up, size, size, tint(col, 1, 0.9 * a * facing), s.phase)
    }
    // motes spiral into the centre
    if (Math.random() < 20 * a * dt) {
      const ang = randRange(0, Math.PI * 2)
      const start = c.add(n1.uniformScale(Math.cos(ang) * R * 0.9)).add(n2.uniformScale(Math.sin(ang) * R * 0.9))
      const inward = c.sub(start).normalize()
      const tangent = n.cross(inward)
      this.spawnMote(start, 0.9, inward.uniformScale(R * 0.9).add(tangent.uniformScale(R * 0.6)), false)
    }

    // ── Rim: layered rings, runes, rim sparks and an outer glow
    const pulse = 1 + 0.02 * Math.sin(this.time * 5)
    this.rings!.quad(c, n1, n2, R * 1.06 * pulse, R * 1.06 * pulse, tint(this.colorRim, 1, 0.95 * a))
    this.rings!.quad(c.add(n.uniformScale(0.4)), n1, n2, R * 1.0, R * 1.0, tint(this.colorCore, 1, 0.6 * a))
    const rot1 = this.rimSpin
    const rot2 = -this.rimSpin * 0.7
    this.rings!.quad(c.add(n.uniformScale(0.8)), n1.uniformScale(Math.cos(rot1)).add(n2.uniformScale(Math.sin(rot1))), n2.uniformScale(Math.cos(rot1)).sub(n1.uniformScale(Math.sin(rot1))), R * 1.16, R * 1.16, tint(this.colorRim, 1, 0.35 * a))
    this.glows!.quad(c, n1, n2, R * 1.5, R * 1.5, tint(this.colorRim, 1, 0.22 * a))
    this.glows!.quad(c, cam.right, cam.up, R * 0.6, R * 0.6, tint(this.colorNebulaB, 1, 0.12 * a * facing))
    // runes: sparks riding the rim in two counter-rotating bands
    const runeCount = 18
    for (let i = 0; i < runeCount; i++) {
      const band = i % 2
      const ang = (band === 0 ? rot1 : rot2) + (i / runeCount) * Math.PI * 2
      const rr = R * (band === 0 ? 1.1 : 1.0)
      const p = c.add(n1.uniformScale(Math.cos(ang) * rr)).add(n2.uniformScale(Math.sin(ang) * rr)).add(n.uniformScale(1))
      const flick = 0.7 + 0.3 * flickerNoise(i, 3, this.time, 8)
      const sz = R * 0.045 * (band === 0 ? 1.3 : 0.9) * flick
      this.runes!.quadRotated(p, cam.right, cam.up, sz, sz * 1.8, tint(band === 0 ? this.colorRim : this.colorCore, 1, 0.9 * a), ang + Math.PI / 2)
    }
    // rim sparks fly off while the portal is being resized
    if (this.engaged > 0.3 && Math.random() < 25 * this.engaged * dt) {
      const ang = randRange(0, Math.PI * 2)
      const dir = n1.uniformScale(Math.cos(ang)).add(n2.uniformScale(Math.sin(ang)))
      this.spawnMote(c.add(dir.uniformScale(R)), 1, dir.uniformScale(40), true)
    }

    // ripples (open burst / spread kick)
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i]
      rp.age += dt
      const t = rp.age / 0.7
      if (t >= 1) {
        this.ripples.splice(i, 1)
        continue
      }
      const rr = R * (rp.outward ? 1 + t * 0.9 : 1.9 - t * 0.9)
      const fade = (1 - t) * (1 - t)
      this.rings!.quad(c.add(n.uniformScale(1.2)), n1, n2, rr, rr, tint(this.colorCore, 1, 0.8 * fade * a))
    }
  }
}
