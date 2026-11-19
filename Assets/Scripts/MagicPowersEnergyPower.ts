/**
 * MagicPowersEnergyPower — Energy magic: a sphere of violet energy held between the palms.
 *
 * Owns: the between-the-palms energy sphere (size follows inter-palm distance; compressing makes it
 *       smaller, brighter and faster; expanding stretches it into a beam-like ellipsoid), the launched
 *       energy wave projectile (manual integration + WorldQuery impact), open-palm shields, and the
 *       spatial hum loop.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager.
 * Must not: read SIK directly or decide which power is active.
 *
 * Gesture map:  both palms facing → sphere forms between them (size = distance)
 *               hands together → compress (brighter, denser, spins faster)
 *               hands apart → expand / stretch into a beam  ·  push → launch an energy wave
 *               single open palm facing away → energy shield
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
  lerp,
  perpendicularBasis,
  randRange,
  randomUnitVector,
  smoothstep,
  tint,
} from "./MagicPowersEffectsLib"
import { SfxEmitter, playOneShotAt } from "./MagicPowersAudioLib"
import { MagicSfx } from "./MagicPowersAssetManifest"

interface Wave {
  pos: vec3
  vel: vec3
  radius: number
  age: number
  core: SphereVisual
  body: SphereVisual
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
export class MagicPowersEnergyPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersEnergyPower – compress, expand and launch energy</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Sphere</span>')
  @ui.group_start("Sphere")
  @input
  @hint("Sphere radius as a fraction of the palm-to-palm distance")
  @widget(new SliderWidget(0.1, 0.6, 0.01))
  radiusPerDistance: number = 0.3

  @input
  @hint("Smallest sphere radius (cm) when the hands are fully compressed")
  @widget(new SliderWidget(1, 10, 0.5))
  minRadiusCm: number = 3

  @input
  @hint("Largest sphere radius (cm) before the energy stretches into a beam")
  @widget(new SliderWidget(6, 30, 0.5))
  maxRadiusCm: number = 15

  @input
  @hint("Extra brightness gained while compressing (hands moving together)")
  @widget(new SliderWidget(0, 3, 0.1))
  compressBrightness: number = 1.2

  @input
  @hint("Base rotation speed of the particle shell (rad/s); speeds up as the sphere compresses")
  @widget(new SliderWidget(0.2, 8, 0.1))
  spinSpeed: number = 1.8

  @input
  @hint("Particles orbiting the sphere")
  @widget(new SliderWidget(8, 80, 1))
  shellParticles: number = 40
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Launch &amp; shield</span>')
  @ui.group_start("Launch & shield")
  @input
  @hint("Energy wave speed (cm/s)")
  @widget(new SliderWidget(100, 1200, 10))
  launchSpeed: number = 420

  @input
  @hint("How much the wave grows per second of flight (multiplier)")
  @widget(new SliderWidget(1, 3, 0.05))
  waveGrowth: number = 1.5

  @input
  @hint("Distance (cm) after which an un-hit wave dissipates")
  @widget(new SliderWidget(100, 2000, 10))
  maxRangeCm: number = 800

  @input
  @hint("Show an energy shield in front of a single open palm facing away from you")
  shieldEnabled: boolean = true

  @input
  @hint("Shield radius (cm)")
  @widget(new SliderWidget(5, 40, 0.5))
  shieldRadiusCm: number = 14
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input("vec4", "{1.0, 0.85, 1.0, 1.0}")
  @hint("Bright core colour")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{0.62, 0.25, 1.0, 1.0}")
  @hint("Sphere body colour")
  @widget(new ColorWidget())
  colorBody: vec4

  @input("vec4", "{0.95, 0.45, 1.0, 1.0}")
  @hint("Shell particle / shield colour")
  @widget(new ColorWidget())
  colorShell: vec4

  @input
  @hint("Volume of the energy hum while a sphere is held")
  @widget(new SliderWidget(0, 1, 0.05))
  humVolume: number = 0.5
  @ui.group_end

  readonly powerId = PowerId.EnergySphere

  private vfxRoot: SceneObject | null = null
  private core: SphereVisual | null = null
  private body: SphereVisual | null = null
  private shell: QuadBatch | null = null
  private glows: QuadBatch | null = null
  private rings: QuadBatch | null = null
  private motes: QuadBatch | null = null
  private motePool = new ParticlePool(120)
  private hum: SfxEmitter | null = null
  private humHost: SceneObject | null = null
  private probe: SurfaceProbe | null = null
  private waves: Wave[] = []
  private impacts: Impact[] = []
  private presence = 0
  private radius = 6
  private spinAngle = 0
  private compress = 0
  private centre: vec3 = vec3.zero()
  private shieldAmt: Record<HandSide, number> = { left: 0, right: 0 }
  private palmGlow: Record<HandSide, number> = { left: 0, right: 0 }
  private time = 0
  private built = false

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("EnergyVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    const white = new vec4(1, 1, 1, 1)
    this.core = new SphereVisual(this.vfxRoot, "Core", ctx, this.colorCore)
    this.body = new SphereVisual(this.vfxRoot, "Body", ctx, this.colorBody)
    this.core.setVisible(false)
    this.body.setVisible(false)
    this.shell = new QuadBatch(this.vfxRoot, "Shell", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 100)
    this.glows = new QuadBatch(this.vfxRoot, "Glows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 24)
    this.rings = new QuadBatch(this.vfxRoot, "Rings", cloneGlowMaterial(ctx.glowMaterial, tex.ring, white), 16)
    this.motes = new QuadBatch(this.vfxRoot, "Motes", cloneGlowMaterial(ctx.glowMaterial, tex.spark, white), 120)
    this.humHost = global.scene.createSceneObject("HumSfx")
    this.humHost.setParent(this.vfxRoot)
    this.hum = new SfxEmitter(this.humHost, MagicSfx.energyHum, this.humVolume, false)
    this.probe = new SurfaceProbe()
    this.built = true
  }

  protected onActivate(): void {
    this.ensureBuilt()
    if (this.vfxRoot) this.vfxRoot.enabled = true
  }

  protected onDeactivate(): void {
    if (this.hum) this.hum.stop(true)
    this.presence = 0
    this.motePool.clear()
    this.impacts.length = 0
    for (const w of this.waves) this.destroyWave(w)
    this.waves.length = 0
    if (this.core) this.core.setVisible(false)
    if (this.body) this.body.setVisible(false)
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  // ── Gestures ────────────────────────────────────────────────────────────────

  onGesture(e: GestureEvent): void {
    if (!this.built) return
    switch (e.type) {
      case GestureType.Push:
        if (this.presence > 0.4) this.launch(e.direction)
        break
      case GestureType.PalmsFacingStart:
        playOneShotAt(this.ctx!.effectsRoot, MagicSfx.selectorOpen, e.position, 0.5)
        for (let i = 0; i < 12; i++) this.spawnMote(e.position, 1)
        break
      case GestureType.HandsTogether:
        if (this.presence > 0.3) for (let i = 0; i < 10; i++) this.spawnMote(this.centre, 0.8)
        break
      default:
        break
    }
  }

  private launch(dir: vec3): void {
    const ctx = this.ctx!
    const look = ctx.camera.back
    let d = dir.uniformScale(0.6).add(look.uniformScale(0.4))
    if (d.length < 1e-3) d = look
    d = d.normalize()
    const host = global.scene.createSceneObject("EnergyWave")
    host.setParent(this.vfxRoot!)
    host.getTransform().setWorldPosition(this.centre)
    const core = new SphereVisual(host, "WaveCore", ctx, this.colorCore)
    const body = new SphereVisual(host, "WaveBody", ctx, this.colorBody)
    const w: Wave = {
      pos: this.centre,
      vel: d.uniformScale(this.launchSpeed * (1 + 0.4 * this.compress)),
      radius: this.radius,
      age: 0,
      core,
      body,
      host,
      travelled: 0,
      hit: false,
      probing: false,
      seed: Math.random() * 100,
    }
    this.waves.push(w)
    if (this.waves.length > 3) this.destroyWave(this.waves.shift()!)
    playOneShotAt(ctx.effectsRoot, MagicSfx.energyLaunch, this.centre, 0.9)
    for (let i = 0; i < 20; i++) this.spawnMote(this.centre, 1.5, d.uniformScale(-80))
    this.presence = 0 // the sphere is gone; the hands need to re-form it
  }

  private destroyWave(w: Wave): void {
    w.core.destroy()
    w.body.destroy()
    if (!isNull(w.host)) w.host.destroy()
  }

  private burst(pos: vec3, normal: vec3, radius: number): void {
    this.impacts.push({ pos, normal, age: 0, size: radius * 3 })
    playOneShotAt(this.ctx!.effectsRoot, MagicSfx.energyImpact, pos, 0.9)
    const basis = perpendicularBasis(normal)
    for (let i = 0; i < 40; i++) {
      const a = randRange(0, Math.PI * 2)
      const spread = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
      this.motePool.spawn({
        pos,
        vel: spread.uniformScale(randRange(80, 220)).add(normal.uniformScale(randRange(10, 60))),
        life: randRange(0.4, 0.9),
        size: randRange(1.2, 2.6),
        sizeEnd: 0.1,
        color: Math.random() < 0.4 ? this.colorCore : this.colorShell,
        drag: 2,
        spin: randRange(-8, 8),
      })
    }
  }

  private spawnMote(at: vec3, scale: number, extraVel: vec3 = vec3.zero()): void {
    this.motePool.spawn({
      pos: at.add(randomUnitVector().uniformScale(randRange(0, 2))),
      vel: randomUnitVector().uniformScale(randRange(10, 40) * scale).add(extraVel),
      life: randRange(0.5, 1.2),
      size: randRange(0.7, 1.6) * scale,
      sizeEnd: 0.1,
      color: Math.random() < 0.3 ? this.colorCore : this.colorShell,
      drag: 1.2,
      turbulence: 30,
      spin: randRange(-6, 6),
    })
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    this.shell!.begin()
    this.glows!.begin()
    this.rings!.begin()
    this.motes!.begin()

    const conf = Math.min(left.confidence, right.confidence)
    const held = two.palmsFacing && (left.isOpen || left.openness > 0.4) && (right.isOpen || right.openness > 0.4) && conf > 0
    this.presence = approach(this.presence, held ? conf : 0, held ? 7 : 4, dt)

    // Size + compression follow the hands
    const targetRadius = clamp01((two.distance * this.radiusPerDistance - this.minRadiusCm) / (this.maxRadiusCm - this.minRadiusCm)) * (this.maxRadiusCm - this.minRadiusCm) + this.minRadiusCm
    if (held) {
      this.radius = approach(this.radius, targetRadius, 12, dt)
      this.centre = approachVec(this.centre, two.midpoint, 25, dt)
    }
    const compressRaw = clamp01(-two.spreadRate / 90) // 1 when hands come together fast
    const expandRaw = clamp01(two.spreadRate / 90)
    this.compress = approach(this.compress, held ? compressRaw - expandRaw : 0, 8, dt)
    const smallness = clamp01(1 - (this.radius - this.minRadiusCm) / (this.maxRadiusCm - this.minRadiusCm))
    const bright = (1 + smallness * 0.8 + Math.max(0, this.compress) * this.compressBrightness) * this.presence
    const spin = this.spinSpeed * (1 + smallness * 2 + Math.max(0, this.compress) * 3)
    this.spinAngle += spin * dt

    const stretch = two.distance > this.maxRadiusCm / this.radiusPerDistance ? clamp01((two.distance * this.radiusPerDistance - this.maxRadiusCm) / this.maxRadiusCm) : 0

    this.core!.setVisible(this.presence > 0.02)
    this.body!.setVisible(this.presence > 0.02)
    if (this.presence > 0.02) {
      const p = this.presence
      const r = this.radius * p
      const pulse = 1 + 0.05 * Math.sin(this.time * (6 + spin * 2))
      this.core!.setPosition(this.centre)
      this.body!.setPosition(this.centre)
      this.core!.setRadius(r * (0.38 + 0.12 * Math.max(0, this.compress)) * pulse)
      this.body!.setRadius(r * pulse)
      this.core!.setColor(tint(this.colorCore, Math.min(2.5, bright), 0.95 * p))
      this.body!.setColor(tint(this.colorBody, Math.min(1.8, 0.6 * bright), 0.12 * p))
      // beam stretch: when the hands pull wide the body elongates along the hand axis
      if (stretch > 0.01) {
        const s = this.body!.obj.getTransform().getWorldScale()
        const rot = quat.lookAt(two.axis, vec3.up())
        this.body!.obj.getTransform().setWorldRotation(rot)
        this.body!.obj.getTransform().setWorldScale(new vec3(s.x, s.y, s.z * (1 + stretch * 2.5)))
      } else {
        this.body!.obj.getTransform().setWorldRotation(quat.quatIdentity())
      }
      this.glows!.quad(this.centre, cam.right, cam.up, r * 1.8, r * 1.8, tint(this.colorBody, 1, 0.5 * p * Math.min(1.5, bright)))
      this.glows!.quad(this.centre, cam.right, cam.up, r * 1.1, r * 1.1, tint(this.colorCore, 1, 0.6 * p))

      // orbiting particle shell (two tilted rings + scattered motes)
      const basis = perpendicularBasis(two.axis)
      const n = this.shellParticles
      for (let i = 0; i < n; i++) {
        const ring = i % 3
        const a = this.spinAngle * (ring === 0 ? 1 : ring === 1 ? -0.8 : 1.3) + i * 2.399
        const tiltA = ring * 1.1
        const rr = r * (1.08 + 0.12 * flickerNoise(i, 7, this.time, 4))
        const ca = Math.cos(a) * rr
        const sa = Math.sin(a) * rr
        const px = basis.n1.uniformScale(ca)
        const py = basis.n2.uniformScale(sa * Math.cos(tiltA)).add(two.axis.uniformScale(sa * Math.sin(tiltA)))
        const pos = this.centre.add(px).add(py)
        const sz = (0.6 + 0.5 * smallness) * p * (0.7 + 0.3 * Math.sin(a * 3))
        this.shell!.quad(pos, cam.right, cam.up, sz, sz, tint(i % 4 === 0 ? this.colorCore : this.colorShell, 1, 0.8 * p))
      }
      if (Math.random() < 25 * p * dt) this.spawnMote(this.centre.add(randomUnitVector().uniformScale(r)), 0.9)
      if (this.humHost) this.humHost.getTransform().setWorldPosition(this.centre)
    }
    if (this.hum) {
      this.hum.setLevel(this.presence * (0.6 + 0.4 * Math.min(1.5, bright)))
      if (this.presence > 0.05) this.hum.playIfSilent(-1)
      else if (this.hum.isPlaying && this.presence < 0.02) this.hum.stop(true)
      this.hum.update(dt)
    }

    // Palm glows (immediate feedback for a tracked hand) + shields
    this.updatePalm(left, right, cam, dt)
    this.updatePalm(right, left, cam, dt)

    this.updateWaves(dt, cam)
    this.updateImpacts(dt, cam)

    this.motePool.update(dt, this.time)
    this.motePool.draw(this.motes!, cam.right, cam.up, 1)

    this.shell!.end()
    this.glows!.end()
    this.rings!.end()
    this.motes!.end()
  }

  private updatePalm(pose: HandPose, other: HandPose, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }, dt: number): void {
    const side = pose.side
    const live = pose.tracked && pose.confidence > 0
    this.palmGlow[side] = approach(this.palmGlow[side], live ? pose.confidence : 0, 8, dt)
    const g = this.palmGlow[side] * (1 - this.presence * 0.7)
    if (g > 0.02) {
      const p = pose.palmCenter.add(pose.palmNormal.uniformScale(1.5))
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 4 + (side === "left" ? 0 : 1.5))
      this.glows!.quad(p, cam.right, cam.up, 4 * g * pulse, 4 * g * pulse, tint(this.colorShell, 1, 0.45 * g))
    }
    // Shield: open palm facing away from the user while the other hand is not forming a sphere
    const facingAway = pose.palmNormal.dot(cam.look) > 0.55
    const wantShield = this.shieldEnabled && live && pose.isOpen && facingAway && this.presence < 0.3
    this.shieldAmt[side] = approach(this.shieldAmt[side], wantShield ? pose.confidence : 0, wantShield ? 8 : 5, dt)
    const s = this.shieldAmt[side]
    if (s > 0.02) {
      const centre = pose.palmCenter.add(pose.palmNormal.uniformScale(7))
      const basis = perpendicularBasis(pose.palmNormal)
      const r = this.shieldRadiusCm * (0.5 + 0.5 * s)
      const wobble = 1 + 0.03 * Math.sin(this.time * 7)
      this.rings!.quad(centre, basis.n1, basis.n2, r * wobble, r * wobble, tint(this.colorShell, 1, 0.8 * s))
      this.rings!.quad(centre, basis.n1, basis.n2, r * 0.72, r * 0.72, tint(this.colorBody, 1, 0.5 * s))
      this.glows!.quad(centre, basis.n1, basis.n2, r * 0.9, r * 0.9, tint(this.colorBody, 1, 0.3 * s))
      for (let i = 0; i < 10; i++) {
        const a = this.time * 1.5 + i * 0.628
        const pos = centre.add(basis.n1.uniformScale(Math.cos(a) * r * 0.9)).add(basis.n2.uniformScale(Math.sin(a) * r * 0.9))
        this.shell!.quad(pos, cam.right, cam.up, 0.9 * s, 0.9 * s, tint(this.colorCore, 1, 0.7 * s))
      }
    }
  }

  private updateWaves(dt: number, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]
      if (w.hit) {
        this.destroyWave(w)
        this.waves.splice(i, 1)
        continue
      }
      w.age += dt
      const prev = w.pos
      w.pos = w.pos.add(w.vel.uniformScale(dt))
      w.travelled += w.vel.length * dt
      w.radius *= Math.pow(this.waveGrowth, dt)
      w.host.getTransform().setWorldPosition(w.pos)
      w.core.setPosition(w.pos)
      w.body.setPosition(w.pos)
      w.core.setRadius(w.radius * 0.4)
      w.body.setRadius(w.radius)
      w.core.setColor(this.colorCore)
      w.body.setColor(tint(this.colorBody, 1, 0.35))
      const dir = w.vel.normalize()
      this.glows!.quad(w.pos, cam.right, cam.up, w.radius * 2.4, w.radius * 2.4, tint(this.colorBody, 1, 0.55))
      // trailing ring pulses
      const basis = perpendicularBasis(dir)
      for (let k = 0; k < 3; k++) {
        const back = w.pos.sub(dir.uniformScale(w.radius * (0.8 + k * 1.1)))
        const rr = w.radius * (1.1 + k * 0.35)
        this.rings!.quad(back, basis.n1, basis.n2, rr, rr, tint(this.colorShell, 1, 0.5 - k * 0.14))
      }
      if (Math.random() < 60 * dt) this.spawnMote(w.pos.sub(dir.uniformScale(w.radius)), 1, dir.uniformScale(-40))

      if (w.travelled >= this.maxRangeCm || w.pos.y < cam.pos.y - 170) {
        this.burst(w.pos, vec3.up(), w.radius)
        w.hit = true
        continue
      }
      if (this.probe && this.probe.isAvailable && !w.probing) {
        w.probing = true
        const ahead = w.pos.add(w.vel.uniformScale(dt * 3 + 0.02)).add(dir.uniformScale(w.radius))
        this.probe.probe(prev, ahead, (hit) => {
          w.probing = false
          if (hit && !w.hit) {
            this.burst(hit.position, hit.normal, w.radius)
            w.hit = true
          }
        })
      }
    }
  }

  private updateImpacts(dt: number, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i]
      im.age += dt
      const t = im.age / 0.7
      if (t >= 1) {
        this.impacts.splice(i, 1)
        continue
      }
      const basis = perpendicularBasis(im.normal)
      const fade = (1 - t) * (1 - t)
      const r1 = im.size * smoothstep(0, 1, t)
      const r2 = im.size * 0.6 * smoothstep(0, 1, clamp01(t * 1.4))
      this.rings!.quad(im.pos.add(im.normal.uniformScale(0.5)), basis.n1, basis.n2, r1, r1, tint(this.colorShell, 1, 0.9 * fade))
      this.rings!.quad(im.pos.add(im.normal.uniformScale(0.8)), basis.n1, basis.n2, r2, r2, tint(this.colorCore, 1, 0.8 * fade))
      this.glows!.quad(im.pos, cam.right, cam.up, im.size * (0.5 + t * 0.8), im.size * (0.5 + t * 0.8), tint(this.colorCore, 1, 0.9 * fade))
    }
  }
}
