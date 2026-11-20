/**
 * MagicPowersTelekinesisPower — Telekinesis: levitate, move, spin, attract and fling floating objects.
 *
 * Owns: a small set of procedural "magical objects" (MeshBuilder crystals + glowing orbs) that live in
 *       the room, per-hand targeting (palm ray cone + dwell), the hold model (object follows the palm,
 *       wrist rotation spins it, pulling the hand towards the body reels it in), fling / force-push
 *       physics (manual integration, WorldQuery bounces with an editor floor fallback) and the
 *       telekinetic aura / tether VFX + SFX.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager.
 * Must not: read SIK directly or decide which power is active.
 *
 * Gesture map:  open palm aimed at an object (≈0.35 s) → it levitates (glow + lift) and follows the palm
 *               move the hand → the object repositions · rotate the wrist → it spins
 *               pull the hand towards the body → the object is drawn in (push it out → it drifts away)
 *               palm push while holding → flung with physics · push at an un-held object → force shove
 *               fist / palm up / tracking lost → the object is dropped
 */

import { GestureEvent, GestureType, HandPose, HandSide, MagicPower, PowerId, TwoHandState } from "./MagicPowersTypes"
import {
  ParticlePool,
  QuadBatch,
  SphereVisual,
  SurfaceProbe,
  approach,
  approachVec,
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
type ObjState = "idle" | "held" | "flying"

interface TkObject {
  kind: "crystal" | "orb"
  index: number
  pos: vec3
  vel: vec3
  rot: quat
  /** angular velocity: axis * rad/s */
  angVel: vec3
  state: ObjState
  heldBy: HandSide | null
  holdDist: number
  /** smoothed 0..1 aura (targeting + hold) */
  glow: number
  /** smoothed 0..1 lift while held */
  lift: number
  restPos: vec3
  home: vec3
  radius: number
  color: vec4
  host: SceneObject
  sphere: SphereVisual | null
  probing: boolean
  settledFor: number
  seed: number
}

interface HandTk {
  side: HandSide
  held: TkObject | null
  target: TkObject | null
  aimTime: number
  prevPalm: vec3 | null
  prevFingerDir: vec3 | null
  spinVel: number
}

@component
export class MagicPowersTelekinesisPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersTelekinesisPower – levitate, move, spin, attract and fling objects</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Objects</span>')
  @ui.group_start("Objects")
  @input
  @hint("Floating magical objects spawned in front of the user (crystals and orbs alternate)")
  @widget(new SliderWidget(1, 8, 1))
  objectCount: number = 5

  @input
  @hint("Nearest spawn distance (cm) in front of the user")
  @widget(new SliderWidget(60, 300, 5))
  spawnDistMinCm: number = 100

  @input
  @hint("Farthest spawn distance (cm) in front of the user")
  @widget(new SliderWidget(60, 400, 5))
  spawnDistMaxCm: number = 160

  @input
  @hint("Horizontal spread of the spawn arc (degrees, half-angle)")
  @widget(new SliderWidget(10, 80, 1))
  spawnArcDeg: number = 45

  @input
  @hint("Object radius (cm)")
  @widget(new SliderWidget(2, 10, 0.5))
  objectRadiusCm: number = 4.5
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Control</span>')
  @ui.group_start("Control")
  @input
  @hint("Half-angle (degrees) of the palm cone that can target an object")
  @widget(new SliderWidget(8, 45, 1))
  aimConeDeg: number = 28

  @input
  @hint("Seconds the palm must stay aimed at an object before it levitates")
  @widget(new SliderWidget(0.05, 1.5, 0.05))
  grabDwellSec: number = 0.35

  @input
  @hint("Farthest object (cm) a palm can reach")
  @widget(new SliderWidget(50, 600, 10))
  reachCm: number = 350

  @input
  @hint("How strongly the hand's motion towards/away from the body reels the object in/out (× hand displacement)")
  @widget(new SliderWidget(0, 8, 0.25))
  pullGain: number = 3

  @input
  @hint("How much wrist rotation spins the held object (× wrist angular speed)")
  @widget(new SliderWidget(0, 6, 0.25))
  spinGain: number = 2.5

  @input
  @hint("Object speed (cm/s) at the slowest push that flings it")
  @widget(new SliderWidget(100, 800, 10))
  flingSpeedMin: number = 260

  @input
  @hint("Object speed (cm/s) at a fast push")
  @widget(new SliderWidget(200, 1500, 10))
  flingSpeedMax: number = 820

  @input
  @hint("Downward acceleration on flung objects (cm/s²); 981 = real gravity, lower feels magical")
  @widget(new SliderWidget(0, 1200, 10))
  gravity: number = 620

  @input
  @hint("Bounciness on surface hits (0 = thud, 1 = perfectly elastic)")
  @widget(new SliderWidget(0, 1, 0.05))
  restitution: number = 0.42
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input("vec4", "{0.75, 0.95, 1.0, 1.0}")
  @hint("Crystal tip / aura core colour")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{0.35, 1.0, 0.65, 1.0}")
  @hint("Telekinetic aura colour (tether, hold ring)")
  @widget(new ColorWidget())
  colorAura: vec4

  @input("vec4", "{0.55, 0.35, 1.0, 1.0}")
  @hint("Crystal body colour")
  @widget(new ColorWidget())
  colorCrystal: vec4

  @input("vec4", "{1.0, 0.75, 0.35, 1.0}")
  @hint("Orb colour")
  @widget(new ColorWidget())
  colorOrb: vec4

  @input
  @hint("Volume of the telekinetic hum while an object is held")
  @widget(new SliderWidget(0, 1, 0.05))
  humVolume: number = 0.5
  @ui.group_end

  readonly powerId = PowerId.Telekinesis

  private objects: TkObject[] = []
  private hands: Record<HandSide, HandTk> | null = null
  private glows: QuadBatch | null = null
  private rings: QuadBatch | null = null
  private stars: QuadBatch | null = null
  private motePool = new ParticlePool(140)
  private probe: SurfaceProbe | null = null
  private hum: SfxEmitter | null = null
  private humHost: SceneObject | null = null
  private crystalMesh: RenderMesh | null = null
  private time = 0
  private built = false
  private vfxRoot: SceneObject | null = null
  private palmGlow: Record<HandSide, number> = { left: 0, right: 0 }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("TelekinesisVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    const white = new vec4(1, 1, 1, 1)
    this.glows = new QuadBatch(this.vfxRoot, "TkGlows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 48)
    this.rings = new QuadBatch(this.vfxRoot, "TkRings", cloneGlowMaterial(ctx.glowMaterial, tex.ring, white), 24)
    this.stars = new QuadBatch(this.vfxRoot, "TkStars", cloneGlowMaterial(ctx.glowMaterial, tex.star, white), 200)
    this.crystalMesh = this.buildCrystalMesh()
    this.humHost = global.scene.createSceneObject("TkHum")
    this.humHost.setParent(this.vfxRoot)
    this.hum = new SfxEmitter(this.humHost, MagicSfx.teleHum, this.humVolume, false)
    this.probe = new SurfaceProbe()
    this.hands = { left: this.makeHand("left"), right: this.makeHand("right") }
    this.spawnObjects()
    this.built = true
  }

  private makeHand(side: HandSide): HandTk {
    return { side, held: null, target: null, aimTime: 0, prevPalm: null, prevFingerDir: null, spinVel: 0 }
  }

  /** Six-sided bipyramid crystal (long axis = +Y) with bright tips and a deeper body, as vertex colours. */
  private buildCrystalMesh(): RenderMesh {
    const builder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "color", components: 4 },
      { name: "texture0", components: 2 },
    ])
    builder.topology = MeshTopology.Triangles
    builder.indexType = MeshIndexType.UInt16
    const verts: number[] = []
    const idx: number[] = []
    const tipC = this.colorCore
    const bodyC = this.colorCrystal
    const push = (p: vec3, c: vec4, bright: number) => {
      verts.push(p.x, p.y, p.z, c.x * bright, c.y * bright, c.z * bright, 1, 0.5, 0.5)
    }
    const sides = 6
    const ringY = 0.15
    const ringR = 0.42
    // Flat-shaded facets: each triangle gets its own three vertices so the facet edges read.
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2
      const a1 = ((i + 1) / sides) * Math.PI * 2
      const r0 = new vec3(Math.cos(a0) * ringR, ringY, Math.sin(a0) * ringR)
      const r1 = new vec3(Math.cos(a1) * ringR, ringY, Math.sin(a1) * ringR)
      const facet = 0.7 + 0.3 * Math.abs(Math.sin(a0 * 1.5 + 0.4))
      const b = verts.length / 9
      push(new vec3(0, 1, 0), tipC, 1.0)
      push(r1, bodyC, facet)
      push(r0, bodyC, facet)
      idx.push(b, b + 1, b + 2)
      const b2 = verts.length / 9
      push(new vec3(0, -0.75, 0), tipC, 0.85)
      push(r0, bodyC, facet * 0.8)
      push(r1, bodyC, facet * 0.8)
      idx.push(b2, b2 + 1, b2 + 2)
    }
    builder.appendVerticesInterleaved(verts)
    builder.appendIndices(idx)
    builder.updateMesh()
    return builder.getMesh()
  }

  private spawnObjects(): void {
    const ctx = this.ctx!
    const cam = cameraBasis(ctx.camera)
    // Spawn relative to the horizontal gaze so objects sit in the room, not on the ceiling.
    let fwd = new vec3(cam.look.x, 0, cam.look.z)
    if (fwd.length < 1e-3) fwd = new vec3(0, 0, -1)
    fwd = fwd.normalize()
    const right = fwd.cross(vec3.up()).normalize()
    const n = Math.max(1, Math.round(this.objectCount))
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1) - 0.5
      const ang = ((t * 2 * this.spawnArcDeg) * Math.PI) / 180
      const dist = lerp(this.spawnDistMinCm, this.spawnDistMaxCm, 0.5 + 0.5 * hash1(i * 3.3 + 1))
      const height = -22 + 18 * hash1(i * 7.1 + 2)
      const home = cam.pos.add(fwd.uniformScale(Math.cos(ang) * dist)).add(right.uniformScale(Math.sin(ang) * dist)).add(vec3.up().uniformScale(height))
      const kind: "crystal" | "orb" = i % 2 === 0 ? "crystal" : "orb"
      const host = global.scene.createSceneObject(`TkObject_${i}`)
      host.setParent(this.vfxRoot!)
      host.getTransform().setWorldPosition(home)
      let sphere: SphereVisual | null = null
      const color = kind === "crystal" ? this.colorCrystal : this.colorOrb
      if (kind === "crystal") {
        const rmv = host.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
        rmv.mesh = this.crystalMesh!
        rmv.mainMaterial = cloneGlowMaterial(ctx.glowMaterial, ctx.textures.glow, new vec4(1, 1, 1, 1))
        const s = this.objectRadiusCm * 1.6
        host.getTransform().setWorldScale(new vec3(s, s, s))
      } else {
        sphere = new SphereVisual(host, "Orb", ctx, color)
        sphere.setRadius(this.objectRadiusCm * 0.7)
        sphere.setPosition(home)
        sphere.setColor(tint(color, 1, 0.9))
      }
      this.objects.push({
        kind,
        index: i,
        pos: home,
        vel: vec3.zero(),
        rot: quat.angleAxis(hash1(i) * Math.PI, vec3.up()),
        angVel: vec3.up().uniformScale(0.5),
        state: "idle",
        heldBy: null,
        holdDist: 0,
        glow: 0,
        lift: 0,
        restPos: home,
        home,
        radius: this.objectRadiusCm,
        color,
        host,
        sphere,
        probing: false,
        settledFor: 0,
        seed: i * 13.7,
      })
    }
  }

  protected onActivate(): void {
    this.ensureBuilt()
    if (this.vfxRoot) this.vfxRoot.enabled = true
  }

  protected onDeactivate(): void {
    if (!this.hands) return
    for (const side of ["left", "right"] as HandSide[]) {
      const h = this.hands[side]
      if (h.held) this.drop(h, h.held, vec3.zero())
      h.target = null
      h.aimTime = 0
    }
    if (this.hum) this.hum.stop(true)
    this.motePool.clear()
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  // ── Gestures ────────────────────────────────────────────────────────────────

  onGesture(e: GestureEvent): void {
    if (!this.hands || e.hand === "both") return
    const h = this.hands[e.hand]
    switch (e.type) {
      case GestureType.Push:
        if (h.held) this.fling(h, h.held, e.direction, e.strength)
        else this.forcePush(h, e.position, e.direction, e.strength)
        break
      case GestureType.Fist:
        if (h.held) this.drop(h, h.held, vec3.zero())
        h.target = null
        h.aimTime = 0
        break
      case GestureType.PalmUp:
      case GestureType.TrackingLost:
        if (h.held) this.drop(h, h.held, vec3.zero())
        h.target = null
        h.aimTime = 0
        break
      default:
        break
    }
  }

  private grab(h: HandTk, o: TkObject, palm: vec3): void {
    o.state = "held"
    o.heldBy = h.side
    o.holdDist = Math.max(20, o.pos.distance(palm))
    o.vel = vec3.zero()
    h.held = o
    h.target = null
    h.aimTime = 0
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.teleGrab, o.pos, 0.8)
    for (let i = 0; i < 14; i++) this.spawnMote(o.pos.add(randomUnitVector().uniformScale(o.radius)), 1.2, randomUnitVector().uniformScale(25))
    if (this.hum) this.hum.playIfSilent(-1)
  }

  private drop(h: HandTk, o: TkObject, vel: vec3): void {
    o.state = "flying"
    o.heldBy = null
    o.vel = vel
    o.settledFor = 0
    h.held = null
  }

  private fling(h: HandTk, o: TkObject, dir: vec3, strength: number): void {
    const ctx = this.ctx!
    const look = ctx.camera.back
    let d = dir.uniformScale(0.65).add(look.uniformScale(0.35))
    if (d.length < 1e-3) d = look
    d = d.normalize()
    const k = clamp01((strength - 100) / 250)
    const speed = lerp(this.flingSpeedMin, this.flingSpeedMax, k)
    this.drop(h, o, d.uniformScale(speed))
    o.angVel = randomUnitVector().uniformScale(randRange(4, 10))
    playOneShotAt(ctx.effectsRoot, MagicSfx.teleThrow, o.pos, 0.9)
    for (let i = 0; i < 18; i++) this.spawnMote(o.pos, 1.4, d.uniformScale(-60).add(randomUnitVector().uniformScale(30)))
  }

  /** A push with an empty hand shoves the nearest object inside the push cone. */
  private forcePush(h: HandTk, from: vec3, dir: vec3, strength: number): void {
    const o = this.pickTarget(from, dir, 35)
    if (!o || o.state === "held") return
    const look = this.ctx!.camera.back
    let d = dir.uniformScale(0.65).add(look.uniformScale(0.35))
    if (d.length < 1e-3) d = look
    d = d.normalize()
    const dist = o.pos.distance(from)
    const falloff = clamp01(1 - dist / this.reachCm) * 0.6 + 0.4
    const speed = lerp(this.flingSpeedMin, this.flingSpeedMax, clamp01((strength - 100) / 250)) * 0.8 * falloff
    o.state = "flying"
    o.heldBy = null
    o.vel = d.uniformScale(speed).add(vec3.up().uniformScale(speed * 0.12))
    o.angVel = randomUnitVector().uniformScale(randRange(3, 8))
    o.settledFor = 0
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.teleThrow, o.pos, 0.8)
    // shockwave motes travel from the palm to the object
    for (let i = 0; i < 16; i++) {
      const t = i / 16
      this.spawnMote(vec3.lerp(from, o.pos, t), 1.1, d.uniformScale(80))
    }
  }

  private pickTarget(from: vec3, dir: vec3, coneDeg: number): TkObject | null {
    const cosCone = Math.cos((coneDeg * Math.PI) / 180)
    let best: TkObject | null = null
    let bestScore = -1
    for (const o of this.objects) {
      if (o.state === "held") continue
      const v = o.pos.sub(from)
      const dist = v.length
      if (dist < 12 || dist > this.reachCm) continue
      const cosA = v.dot(dir) / dist
      // allow a little slack for nearby objects (bigger apparent size)
      const slack = clamp01(o.radius * 3 / dist)
      if (cosA < cosCone - slack * 0.1) continue
      const score = cosA - dist / (this.reachCm * 4)
      if (score > bestScore) {
        bestScore = score
        best = o
      }
    }
    return best
  }

  private spawnMote(at: vec3, scale: number, vel: vec3 = vec3.zero()): void {
    this.motePool.spawn({
      pos: at,
      vel,
      life: randRange(0.4, 0.9),
      size: randRange(0.6, 1.3) * scale,
      sizeEnd: 0.1,
      color: Math.random() < 0.4 ? this.colorCore : this.colorAura,
      drag: 2,
      turbulence: 25,
      spin: randRange(-8, 8),
    })
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx || !this.hands) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    const poses: Record<HandSide, HandPose> = { left, right }

    this.glows!.begin()
    this.rings!.begin()
    this.stars!.begin()

    for (const side of ["left", "right"] as HandSide[]) this.updateHand(this.hands[side], poses[side], dt, cam)
    for (const o of this.objects) this.updateObject(o, dt, cam)

    // Hum follows the (first) held object
    const held = this.hands.left.held ?? this.hands.right.held
    if (this.hum) {
      if (held && this.humHost) this.humHost.getTransform().setWorldPosition(held.pos)
      this.hum.setLevel(held ? 1 : 0)
      this.hum.update(dt)
      if (!held && this.hum.isPlaying) this.hum.stop(true)
    }

    this.motePool.update(dt, this.time)
    this.motePool.draw(this.stars!, cam.right, cam.up, 1)

    this.glows!.end()
    this.rings!.end()
    this.stars!.end()
  }

  private updateHand(h: HandTk, pose: HandPose, dt: number, cam: CamBasis): void {
    const conf = pose.confidence
    const live = pose.tracked && conf > 0.3
    const aiming = live && pose.isOpen && !pose.isPalmUp && !pose.isFist
    this.palmGlow[h.side] = approach(this.palmGlow[h.side], aiming ? conf : 0, 8, dt)
    const pg = this.palmGlow[h.side]
    if (pg > 0.02) {
      const p = pose.palmCenter.add(pose.palmNormal.uniformScale(1.5))
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 4 + (h.side === "left" ? 0 : 1.7))
      this.glows!.quad(p, cam.right, cam.up, 4.5 * pg * pulse, 4.5 * pg * pulse, tint(this.colorAura, 1, 0.45 * pg))
    }

    if (h.held) {
      const o = h.held
      if (!aiming) {
        this.drop(h, o, pose.velocity.uniformScale(0.5))
      } else {
        // Reel in / out: hand displacement along the body→palm axis changes the hold distance.
        const toward = pose.palmCenter.sub(cam.pos).normalize()
        if (h.prevPalm) {
          const dPull = pose.palmCenter.sub(h.prevPalm).dot(toward)
          o.holdDist = Math.max(18, Math.min(this.reachCm, o.holdDist + dPull * this.pullGain))
        }
        // Wrist rotation about the palm normal spins the object.
        if (h.prevFingerDir && dt > 0) {
          const n = pose.palmNormal
          const a = h.prevFingerDir.sub(n.uniformScale(h.prevFingerDir.dot(n)))
          const b = pose.fingerDir.sub(n.uniformScale(pose.fingerDir.dot(n)))
          if (a.length > 1e-3 && b.length > 1e-3) {
            const ang = Math.atan2(a.cross(b).dot(n), a.dot(b))
            h.spinVel = approach(h.spinVel, (ang / dt) * this.spinGain, 6, dt)
          }
        }
        const target = pose.palmCenter.add(pose.palmNormal.uniformScale(o.holdDist))
        o.pos = approachVec(o.pos, target, 9, dt)
        o.vel = vec3.zero()
        o.angVel = pose.palmNormal.uniformScale(h.spinVel).add(vec3.up().uniformScale(0.8))
        this.drawTether(pose, o, conf, cam)
      }
    } else if (aiming) {
      const t = this.pickTarget(pose.palmCenter, pose.palmNormal, this.aimConeDeg)
      if (t && t === h.target) {
        h.aimTime += dt
        if (h.aimTime >= this.grabDwellSec) this.grab(h, t, pose.palmCenter)
      } else {
        h.target = t
        h.aimTime = 0
      }
      if (h.target && h.target.state !== "held") {
        // targeting feedback: faint tether + rising aura on the candidate
        const a = clamp01(h.aimTime / this.grabDwellSec) * conf
        this.drawTether(pose, h.target, 0.35 + 0.4 * a, cam)
      }
    } else {
      h.target = null
      h.aimTime = 0
    }
    h.prevPalm = live ? pose.palmCenter : null
    h.prevFingerDir = live ? pose.fingerDir : null
    if (!h.held) h.spinVel = approach(h.spinVel, 0, 4, dt)
  }

  private drawTether(pose: HandPose, o: TkObject, amt: number, cam: CamBasis): void {
    const from = pose.palmCenter.add(pose.palmNormal.uniformScale(2))
    const to = o.pos
    const d = to.sub(from)
    const len = d.length
    if (len < 1e-3) return
    const dir = d.uniformScale(1 / len)
    const basis = perpendicularBasis(dir)
    const dots = Math.min(24, Math.max(6, Math.floor(len / 6)))
    for (let i = 0; i < dots; i++) {
      const t = (i + ((this.time * 1.4) % 1)) / dots
      if (t > 1) continue
      const wob = Math.sin(t * 9 + this.time * 5 + o.seed) * 1.2 * (1 - t)
      const p = from.add(dir.uniformScale(t * len)).add(basis.n1.uniformScale(wob)).add(basis.n2.uniformScale(Math.cos(t * 7 + this.time * 4) * 1.2 * (1 - t)))
      const s = (0.6 + 0.5 * (1 - Math.abs(t - 0.5) * 2)) * amt
      this.stars!.quadRotated(p, cam.right, cam.up, s, s, tint(this.colorAura, 1, 0.75 * amt), this.time * 2 + i)
    }
    this.glows!.quad(from, cam.right, cam.up, 5 * amt, 5 * amt, tint(this.colorAura, 1, 0.4 * amt))
  }

  private updateObject(o: TkObject, dt: number, cam: CamBasis): void {
    const held = o.state === "held"
    const targeted = !held && (this.hands!.left.target === o || this.hands!.right.target === o)
    const wantGlow = held ? 1 : targeted ? 0.45 : 0
    o.glow = approach(o.glow, wantGlow, 6, dt)
    o.lift = approach(o.lift, held ? 1 : 0, 5, dt)

    if (o.state === "flying") {
      const prev = o.pos
      o.vel = new vec3(o.vel.x, o.vel.y - this.gravity * dt, o.vel.z)
      o.pos = o.pos.add(o.vel.uniformScale(dt))
      // Surface collision: WorldQuery when available, otherwise an editor floor plane 140 cm below the eyes.
      const floorY = cam.pos.y - 140
      if (this.probe && this.probe.isAvailable) {
        if (!o.probing && o.vel.length > 1) {
          o.probing = true
          const dir = o.vel.normalize()
          const ahead = o.pos.add(dir.uniformScale(o.radius + o.vel.length * dt * 2))
          this.probe.probe(prev, ahead, (hit) => {
            o.probing = false
            if (hit && o.state === "flying") this.bounce(o, hit.position.add(hit.normal.uniformScale(o.radius)), hit.normal)
          })
        }
        if (o.pos.y < floorY - 260) this.rehome(o)
      } else if (o.pos.y - o.radius < floorY) {
        this.bounce(o, new vec3(o.pos.x, floorY + o.radius, o.pos.z), vec3.up())
      }
      if (o.pos.distance(cam.pos) > 900) this.rehome(o)
      if (o.state === "flying" && o.vel.length < 25) {
        o.settledFor += dt
        if (o.settledFor > 0.4) {
          o.state = "idle"
          o.restPos = o.pos
          o.angVel = vec3.up().uniformScale(0.5)
        }
      } else o.settledFor = 0
    } else if (o.state === "idle") {
      const bob = Math.sin(this.time * 1.1 + o.seed) * 1.5
      const well = this.ctx!.world.nearest(PowerId.Telekinesis, o.pos, 280)
      if (well) {
        // a gravity well cast into the room gathers the objects into a slow orbit above it
        const basis = perpendicularBasis(well.normal)
        const a = this.time * 0.6 + o.seed
        const ring = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a))).uniformScale(well.radius * 0.7)
        o.pos = approachVec(o.pos, well.position.add(well.normal.uniformScale(42 + bob * 4)).add(ring), 1.6, dt)
        o.restPos = o.pos
      } else {
        // gentle hover around the rest position
        o.pos = approachVec(o.pos, o.restPos.add(vec3.up().uniformScale(bob)), 3, dt)
      }
    }

    // Rotation integration
    const w = o.angVel.length
    if (w > 1e-4) o.rot = quat.angleAxis(w * dt, o.angVel.uniformScale(1 / w)).multiply(o.rot)
    if (o.state === "flying") o.angVel = o.angVel.uniformScale(Math.max(0, 1 - 0.4 * dt))

    const visualPos = o.pos.add(vec3.up().uniformScale(o.lift * 6))
    const tr = o.host.getTransform()
    tr.setWorldPosition(visualPos)
    tr.setWorldRotation(o.rot)
    if (o.sphere) {
      o.sphere.setPosition(visualPos)
      o.sphere.setRadius(o.radius * 0.7 * (1 + 0.15 * o.glow * Math.sin(this.time * 6)))
      o.sphere.setColor(tint(vec4.lerp(o.color, this.colorCore, 0.35 * o.glow), 1 + 0.5 * o.glow, 0.9))
    } else {
      const s = o.radius * 1.6 * (1 + 0.08 * o.glow)
      tr.setWorldScale(new vec3(s, s, s))
    }

    // Base glow so objects are visible in the room; aura grows while targeted / held.
    const g = 0.3 + 0.7 * o.glow
    this.glows!.quad(visualPos, cam.right, cam.up, o.radius * 2.6 * g, o.radius * 2.6 * g, tint(o.color, 1, 0.45 * g))
    if (o.glow > 0.03) {
      const r = o.radius * (1.6 + 0.3 * Math.sin(this.time * 5 + o.seed)) * (0.6 + 0.4 * o.glow)
      this.rings!.quad(visualPos, cam.right, cam.up, r, r, tint(this.colorAura, 1, 0.8 * o.glow))
      this.glows!.quad(visualPos, cam.right, cam.up, o.radius * 3.5 * o.glow, o.radius * 3.5 * o.glow, tint(this.colorAura, 1, 0.3 * o.glow))
      // orbiting sparks
      const n = Math.floor(4 + 8 * o.glow)
      for (let i = 0; i < n; i++) {
        const a = this.time * 3 + i * 2.399 + o.seed
        const rr = o.radius * 1.9 + Math.sin(this.time * 2 + i) * o.radius * 0.4
        const basis = perpendicularBasis(vec3.up())
        const p = visualPos.add(basis.n1.uniformScale(Math.cos(a) * rr)).add(basis.n2.uniformScale(Math.sin(a) * rr)).add(vec3.up().uniformScale(Math.sin(a * 1.7) * o.radius * 0.8))
        const twinkle = 0.7 + 0.3 * flickerNoise(i, o.seed, this.time, 6)
        this.stars!.quadRotated(p, cam.right, cam.up, 0.8 * o.glow * twinkle, 0.8 * o.glow * twinkle, tint(this.colorCore, 1, 0.9 * o.glow), a)
      }
      if (Math.random() < 10 * o.glow * dt) this.spawnMote(visualPos.add(randomUnitVector().uniformScale(o.radius * 1.5)), 0.9, vec3.up().uniformScale(10))
    }
    if (o.state === "flying" && o.vel.length > 150 && Math.random() < 40 * dt) {
      this.spawnMote(visualPos, 1, o.vel.uniformScale(-0.15))
    }
  }

  private bounce(o: TkObject, at: vec3, normal: vec3): void {
    const vn = o.vel.dot(normal)
    if (vn > 0) return
    const speed = o.vel.length
    const tangential = o.vel.sub(normal.uniformScale(vn)).uniformScale(0.65)
    o.vel = tangential.add(normal.uniformScale(-vn * this.restitution))
    o.pos = at
    o.angVel = normal.cross(tangential).uniformScale(0.08).add(o.angVel.uniformScale(0.5))
    if (speed > 80) {
      playOneShotAt(this.ctx!.effectsRoot, MagicSfx.teleLand, at, Math.min(1, speed / 500))
      const basis = perpendicularBasis(normal)
      for (let i = 0; i < 10; i++) {
        const a = randRange(0, Math.PI * 2)
        this.spawnMote(at, 1, basis.n1.uniformScale(Math.cos(a) * 60).add(basis.n2.uniformScale(Math.sin(a) * 60)).add(normal.uniformScale(30)))
      }
    }
  }

  /** An object that left the room (fell through the floor or flew too far) returns home in a sparkle. */
  private rehome(o: TkObject): void {
    o.state = "idle"
    o.heldBy = null
    o.vel = vec3.zero()
    o.pos = o.home
    o.restPos = o.home
    o.settledFor = 0
    for (let i = 0; i < 16; i++) this.spawnMote(o.home.add(randomUnitVector().uniformScale(o.radius)), 1.3, randomUnitVector().uniformScale(30))
  }
}
