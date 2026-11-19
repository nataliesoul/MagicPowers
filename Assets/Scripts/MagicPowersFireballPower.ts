/**
 * MagicPowersFireballPower — Fire magic: flame on an open palm, charge in a fist, throw a fireball.
 *
 * Owns: per-hand fire state (idle → flame → charging → launch/fizzle), the two-hand fire sphere,
 *       fireball projectiles (manual integration + WorldQuery impact), all fire VFX batches and
 *       the spatial fire SFX hosts that follow each palm.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager.
 * Must not: read SIK directly or decide which power is active.
 *
 * Gesture map:  open palm → flame  ·  fist → charge (grows/pulses, sparks, rising SFX)
 *               fast open or push while charged → launch  ·  slow open → fizzle
 *               both palms facing (open) → large swirling fire sphere between the hands
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
  lerp,
  perpendicularBasis,
  randRange,
  randomUnitVector,
  smoothstep,
  tint,
} from "./MagicPowersEffectsLib"
import { SfxEmitter, playOneShotAt } from "./MagicPowersAudioLib"
import { MagicSfx } from "./MagicPowersAssetManifest"

type FireMode = "idle" | "flame" | "charge"

interface HandFire {
  side: HandSide
  mode: FireMode
  /** 0..1 smoothed flame presence */
  flame: number
  /** 0..1 charge level */
  charge: number
  /** smoothed charge visual presence */
  chargeVis: number
  emberAccum: number
  sphere: SphereVisual
  host: SceneObject
  loop: SfxEmitter
  rise: SfxEmitter
  seed: number
}

interface Fireball {
  pos: vec3
  vel: vec3
  charge: number
  age: number
  radius: number
  sphere: SphereVisual
  host: SceneObject
  travelled: number
  hit: boolean
  probing: boolean
  seed: number
}

interface Impact {
  pos: vec3
  normal: vec3
  age: number
  size: number
}

@component
export class MagicPowersFireballPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersFireballPower – summon, charge and throw fire</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Casting</span>')
  @ui.group_start("Casting")
  @input
  @hint("Seconds of closed fist needed to reach a full charge")
  @widget(new SliderWidget(0.3, 4, 0.1))
  chargeTimeSec: number = 1.4

  @input
  @hint("Minimum charge (0..1) required before an open/push launches a fireball; below this the charge fizzles")
  @widget(new SliderWidget(0, 0.8, 0.05))
  minChargeToLaunch: number = 0.15

  @input
  @hint("Hand opening rate (1/s) that counts as a 'fast open' throw")
  @widget(new SliderWidget(1, 12, 0.25))
  fastOpenRate: number = 3.5

  @input
  @hint("Fireball speed (cm/s) at minimum charge")
  @widget(new SliderWidget(100, 1200, 10))
  launchSpeedMin: number = 320

  @input
  @hint("Fireball speed (cm/s) at full charge")
  @widget(new SliderWidget(100, 1500, 10))
  launchSpeedMax: number = 720

  @input
  @hint("Downward acceleration on fireballs (cm/s²); 0 = straight line")
  @widget(new SliderWidget(0, 400, 5))
  projectileGravity: number = 45

  @input
  @hint("Distance (cm) after which an un-hit fireball bursts on its own")
  @widget(new SliderWidget(100, 2000, 10))
  maxRangeCm: number = 900

  @input
  @hint("How much of the throw direction follows the gaze (0 = pure palm normal, 1 = pure gaze)")
  @widget(new SliderWidget(0, 1, 0.05))
  gazeAssist: number = 0.35

  @input
  @hint("Maximum fireballs in flight at once")
  @widget(new SliderWidget(1, 8, 1))
  maxProjectiles: number = 3
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input
  @hint("Height of the palm flame (cm)")
  @widget(new SliderWidget(4, 25, 0.5))
  flameHeightCm: number = 11

  @input
  @hint("Embers spawned per second per burning palm")
  @widget(new SliderWidget(0, 120, 1))
  emberRate: number = 40

  @input("vec4", "{1.0, 0.95, 0.65, 1.0}")
  @hint("Hottest colour at the flame core / fireball centre")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{1.0, 0.45, 0.08, 1.0}")
  @hint("Main flame colour")
  @widget(new ColorWidget())
  colorFlame: vec4

  @input("vec4", "{1.0, 0.25, 0.04, 1.0}")
  @hint("Ember / outer glow colour")
  @widget(new ColorWidget())
  colorEmber: vec4

  @input
  @hint("Volume of the crackling fire loop on each burning palm")
  @widget(new SliderWidget(0, 1, 0.05))
  fireLoopVolume: number = 0.55
  @ui.group_end

  readonly powerId = PowerId.Fireball

  private hands: Record<HandSide, HandFire> | null = null
  private flames: QuadBatch | null = null
  private glows: QuadBatch | null = null
  private embers: QuadBatch | null = null
  private sparks: QuadBatch | null = null
  private rings: QuadBatch | null = null
  private emberPool = new ParticlePool(140)
  private sparkPool = new ParticlePool(80)
  private fireballs: Fireball[] = []
  private impacts: Impact[] = []
  private probe: SurfaceProbe | null = null
  private twoHand = 0
  private time = 0
  private built = false
  private vfxRoot: SceneObject | null = null

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("FireVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    this.flames = new QuadBatch(this.vfxRoot, "Flames", cloneGlowMaterial(ctx.glowMaterial, tex.flame, new vec4(1, 1, 1, 1)), 48)
    this.glows = new QuadBatch(this.vfxRoot, "Glows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, new vec4(1, 1, 1, 1)), 24)
    this.embers = new QuadBatch(this.vfxRoot, "Embers", cloneGlowMaterial(ctx.glowMaterial, tex.glow, new vec4(1, 1, 1, 1)), 140)
    this.sparks = new QuadBatch(this.vfxRoot, "Sparks", cloneGlowMaterial(ctx.glowMaterial, tex.spark, new vec4(1, 1, 1, 1)), 80)
    this.rings = new QuadBatch(this.vfxRoot, "Rings", cloneGlowMaterial(ctx.glowMaterial, tex.ring, new vec4(1, 1, 1, 1)), 8)
    this.hands = { left: this.makeHand("left"), right: this.makeHand("right") }
    this.probe = new SurfaceProbe()
    this.built = true
  }

  private makeHand(side: HandSide): HandFire {
    const ctx = this.ctx!
    const host = global.scene.createSceneObject(`FireHand_${side}`)
    host.setParent(this.vfxRoot!)
    const sphere = new SphereVisual(host, "ChargeSphere", ctx, this.colorCore)
    sphere.setVisible(false)
    return {
      side,
      mode: "idle",
      flame: 0,
      charge: 0,
      chargeVis: 0,
      emberAccum: 0,
      sphere,
      host,
      loop: new SfxEmitter(host, MagicSfx.fireLoop, this.fireLoopVolume, false),
      rise: new SfxEmitter(host, MagicSfx.chargeRise, 0.8, true),
      seed: side === "left" ? 11 : 37,
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
      h.charge = 0
      h.loop.stop(true)
      h.rise.stop(true)
    }
    this.emberPool.clear()
    this.sparkPool.clear()
    this.impacts.length = 0
    for (const f of this.fireballs) this.destroyFireball(f)
    this.fireballs.length = 0
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  // ── Gestures ────────────────────────────────────────────────────────────────

  onGesture(e: GestureEvent): void {
    if (!this.hands || e.hand === "both") return
    const h = this.hands[e.hand]
    switch (e.type) {
      case GestureType.OpenPalm:
        if (h.mode === "charge") {
          this.releaseCharge(h, e, e.strength >= this.fastOpenRate)
        } else if (h.mode === "idle") {
          this.ignite(h, e.position)
        }
        break
      case GestureType.Fist:
        if (h.mode !== "charge") this.beginCharge(h)
        break
      case GestureType.Push:
        if (h.mode === "charge") this.releaseCharge(h, e, true)
        break
      case GestureType.TrackingLost:
        // keep state; visuals fade through pose.confidence
        h.loop.setLevel(0)
        break
      case GestureType.TrackingAcquired:
        break
    }
  }

  private ignite(h: HandFire, at: vec3): void {
    h.mode = "flame"
    h.host.getTransform().setWorldPosition(at)
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.fireIgnite, at, 0.8)
    h.loop.setLevel(1)
    h.loop.playIfSilent(-1)
    for (let i = 0; i < 10; i++) this.spawnEmber(at, 1.4)
  }

  private beginCharge(h: HandFire): void {
    h.mode = "charge"
    h.charge = 0
    h.loop.setLevel(0.4)
    h.loop.playIfSilent(-1)
    h.rise.play(1)
    h.sphere.setVisible(true)
  }

  private releaseCharge(h: HandFire, e: GestureEvent, fast: boolean): void {
    const charge = h.charge
    h.rise.stop(true)
    h.sphere.setVisible(false)
    if (fast && charge >= this.minChargeToLaunch) {
      this.launch(h, e, charge)
      h.mode = "idle" // the open palm after a throw stays calm until the next open gesture
      h.loop.setLevel(0)
    } else {
      // fizzle: puff of embers, flame returns
      for (let i = 0; i < 14; i++) this.spawnEmber(this.chargeCenter(h, e.position, e.direction), 1.0)
      h.mode = "flame"
      h.loop.setLevel(1)
    }
    h.charge = 0
  }

  private chargeCenter(h: HandFire, palm: vec3, normal: vec3): vec3 {
    return palm.add(normal.uniformScale(5 + 4 * h.chargeVis))
  }

  private launch(h: HandFire, e: GestureEvent, charge: number): void {
    const ctx = this.ctx!
    if (this.fireballs.length >= this.maxProjectiles) this.destroyFireball(this.fireballs.shift()!)
    const look = ctx.camera.back
    let dir = e.direction.uniformScale(1 - this.gazeAssist).add(look.uniformScale(this.gazeAssist))
    if (dir.length < 1e-3) dir = look
    dir = dir.normalize()
    const speed = lerp(this.launchSpeedMin, this.launchSpeedMax, charge)
    const radius = lerp(3, 7, charge)
    const start = this.chargeCenter(h, e.position, e.direction)
    const host = global.scene.createSceneObject("Fireball")
    host.setParent(this.vfxRoot!)
    host.getTransform().setWorldPosition(start)
    const sphere = new SphereVisual(host, "Core", ctx, this.colorCore)
    sphere.setRadius(radius * 0.55)
    sphere.setPosition(start)
    const fb: Fireball = {
      pos: start,
      vel: dir.uniformScale(speed),
      charge,
      age: 0,
      radius,
      sphere,
      host,
      travelled: 0,
      hit: false,
      probing: false,
      seed: Math.random() * 100,
    }
    this.fireballs.push(fb)
    playOneShotAt(ctx.effectsRoot, MagicSfx.fireLaunch, start, 0.9)
    for (let i = 0; i < 16; i++) this.spawnEmber(start, 1.6, dir.uniformScale(-60))
  }

  private destroyFireball(f: Fireball): void {
    f.sphere.destroy()
    if (!isNull(f.host)) f.host.destroy()
  }

  private burst(pos: vec3, normal: vec3, charge: number): void {
    const size = lerp(14, 30, charge)
    this.impacts.push({ pos, normal, age: 0, size })
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.fireImpact, pos, 0.9)
    const basis = perpendicularBasis(normal)
    for (let i = 0; i < 36; i++) {
      const a = randRange(0, Math.PI * 2)
      const spread = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
      const vel = spread.uniformScale(randRange(60, 160) * (0.6 + charge)).add(normal.uniformScale(randRange(20, 90)))
      this.emberPool.spawn({
        pos,
        vel,
        life: randRange(0.5, 1.1),
        size: randRange(1.5, 3.5) * (0.7 + charge * 0.6),
        sizeEnd: 0.2,
        color: Math.random() < 0.3 ? this.colorCore : this.colorEmber,
        drag: 1.4,
        gravity: 120,
        turbulence: 40,
      })
    }
    for (let i = 0; i < 20; i++) {
      this.sparkPool.spawn({
        pos,
        vel: randomUnitVector().uniformScale(randRange(120, 260)),
        life: randRange(0.25, 0.5),
        size: randRange(2, 4),
        sizeEnd: 0.3,
        color: this.colorCore,
        drag: 2.5,
        gravity: 60,
      })
    }
  }

  private spawnEmber(at: vec3, scale: number, extraVel: vec3 = vec3.zero()): void {
    const jitter = randomUnitVector().uniformScale(randRange(0, 2.5))
    this.emberPool.spawn({
      pos: at.add(jitter),
      vel: new vec3(randRange(-8, 8), randRange(18, 38) * scale, randRange(-8, 8)).add(extraVel),
      life: randRange(0.6, 1.3),
      size: randRange(0.9, 1.9) * scale,
      sizeEnd: 0.15,
      color: Math.random() < 0.25 ? this.colorCore : this.colorEmber,
      drag: 0.6,
      gravity: -14, // embers rise
      turbulence: 35,
    })
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx || !this.hands) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    const poses: Record<HandSide, HandPose> = { left, right }

    // Two-hand fire sphere: both open palms facing each other.
    const wantTwo = two.palmsFacing && left.isOpen && right.isOpen && left.confidence > 0.5 && right.confidence > 0.5
    this.twoHand = approach(this.twoHand, wantTwo ? 1 : 0, 6, dt)

    this.flames!.begin()
    this.glows!.begin()
    this.sparks!.begin()
    this.rings!.begin()

    for (const side of ["left", "right"] as HandSide[]) {
      const h = this.hands[side]
      const pose = poses[side]
      this.updateHand(h, pose, dt, cam)
    }

    if (this.twoHand > 0.01) this.drawTwoHandSphere(two, left, right, dt, cam)

    this.updateFireballs(dt, cam)
    this.updateImpacts(dt, cam)

    this.emberPool.update(dt, this.time)
    this.sparkPool.update(dt, this.time)
    this.embers!.begin()
    this.emberPool.draw(this.embers!, cam.right, cam.up, 1)
    this.embers!.end()
    this.sparkPool.draw(this.sparks!, cam.right, cam.up, 1)

    this.flames!.end()
    this.glows!.end()
    this.sparks!.end()
    this.rings!.end()
  }

  private updateHand(h: HandFire, pose: HandPose, dt: number, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    const conf = pose.confidence
    // Open palm = summon: an idle open hand (that is not holding the spell selector up) always
    // ignites, so the flame also appears right after switching to this power or after a throw.
    if (h.mode === "idle" && pose.isOpen && !pose.isPalmUp && conf > 0.5) this.ignite(h, pose.palmCenter)
    const wantFlame = h.mode === "flame" && pose.isOpen && !pose.isPalmUp && conf > 0
    h.flame = approach(h.flame, wantFlame ? 1 : 0, wantFlame ? 8 : 5, dt)
    h.host.getTransform().setWorldPosition(pose.palmCenter)

    // Idle feedback: any tracked open hand gets a faint ember glow so the user sees the power is live.
    if (conf > 0 && pose.isOpen && h.mode === "idle") {
      this.glows!.quad(pose.palmCenter.add(pose.palmNormal.uniformScale(1.5)), cam.right, cam.up, 3, 3, tint(this.colorEmber, 1, 0.25 * conf))
    }

    if (h.mode === "flame" && !pose.isOpen && !pose.isFist && conf > 0) {
      // hand half-closed: flame keeps burning but we let `flame` decay a little via wantFlame=false
    }
    if (h.mode === "flame" && conf <= 0) {
      // fully lost: go idle so a re-acquire needs a fresh open-palm gesture
      h.mode = "idle"
      h.loop.setLevel(0)
    }

    // Flame visuals
    const flameAmt = h.flame * conf * (1 - this.twoHand * 0.85)
    if (flameAmt > 0.01) {
      const base = pose.palmCenter.add(pose.palmNormal.uniformScale(1.0))
      // Flames rise (gravity) with a lean towards the palm normal, so a sideways palm still reads as fire.
      const upAxis = pose.palmNormal.uniformScale(0.3).add(vec3.up().uniformScale(0.7)).normalize()
      const sideAxis = cam.right.sub(upAxis.uniformScale(cam.right.dot(upAxis))).normalize()
      const tongues = 7
      for (let i = 0; i < tongues; i++) {
        const n = flickerNoise(i, h.seed, this.time, 9)
        const n2 = flickerNoise(i + 20, h.seed, this.time, 13)
        const height = this.flameHeightCm * flameAmt * (0.55 + 0.45 * (0.5 + 0.5 * n)) * (i === 0 ? 1.15 : 0.85)
        const width = height * 0.5 * (0.8 + 0.2 * n2)
        const lateral = i === 0 ? 0 : ((i % 2 === 0 ? 1 : -1) * (0.6 + i * 0.35) + n2 * 0.8)
        const centre = base.add(sideAxis.uniformScale(lateral)).add(upAxis.uniformScale(height * 0.5))
        const col = i < 3 ? this.colorCore : this.colorFlame
        this.flames!.quad(centre, sideAxis, upAxis, width * 0.5, height * 0.5, tint(col, 1, (i < 3 ? 0.95 : 0.7) * flameAmt))
      }
      // palm glow + hot core
      this.glows!.quad(base, cam.right, cam.up, 7 * flameAmt, 7 * flameAmt, tint(this.colorFlame, 1, 0.55 * flameAmt))
      this.glows!.quad(base.add(upAxis.uniformScale(2)), cam.right, cam.up, 3 * flameAmt, 3 * flameAmt, tint(this.colorCore, 1, 0.8 * flameAmt))
      h.emberAccum += this.emberRate * flameAmt * dt
      while (h.emberAccum >= 1) {
        h.emberAccum -= 1
        this.spawnEmber(base.add(upAxis.uniformScale(randRange(1, 5))), 1)
      }
    }
    h.loop.setLevel(h.mode === "flame" ? flameAmt : h.mode === "charge" ? 0.35 * conf : 0)
    h.loop.update(dt)
    if (h.mode !== "flame" && h.mode !== "charge" && h.loop.isPlaying && h.flame < 0.02) h.loop.stop(true)

    // Charge visuals
    const charging = h.mode === "charge"
    if (charging) h.charge = clamp01(h.charge + dt / this.chargeTimeSec)
    h.chargeVis = approach(h.chargeVis, charging ? 1 : 0, 10, dt)
    const cv = h.chargeVis * conf
    h.sphere.setVisible(cv > 0.02)
    if (cv > 0.02) {
      const c = h.charge
      const pulse = 1 + 0.08 * Math.sin(this.time * (8 + 14 * c)) * c
      const radius = lerp(1.5, 6.5, c) * cv * pulse
      const centre = this.chargeCenter(h, pose.palmCenter, pose.palmNormal)
      h.sphere.setPosition(centre)
      h.sphere.setRadius(radius)
      h.sphere.setColor(tint(vec4.lerp(this.colorFlame, this.colorCore, c), 1, 0.9 * cv))
      this.glows!.quad(centre, cam.right, cam.up, radius * 2.6, radius * 2.6, tint(this.colorFlame, 1, 0.5 * cv))
      this.glows!.quad(centre, cam.right, cam.up, radius * 1.3, radius * 1.3, tint(this.colorCore, 1, 0.7 * cv))
      // orbiting sparks drawn directly (no pool) — count grows with charge
      const sparkCount = Math.floor(4 + 14 * c)
      for (let i = 0; i < sparkCount; i++) {
        const a = this.time * (3 + 2 * c) + i * 2.399
        const r = radius + 1.5 + 2.5 * Math.sin(this.time * 5 + i)
        const basis = perpendicularBasis(pose.palmNormal)
        const p = centre.add(basis.n1.uniformScale(Math.cos(a) * r)).add(basis.n2.uniformScale(Math.sin(a) * r * 0.7)).add(pose.palmNormal.uniformScale(Math.sin(a * 1.3) * r * 0.4))
        this.sparks!.quadRotated(p, cam.right, cam.up, 0.6, 1.6, tint(this.colorCore, 1, 0.9 * cv), a)
      }
      if (Math.random() < 20 * c * dt) this.spawnEmber(centre, 0.8, randomUnitVector().uniformScale(30))
    }
  }

  private drawTwoHandSphere(two: TwoHandState, left: HandPose, right: HandPose, dt: number, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    const amt = this.twoHand * Math.min(left.confidence, right.confidence)
    if (amt <= 0.01) return
    const centre = two.midpoint
    const radius = Math.max(4, Math.min(16, two.distance * 0.34)) * amt
    // Burning sphere: tongues sit around the horizontal equator and rise upward while swirling
    // around the vertical axis (a flat ring of fire would look edge-on from most angles).
    const basis = perpendicularBasis(vec3.up())
    const tongues = 12
    for (let i = 0; i < tongues; i++) {
      const a = this.time * 2.2 + i * (Math.PI * 2 / tongues)
      const n = flickerNoise(i + 300, 5, this.time, 10)
      const lift = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(a * 2 + this.time))
      const p = centre.add(basis.n1.uniformScale(Math.cos(a) * radius * 0.85)).add(basis.n2.uniformScale(Math.sin(a) * radius * 0.85)).add(vec3.up().uniformScale(radius * lift))
      const outward = p.sub(centre).normalize()
      const upAxis = outward.uniformScale(0.3).add(vec3.up().uniformScale(0.7)).normalize()
      const sideAxis = cam.right.sub(upAxis.uniformScale(cam.right.dot(upAxis))).normalize()
      const h = radius * (0.9 + 0.4 * n)
      this.flames!.quad(p.add(upAxis.uniformScale(h * 0.4)), sideAxis, upAxis, h * 0.25, h * 0.5, tint(i % 3 === 0 ? this.colorCore : this.colorFlame, 1, 0.75 * amt))
    }
    this.glows!.quad(centre, cam.right, cam.up, radius * 2.4, radius * 2.4, tint(this.colorFlame, 1, 0.6 * amt))
    this.glows!.quad(centre, cam.right, cam.up, radius * 1.2, radius * 1.2, tint(this.colorCore, 1, 0.8 * amt))
    if (Math.random() < 60 * amt * dt) this.spawnEmber(centre.add(randomUnitVector().uniformScale(radius)), 1.2, randomUnitVector().uniformScale(25))
    this.hands!.left.loop.setLevel(amt)
    this.hands!.left.loop.playIfSilent(-1)
  }

  private updateFireballs(dt: number, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i]
      if (f.hit) {
        this.destroyFireball(f)
        this.fireballs.splice(i, 1)
        continue
      }
      f.age += dt
      const prev = f.pos
      f.vel = new vec3(f.vel.x, f.vel.y - this.projectileGravity * dt, f.vel.z)
      f.pos = f.pos.add(f.vel.uniformScale(dt))
      f.travelled += f.vel.length * dt
      f.host.getTransform().setWorldPosition(f.pos)
      f.sphere.setPosition(f.pos)
      const pulse = 1 + 0.1 * Math.sin(this.time * 22 + f.seed)
      f.sphere.setRadius(f.radius * 0.55 * pulse)
      f.sphere.setColor(this.colorCore)
      const dir = f.vel.normalize()
      // glow + trailing flame tongues
      this.glows!.quad(f.pos, cam.right, cam.up, f.radius * 2.4, f.radius * 2.4, tint(this.colorFlame, 1, 0.6))
      this.glows!.quad(f.pos, cam.right, cam.up, f.radius * 1.2, f.radius * 1.2, tint(this.colorCore, 1, 0.85))
      const back = dir.uniformScale(-1)
      const sideAxis = cam.right.sub(back.uniformScale(cam.right.dot(back))).normalize()
      for (let k = 0; k < 5; k++) {
        const n = flickerNoise(k, f.seed, this.time, 16)
        const len = f.radius * (1.8 + 0.6 * n) * (1 - k * 0.12)
        const off = back.uniformScale(f.radius * 0.6 + k * f.radius * 0.5)
        const lat = sideAxis.uniformScale(n * f.radius * 0.35)
        this.flames!.quad(f.pos.add(off).add(lat).add(back.uniformScale(len * 0.5)), sideAxis, back, f.radius * 0.45, len * 0.5, tint(k < 2 ? this.colorCore : this.colorFlame, 1, 0.8 - k * 0.12))
      }
      // ember trail
      if (Math.random() < 90 * dt) this.spawnEmber(f.pos.add(back.uniformScale(f.radius)), 1.1, back.uniformScale(randRange(20, 60)))

      // Impact: surface hit (WorldQuery), ground fallback, or range
      const camY = cam.pos.y
      if (f.travelled >= this.maxRangeCm || f.pos.y < camY - 170) {
        this.burst(f.pos, vec3.up(), f.charge)
        f.hit = true
        continue
      }
      if (this.probe && this.probe.isAvailable && !f.probing) {
        f.probing = true
        const ahead = f.pos.add(f.vel.uniformScale(dt * 3 + 0.02)).add(dir.uniformScale(f.radius))
        this.probe.probe(prev, ahead, (hit) => {
          f.probing = false
          if (hit && !f.hit) {
            this.burst(hit.position, hit.normal, f.charge)
            f.hit = true
          }
        })
      }
    }
  }

  private updateImpacts(dt: number, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i]
      im.age += dt
      const t = im.age / 0.6
      if (t >= 1) {
        this.impacts.splice(i, 1)
        continue
      }
      const basis = perpendicularBasis(im.normal)
      const ringR = im.size * smoothstep(0, 1, t)
      const fade = (1 - t) * (1 - t)
      this.rings!.quad(im.pos.add(im.normal.uniformScale(0.5)), basis.n1, basis.n2, ringR, ringR, tint(this.colorFlame, 1, 0.9 * fade))
      this.glows!.quad(im.pos, cam.right, cam.up, im.size * (0.6 + t), im.size * (0.6 + t), tint(this.colorCore, 1, 0.9 * fade))
    }
  }
}
