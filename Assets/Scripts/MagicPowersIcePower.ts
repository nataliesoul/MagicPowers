/**
 * MagicPowersIcePower — Ice magic: snowflakes over an open palm, an ice sphere in a fist, ice shards
 * on a push, a crystalline shield on a palm facing away.
 *
 * Owns: per-hand ice state (idle → flakes → sphere), the orbiting snowflake / crystal cloud, the
 *       fist-formed ice sphere, ice-shard projectiles (manual integration + WorldQuery impact), the
 *       hexagonal crystal shield, frost-burst impacts, every ice VFX batch and the per-palm shimmer SFX.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager.
 * Must not: read SIK directly or decide which power is active.
 *
 * Gesture map:  open palm → floating snowflakes + ice crystals above the palm
 *               fist → ice sphere forms (flakes spiral in, facets grow)
 *               fast open or push while the sphere is formed → volley of ice shards (frost burst on impact)
 *               slow open → sphere melts back into flakes
 *               open palm facing away from the user → hexagonal crystal shield in front of the hand
 *               push while the shield is up → the shield shatters forward into shards
 */

import { GestureEvent, GestureType, HandPose, HandSide, MagicPower, PowerId, TwoHandState } from "./MagicPowersTypes"
import {
  ParticlePool,
  QuadBatch,
  SphereVisual,
  SurfaceProbe,
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
type IceMode = "idle" | "flakes" | "sphere"

interface OrbitFlake {
  /** 0 = snowflake billboard, 1 = standing ice crystal */
  kind: number
  angle: number
  speed: number
  radius: number
  height: number
  size: number
  spin: number
  bobPhase: number
}

interface HandIce {
  side: HandSide
  mode: IceMode
  /** 0..1 smoothed snowflake presence */
  flakes: number
  /** 0..1 sphere formation */
  sphere: number
  /** smoothed sphere visual presence */
  sphereVis: number
  /** 0..1 smoothed shield presence */
  shield: number
  shieldPlayed: boolean
  orbit: OrbitFlake[]
  core: SphereVisual
  host: SceneObject
  shimmer: SfxEmitter
  motesAccum: number
  seed: number
}

interface Shard {
  pos: vec3
  vel: vec3
  age: number
  length: number
  roll: number
  rollSpeed: number
  travelled: number
  hit: boolean
  probing: boolean
  seed: number
}

interface FrostBurst {
  pos: vec3
  normal: vec3
  age: number
  size: number
  seed: number
}

@component
export class MagicPowersIcePower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersIcePower – snowflakes, ice sphere, shards and a crystal shield</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Casting</span>')
  @ui.group_start("Casting")
  @input
  @hint("Seconds of closed fist needed to form a full ice sphere")
  @widget(new SliderWidget(0.3, 4, 0.1))
  sphereGrowSec: number = 1.2

  @input
  @hint("Minimum sphere formation (0..1) required before an open/push shoots shards; below this the sphere melts")
  @widget(new SliderWidget(0, 0.8, 0.05))
  minSphereToShoot: number = 0.2

  @input
  @hint("Hand opening rate (1/s) that counts as a 'fast open' shot")
  @widget(new SliderWidget(1, 12, 0.25))
  fastOpenRate: number = 3.5

  @input
  @hint("Shard speed (cm/s) for a barely formed sphere")
  @widget(new SliderWidget(100, 1200, 10))
  shardSpeedMin: number = 450

  @input
  @hint("Shard speed (cm/s) for a fully formed sphere")
  @widget(new SliderWidget(100, 1500, 10))
  shardSpeedMax: number = 850

  @input
  @hint("Shards in a volley from a barely formed sphere")
  @widget(new SliderWidget(1, 12, 1))
  shardCountMin: number = 4

  @input
  @hint("Shards in a volley from a fully formed sphere")
  @widget(new SliderWidget(1, 16, 1))
  shardCountMax: number = 9

  @input
  @hint("Volley spread (degrees, half-angle)")
  @widget(new SliderWidget(0, 30, 0.5))
  spreadDeg: number = 7

  @input
  @hint("Downward acceleration on shards (cm/s²)")
  @widget(new SliderWidget(0, 300, 5))
  shardGravity: number = 25

  @input
  @hint("Distance (cm) after which an un-hit shard shatters on its own")
  @widget(new SliderWidget(100, 2000, 10))
  maxRangeCm: number = 900

  @input
  @hint("How much of the shot direction follows the gaze (0 = pure palm normal, 1 = pure gaze)")
  @widget(new SliderWidget(0, 1, 0.05))
  gazeAssist: number = 0.35

  @input
  @hint("Show the crystal shield when an open palm faces away from the user")
  shieldEnabled: boolean = true
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input
  @hint("Snowflakes + crystals floating above each open palm")
  @widget(new SliderWidget(3, 16, 1))
  flakeCount: number = 10

  @input
  @hint("Height (cm) of the snowflake cloud above the palm")
  @widget(new SliderWidget(3, 20, 0.5))
  flakeHeightCm: number = 9

  @input
  @hint("Radius (cm) of the hexagonal crystal shield")
  @widget(new SliderWidget(6, 30, 0.5))
  shieldRadiusCm: number = 13

  @input("vec4", "{1.0, 1.0, 1.0, 1.0}")
  @hint("Brightest colour: snowflake cores, sphere centre, shard tips")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{0.62, 0.86, 1.0, 1.0}")
  @hint("Main pale-blue ice colour")
  @widget(new ColorWidget())
  colorIce: vec4

  @input("vec4", "{0.32, 0.58, 1.0, 1.0}")
  @hint("Deep blue used for glows and the sphere body")
  @widget(new ColorWidget())
  colorDeep: vec4

  @input
  @hint("Volume of the icy shimmer loop over each open palm")
  @widget(new SliderWidget(0, 1, 0.05))
  shimmerVolume: number = 0.4
  @ui.group_end

  readonly powerId = PowerId.Ice

  private hands: Record<HandSide, HandIce> | null = null
  private flakeBatch: QuadBatch | null = null
  private crystalBatch: QuadBatch | null = null
  private glows: QuadBatch | null = null
  private rings: QuadBatch | null = null
  private beams: QuadBatch | null = null
  private sparks: QuadBatch | null = null
  private frostPool = new ParticlePool(160)
  private shards: Shard[] = []
  private bursts: FrostBurst[] = []
  private probe: SurfaceProbe | null = null
  private time = 0
  private built = false
  private vfxRoot: SceneObject | null = null

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("IceVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    const white = new vec4(1, 1, 1, 1)
    this.glows = new QuadBatch(this.vfxRoot, "IceGlows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 40)
    this.rings = new QuadBatch(this.vfxRoot, "IceRings", cloneGlowMaterial(ctx.glowMaterial, tex.ring, white), 16)
    this.beams = new QuadBatch(this.vfxRoot, "IceBeams", cloneGlowMaterial(ctx.glowMaterial, tex.beam, white), 48)
    this.crystalBatch = new QuadBatch(this.vfxRoot, "IceCrystals", cloneGlowMaterial(ctx.glowMaterial, tex.crystal, white), 120)
    this.flakeBatch = new QuadBatch(this.vfxRoot, "Snowflakes", cloneGlowMaterial(ctx.glowMaterial, tex.snowflake, white), 64)
    this.sparks = new QuadBatch(this.vfxRoot, "FrostMotes", cloneGlowMaterial(ctx.glowMaterial, tex.spark, white), 160)
    this.hands = { left: this.makeHand("left"), right: this.makeHand("right") }
    this.probe = new SurfaceProbe()
    this.built = true
  }

  private makeHand(side: HandSide): HandIce {
    const ctx = this.ctx!
    const host = global.scene.createSceneObject(`IceHand_${side}`)
    host.setParent(this.vfxRoot!)
    const core = new SphereVisual(host, "IceCore", ctx, this.colorCore)
    core.setVisible(false)
    const seed = side === "left" ? 17 : 41
    const orbit: OrbitFlake[] = []
    for (let i = 0; i < this.flakeCount; i++) {
      const h = (k: number) => hash1(i * 3.7 + k * 11.3 + seed)
      orbit.push({
        kind: i % 3 === 2 ? 1 : 0,
        angle: h(1) * Math.PI,
        speed: (0.6 + 0.4 * Math.abs(h(2))) * (h(3) > 0 ? 1 : -1),
        radius: 2.5 + 3.5 * Math.abs(h(4)),
        height: 0.3 + 0.7 * Math.abs(h(5)),
        size: i % 3 === 2 ? 1.6 + 0.8 * Math.abs(h(6)) : 1.1 + 0.9 * Math.abs(h(6)),
        spin: (0.5 + Math.abs(h(7))) * (h(8) > 0 ? 1 : -1),
        bobPhase: h(9) * Math.PI,
      })
    }
    return {
      side,
      mode: "idle",
      flakes: 0,
      sphere: 0,
      sphereVis: 0,
      shield: 0,
      shieldPlayed: false,
      orbit,
      core,
      host,
      shimmer: new SfxEmitter(host, MagicSfx.iceShimmer, this.shimmerVolume, false),
      motesAccum: 0,
      seed,
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
      h.mode = "idle"
      h.sphere = 0
      h.shieldPlayed = false
      h.shimmer.stop(true)
      h.core.setVisible(false)
    }
    this.frostPool.clear()
    this.bursts.length = 0
    this.shards.length = 0
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  // ── Gestures ────────────────────────────────────────────────────────────────

  onGesture(e: GestureEvent): void {
    if (!this.hands || e.hand === "both") return
    const h = this.hands[e.hand]
    switch (e.type) {
      case GestureType.OpenPalm:
        if (h.mode === "sphere") this.releaseSphere(h, e, e.strength >= this.fastOpenRate)
        else if (h.mode === "idle") this.summon(h, e.position)
        break
      case GestureType.Fist:
        if (h.mode !== "sphere") this.beginSphere(h, e.position)
        break
      case GestureType.Push:
        if (h.mode === "sphere") this.releaseSphere(h, e, true)
        else if (h.shield > 0.5) this.shatterShield(h, e)
        break
      case GestureType.TrackingLost:
        h.shimmer.setLevel(0)
        break
      default:
        break
    }
  }

  private summon(h: HandIce, at: vec3): void {
    h.mode = "flakes"
    h.host.getTransform().setWorldPosition(at)
    h.shimmer.setLevel(1)
    h.shimmer.playIfSilent(-1)
    for (let i = 0; i < 8; i++) this.spawnMote(at.add(randomUnitVector().uniformScale(3)), 1.2, vec3.up().uniformScale(15))
  }

  private beginSphere(h: HandIce, at: vec3): void {
    h.mode = "sphere"
    h.sphere = 0
    h.core.setVisible(true)
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.iceForm, at, 0.8)
    h.shimmer.setLevel(0.5)
    h.shimmer.playIfSilent(-1)
  }

  private releaseSphere(h: HandIce, e: GestureEvent, fast: boolean): void {
    const formed = h.sphere
    h.core.setVisible(false)
    if (fast && formed >= this.minSphereToShoot) {
      this.shootVolley(this.sphereCentre(h, e.position, e.direction), e.direction, formed)
      h.mode = "idle" // calm open palm after a shot until the next open gesture
      h.shimmer.setLevel(0)
    } else {
      // melt: the sphere dissolves back into drifting flakes
      const c = this.sphereCentre(h, e.position, e.direction)
      for (let i = 0; i < 16; i++) this.spawnMote(c.add(randomUnitVector().uniformScale(3)), 1.0, vec3.up().uniformScale(-10))
      h.mode = "flakes"
      h.shimmer.setLevel(1)
    }
    h.sphere = 0
  }

  private shatterShield(h: HandIce, e: GestureEvent): void {
    const pose = e.position
    const centre = pose.add(e.direction.uniformScale(10))
    this.shootVolley(centre, e.direction, 0.6)
    for (let i = 0; i < 20; i++) this.spawnMote(centre.add(randomUnitVector().uniformScale(this.shieldRadiusCm * 0.8)), 1.3, e.direction.uniformScale(60))
    h.shield = 0
    h.shieldPlayed = false
  }

  private sphereCentre(h: HandIce, palm: vec3, normal: vec3): vec3 {
    return palm.add(normal.uniformScale(4 + 3 * h.sphereVis))
  }

  private shootVolley(from: vec3, dir: vec3, formed: number): void {
    const ctx = this.ctx!
    const look = ctx.camera.back
    let d = dir.uniformScale(1 - this.gazeAssist).add(look.uniformScale(this.gazeAssist))
    if (d.length < 1e-3) d = look
    d = d.normalize()
    const count = Math.round(lerp(this.shardCountMin, this.shardCountMax, formed))
    const speed = lerp(this.shardSpeedMin, this.shardSpeedMax, formed)
    const basis = perpendicularBasis(d)
    const spread = (this.spreadDeg * Math.PI) / 180
    for (let i = 0; i < count; i++) {
      const a = randRange(0, Math.PI * 2)
      const r = Math.tan(spread) * Math.sqrt(Math.random())
      const sd = d.add(basis.n1.uniformScale(Math.cos(a) * r)).add(basis.n2.uniformScale(Math.sin(a) * r)).normalize()
      this.shards.push({
        pos: from.add(sd.uniformScale(randRange(0, 3))),
        vel: sd.uniformScale(speed * randRange(0.85, 1.1)),
        age: 0,
        length: randRange(3.5, 6.5) * (0.7 + 0.5 * formed),
        roll: randRange(0, Math.PI * 2),
        rollSpeed: randRange(-14, 14),
        travelled: 0,
        hit: false,
        probing: false,
        seed: Math.random() * 100,
      })
    }
    while (this.shards.length > 24) this.shards.shift()
    playOneShotAt(ctx.effectsRoot, MagicSfx.iceShoot, from, 0.9)
    for (let i = 0; i < 14; i++) this.spawnMote(from, 1.4, d.uniformScale(-40).add(randomUnitVector().uniformScale(30)))
  }

  private burst(pos: vec3, normal: vec3, size: number): void {
    this.bursts.push({ pos, normal, age: 0, size, seed: Math.random() * 100 })
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.iceImpact, pos, 0.8)
    const basis = perpendicularBasis(normal)
    for (let i = 0; i < 26; i++) {
      const a = randRange(0, Math.PI * 2)
      const along = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
      this.frostPool.spawn({
        pos,
        vel: along.uniformScale(randRange(40, 140)).add(normal.uniformScale(randRange(30, 110))),
        life: randRange(0.5, 1.0),
        size: randRange(0.8, 2.0),
        sizeEnd: 0.1,
        color: Math.random() < 0.4 ? this.colorCore : this.colorIce,
        drag: 1.6,
        gravity: 160,
        spin: randRange(-12, 12),
      })
    }
  }

  private spawnMote(at: vec3, scale: number, extraVel: vec3 = vec3.zero()): void {
    this.frostPool.spawn({
      pos: at.add(randomUnitVector().uniformScale(randRange(0, 1.5))),
      vel: new vec3(randRange(-6, 6), randRange(-4, 6), randRange(-6, 6)).add(extraVel),
      life: randRange(0.7, 1.5),
      size: randRange(0.5, 1.1) * scale,
      sizeEnd: 0.1,
      color: Math.random() < 0.5 ? this.colorCore : this.colorIce,
      drag: 1.2,
      gravity: 9, // frost slowly settles
      turbulence: 18,
      spin: randRange(-6, 6),
    })
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx || !this.hands) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    const poses: Record<HandSide, HandPose> = { left, right }

    this.flakeBatch!.begin()
    this.crystalBatch!.begin()
    this.glows!.begin()
    this.rings!.begin()
    this.beams!.begin()
    this.sparks!.begin()

    for (const side of ["left", "right"] as HandSide[]) this.updateHand(this.hands[side], poses[side], dt, cam)

    this.updateShards(dt, cam)
    this.updateBursts(dt, cam)

    this.frostPool.update(dt, this.time)
    this.frostPool.draw(this.sparks!, cam.right, cam.up, 1)

    this.flakeBatch!.end()
    this.crystalBatch!.end()
    this.glows!.end()
    this.rings!.end()
    this.beams!.end()
    this.sparks!.end()
  }

  /** Camera-right projected onto the plane perpendicular to `axis` (so a shard stands along `axis` yet faces the viewer). */
  private sideAxisFor(axis: vec3, cam: CamBasis): vec3 {
    let side = cam.right.sub(axis.uniformScale(cam.right.dot(axis)))
    if (side.length < 1e-3) side = cam.up.sub(axis.uniformScale(cam.up.dot(axis)))
    return side.normalize()
  }

  private updateHand(h: HandIce, pose: HandPose, dt: number, cam: CamBasis): void {
    const conf = pose.confidence
    // Open palm = summon, so flakes appear right after switching to Ice or after a volley.
    if (h.mode === "idle" && pose.isOpen && !pose.isPalmUp && conf > 0.5) this.summon(h, pose.palmCenter)
    if (h.mode === "flakes" && conf <= 0) {
      h.mode = "idle"
      h.shimmer.setLevel(0)
    }
    h.host.getTransform().setWorldPosition(pose.palmCenter)

    const facingAway = pose.palmNormal.dot(cam.look) > 0.55
    const wantShield = this.shieldEnabled && h.mode === "flakes" && pose.isOpen && !pose.isPalmUp && facingAway && conf > 0
    h.shield = approach(h.shield, wantShield ? conf : 0, wantShield ? 7 : 5, dt)
    if (wantShield && h.shield > 0.3 && !h.shieldPlayed) {
      h.shieldPlayed = true
      playOneShotAt(this.ctx!.effectsRoot, MagicSfx.iceShield, pose.palmCenter.add(pose.palmNormal.uniformScale(10)), 0.7)
    }
    if (!wantShield && h.shield < 0.05) h.shieldPlayed = false

    const wantFlakes = h.mode === "flakes" && pose.isOpen && !pose.isPalmUp && conf > 0
    h.flakes = approach(h.flakes, wantFlakes ? 1 : 0, wantFlakes ? 6 : 4, dt)

    // Idle feedback: faint frost glow on any tracked open hand.
    if (conf > 0 && pose.isOpen && h.mode === "idle") {
      this.glows!.quad(pose.palmCenter.add(pose.palmNormal.uniformScale(1.5)), cam.right, cam.up, 3, 3, tint(this.colorIce, 1, 0.25 * conf))
    }

    const flakeAmt = h.flakes * conf * (1 - 0.6 * h.shield)
    if (flakeAmt > 0.01) this.drawFlakeCloud(h, pose, flakeAmt, dt, cam)
    if (h.shield > 0.02) this.drawShield(h, pose, h.shield * conf, cam)

    // Sphere formation
    const forming = h.mode === "sphere"
    if (forming) h.sphere = clamp01(h.sphere + dt / this.sphereGrowSec)
    h.sphereVis = approach(h.sphereVis, forming ? 1 : 0, 10, dt)
    const sv = h.sphereVis * conf
    h.core.setVisible(sv > 0.02)
    if (sv > 0.02) this.drawSphere(h, pose, sv, dt, cam)

    h.shimmer.setLevel(h.mode === "flakes" ? flakeAmt + 0.4 * h.shield : forming ? 0.5 * conf : 0)
    h.shimmer.update(dt)
    if (h.mode === "idle" && h.shimmer.isPlaying && h.flakes < 0.02) h.shimmer.stop(true)
  }

  private drawFlakeCloud(h: HandIce, pose: HandPose, amt: number, dt: number, cam: CamBasis): void {
    const n = pose.palmNormal
    const basis = perpendicularBasis(n)
    const base = pose.palmCenter.add(n.uniformScale(1.5))
    // ambient palm glow
    this.glows!.quad(base, cam.right, cam.up, 6 * amt, 6 * amt, tint(this.colorDeep, 1, 0.35 * amt))
    this.glows!.quad(base.add(n.uniformScale(this.flakeHeightCm * 0.5)), cam.right, cam.up, 9 * amt, 9 * amt, tint(this.colorIce, 1, 0.18 * amt))
    for (let i = 0; i < h.orbit.length; i++) {
      const f = h.orbit[i]
      f.angle += f.speed * dt
      const bob = Math.sin(this.time * 1.3 + f.bobPhase) * 1.2
      const height = (this.flakeHeightCm * f.height + bob) * amt
      const r = f.radius * amt
      const p = base.add(basis.n1.uniformScale(Math.cos(f.angle) * r)).add(basis.n2.uniformScale(Math.sin(f.angle) * r)).add(n.uniformScale(height))
      const twinkle = 0.75 + 0.25 * flickerNoise(i, h.seed, this.time, 5)
      if (f.kind === 0) {
        const s = f.size * amt * twinkle
        this.flakeBatch!.quadRotated(p, cam.right, cam.up, s, s, tint(i % 2 === 0 ? this.colorCore : this.colorIce, 1, 0.85 * amt), this.time * f.spin + f.bobPhase)
      } else {
        // standing crystal: long axis follows the palm normal, slowly turning about it
        const side = this.sideAxisFor(n, cam)
        const turn = 0.85 + 0.15 * Math.sin(this.time * f.spin * 2 + f.bobPhase)
        this.crystalBatch!.quad(p, side, n, f.size * 0.35 * amt * turn, f.size * amt, tint(this.colorIce, 1, 0.8 * amt))
        this.glows!.quad(p, cam.right, cam.up, f.size * 0.9 * amt, f.size * 0.9 * amt, tint(this.colorDeep, 1, 0.3 * amt))
      }
    }
    h.motesAccum += 6 * amt * dt
    while (h.motesAccum >= 1) {
      h.motesAccum -= 1
      this.spawnMote(base.add(n.uniformScale(randRange(2, this.flakeHeightCm))).add(randomUnitVector().uniformScale(4)), 0.8)
    }
  }

  private drawSphere(h: HandIce, pose: HandPose, sv: number, dt: number, cam: CamBasis): void {
    const f = h.sphere
    const n = pose.palmNormal
    const centre = this.sphereCentre(h, pose.palmCenter, n)
    const pulse = 1 + 0.04 * Math.sin(this.time * 6)
    const radius = lerp(1.5, 5.5, f) * sv * pulse
    h.core.setPosition(centre)
    h.core.setRadius(radius)
    h.core.setColor(tint(vec4.lerp(this.colorDeep, this.colorCore, f * 0.8), 1, 0.85 * sv))
    this.glows!.quad(centre, cam.right, cam.up, radius * 2.8, radius * 2.8, tint(this.colorDeep, 1, 0.45 * sv))
    this.glows!.quad(centre, cam.right, cam.up, radius * 1.3, radius * 1.3, tint(this.colorIce, 1, 0.6 * sv))
    // snowflakes spiral inward as the sphere forms
    const basis = perpendicularBasis(n)
    const count = h.orbit.length
    for (let i = 0; i < count; i++) {
      const o = h.orbit[i]
      o.angle += (o.speed * 2 + f * 3) * dt
      const orbitR = radius + lerp(6, 1.2, f) * sv
      const lift = Math.sin(o.angle * 1.7 + o.bobPhase) * orbitR * 0.5
      const p = centre.add(basis.n1.uniformScale(Math.cos(o.angle) * orbitR)).add(basis.n2.uniformScale(Math.sin(o.angle) * orbitR)).add(n.uniformScale(lift))
      const s = o.size * 0.7 * sv
      this.flakeBatch!.quadRotated(p, cam.right, cam.up, s, s, tint(this.colorCore, 1, 0.8 * sv), this.time * o.spin * 2)
    }
    // facets growing on the surface
    const facets = Math.floor(2 + 6 * f)
    for (let i = 0; i < facets; i++) {
      const a = this.time * 0.8 + i * 2.399
      const dir = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a) * 0.8)).add(n.uniformScale(Math.sin(a * 1.9) * 0.6)).normalize()
      const p = centre.add(dir.uniformScale(radius * 0.9))
      const side = this.sideAxisFor(dir, cam)
      const len = radius * (0.5 + 0.5 * f)
      this.crystalBatch!.quad(p.add(dir.uniformScale(len * 0.3)), side, dir, len * 0.22, len * 0.5, tint(this.colorIce, 1, 0.75 * sv * f))
    }
    if (Math.random() < 18 * f * dt) this.spawnMote(centre.add(randomUnitVector().uniformScale(radius)), 0.8, randomUnitVector().uniformScale(12))
  }

  private drawShield(h: HandIce, pose: HandPose, s: number, cam: CamBasis): void {
    const n = pose.palmNormal
    const centre = pose.palmCenter.add(n.uniformScale(10))
    const basis = perpendicularBasis(n)
    const r = this.shieldRadiusCm * (0.5 + 0.5 * s)
    const rot = this.time * 0.25
    const hexPoint = (k: number, rr: number): vec3 => {
      const a = rot + (k * Math.PI) / 3
      return centre.add(basis.n1.uniformScale(Math.cos(a) * rr)).add(basis.n2.uniformScale(Math.sin(a) * rr))
    }
    // plate: soft fill + ring + hexagon outline of beams
    this.glows!.quad(centre, basis.n1, basis.n2, r * 1.0, r * 1.0, tint(this.colorDeep, 1, 0.35 * s))
    this.rings!.quad(centre, basis.n1, basis.n2, r * 0.92, r * 0.92, tint(this.colorIce, 1, 0.55 * s))
    for (let k = 0; k < 6; k++) {
      this.beams!.segment(hexPoint(k, r), hexPoint(k + 1, r), 1.2 * s, tint(this.colorCore, 1, 0.9 * s), cam.pos)
      this.beams!.segment(hexPoint(k, r * 0.55), hexPoint(k + 1, r * 0.55), 0.7 * s, tint(this.colorIce, 1, 0.6 * s), cam.pos)
    }
    // radial crystal spokes (a giant snowflake) + rim shards pointing outward
    for (let k = 0; k < 6; k++) {
      const a = rot + (k * Math.PI) / 3
      const dir = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
      const side = n.cross(dir).normalize()
      const sparkle = 0.8 + 0.2 * flickerNoise(k, h.seed, this.time, 4)
      this.crystalBatch!.quad(centre.add(dir.uniformScale(r * 0.42)), side, dir, r * 0.09 * s, r * 0.42 * s, tint(this.colorIce, 1, 0.7 * s * sparkle))
      this.crystalBatch!.quad(centre.add(dir.uniformScale(r * 1.1)), side, dir, r * 0.06 * s, r * 0.18 * s, tint(this.colorCore, 1, 0.85 * s))
    }
    this.glows!.quad(centre, cam.right, cam.up, r * 0.5, r * 0.5, tint(this.colorCore, 1, 0.4 * s))
  }

  private updateShards(dt: number, cam: CamBasis): void {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const sh = this.shards[i]
      if (sh.hit) {
        this.shards.splice(i, 1)
        continue
      }
      sh.age += dt
      const prev = sh.pos
      sh.vel = new vec3(sh.vel.x, sh.vel.y - this.shardGravity * dt, sh.vel.z)
      sh.pos = sh.pos.add(sh.vel.uniformScale(dt))
      sh.travelled += sh.vel.length * dt
      sh.roll += sh.rollSpeed * dt
      const dir = sh.vel.normalize()
      // crystal body along the flight direction; a slight roll wobbles its apparent width
      const side = this.sideAxisFor(dir, cam)
      const w = sh.length * (0.16 + 0.06 * Math.sin(sh.roll))
      this.crystalBatch!.quad(sh.pos, side, dir, w, sh.length * 0.5, tint(this.colorCore, 1, 0.95))
      this.glows!.quad(sh.pos, cam.right, cam.up, sh.length * 0.8, sh.length * 0.8, tint(this.colorIce, 1, 0.5))
      // frost trail
      if (Math.random() < 70 * dt) this.spawnMote(sh.pos.sub(dir.uniformScale(sh.length * 0.5)), 0.9, dir.uniformScale(-30))

      if (sh.travelled >= this.maxRangeCm || sh.pos.y < cam.pos.y - 170) {
        this.burst(sh.pos, vec3.up(), lerp(8, 14, Math.random()))
        sh.hit = true
        continue
      }
      if (this.probe && this.probe.isAvailable && !sh.probing) {
        sh.probing = true
        const ahead = sh.pos.add(sh.vel.uniformScale(dt * 3 + 0.02)).add(dir.uniformScale(sh.length * 0.5))
        this.probe.probe(prev, ahead, (hit) => {
          sh.probing = false
          if (hit && !sh.hit) {
            this.burst(hit.position, hit.normal, lerp(8, 14, Math.random()))
            sh.hit = true
          }
        })
      }
    }
  }

  private updateBursts(dt: number, cam: CamBasis): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]
      b.age += dt
      const t = b.age / 0.9
      if (t >= 1) {
        this.bursts.splice(i, 1)
        continue
      }
      const basis = perpendicularBasis(b.normal)
      const fade = (1 - t) * (1 - t)
      const ringR = b.size * smoothstep(0, 1, t * 1.3)
      this.rings!.quad(b.pos.add(b.normal.uniformScale(0.5)), basis.n1, basis.n2, ringR, ringR, tint(this.colorIce, 1, 0.9 * fade))
      this.glows!.quad(b.pos, cam.right, cam.up, b.size * (0.5 + t * 0.6), b.size * (0.5 + t * 0.6), tint(this.colorCore, 1, 0.8 * fade))
      // frost spikes grow out of the surface, then crumble
      const grow = smoothstep(0, 0.35, t) * (1 - smoothstep(0.7, 1, t))
      for (let k = 0; k < 7; k++) {
        const a = hash1(k * 5.1 + b.seed) * Math.PI
        const tiltA = 0.35 + 0.4 * Math.abs(hash1(k * 9.3 + b.seed))
        const dir = basis.n1.uniformScale(Math.cos(a) * Math.sin(tiltA)).add(basis.n2.uniformScale(Math.sin(a) * Math.sin(tiltA))).add(b.normal.uniformScale(Math.cos(tiltA))).normalize()
        const len = b.size * (0.5 + 0.5 * Math.abs(hash1(k * 2.7 + b.seed))) * grow
        const side = this.sideAxisFor(dir, cam)
        this.crystalBatch!.quad(b.pos.add(dir.uniformScale(len * 0.5)), side, dir, len * 0.2, len * 0.5, tint(k % 2 === 0 ? this.colorCore : this.colorIce, 1, 0.9 * grow))
      }
    }
  }
}
