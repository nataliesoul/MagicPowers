/**
 * MagicPowersLightningPower — Lightning magic: arcs between the palms, sparks at the fingertips, bolts.
 *
 * Owns: procedural jagged arcs (MeshBuilder ribbons rebuilt every frame with animated jitter),
 *       fingertip sparks on open hands, the point-to-shoot bolt (WorldQuery endpoint), the
 *       two-fist charged blast, and the spatial crackle loop between the hands.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager.
 * Must not: read SIK directly or decide which power is active.
 *
 * Gesture map:  open hand → sparks between the fingertips
 *               both hands within range → arcs between the palms (count/intensity scale with distance)
 *               spread apart → arcs stretch, thin and finally snap  ·  point → bolt along the finger
 *               both fists facing → charge a blast  ·  spread quickly → release the blast
 */

import { GestureEvent, GestureType, HandPose, HandSide, MagicPower, PowerId, TwoHandState } from "./MagicPowersTypes"
import {
  ParticlePool,
  QuadBatch,
  SurfaceProbe,
  approach,
  buildArc,
  cameraBasis,
  clamp01,
  cloneGlowMaterial,
  drawArc,
  flickerNoise,
  lerp,
  randRange,
  randomUnitVector,
  smoothstep,
  tint,
} from "./MagicPowersEffectsLib"
import { SfxEmitter, playOneShotAt } from "./MagicPowersAudioLib"
import { MagicSfx } from "./MagicPowersAssetManifest"

interface Bolt {
  from: vec3
  to: vec3
  age: number
  duration: number
  seed: number
  width: number
}

@component
export class MagicPowersLightningPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersLightningPower – arcs, sparks and bolts</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Arcs</span>')
  @ui.group_start("Arcs")
  @input
  @hint("Palm-to-palm distance (cm) above which the arcs snap and vanish")
  @widget(new SliderWidget(20, 120, 1))
  arcMaxDistanceCm: number = 65

  @input
  @hint("Maximum simultaneous arcs between the palms (closest distance)")
  @widget(new SliderWidget(1, 8, 1))
  maxArcs: number = 5

  @input
  @hint("Segments per arc — more = finer jaggedness, more vertices")
  @widget(new SliderWidget(6, 24, 1))
  arcSegments: number = 14

  @input
  @hint("Jitter amplitude as a fraction of the arc length")
  @widget(new SliderWidget(0.02, 0.4, 0.01))
  jitterFraction: number = 0.16

  @input
  @hint("How many times per second each arc re-rolls its shape")
  @widget(new SliderWidget(4, 60, 1))
  flickerHz: number = 24

  @input
  @hint("Width (cm) of the bright white core ribbon")
  @widget(new SliderWidget(0.2, 2, 0.05))
  coreWidthCm: number = 0.6

  @input
  @hint("Width (cm) of the soft coloured glow ribbon")
  @widget(new SliderWidget(0.5, 6, 0.1))
  glowWidthCm: number = 3.2
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Bolt &amp; blast</span>')
  @ui.group_start("Bolt & blast")
  @input
  @hint("How far (cm) a pointed bolt travels when nothing is hit")
  @widget(new SliderWidget(100, 1500, 10))
  boltRangeCm: number = 500

  @input
  @hint("Seconds a bolt stays visible")
  @widget(new SliderWidget(0.05, 0.6, 0.01))
  boltDurationSec: number = 0.18

  @input
  @hint("Seconds of two facing fists needed for a full blast charge")
  @widget(new SliderWidget(0.3, 4, 0.1))
  blastChargeSec: number = 1.5

  @input
  @hint("Number of radial bolts released by a full blast")
  @widget(new SliderWidget(2, 16, 1))
  blastBolts: number = 10
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input("vec4", "{1.0, 1.0, 1.0, 1.0}")
  @hint("Arc core colour")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{0.4, 0.85, 1.0, 1.0}")
  @hint("Arc glow / spark colour")
  @widget(new ColorWidget())
  colorGlow: vec4

  @input
  @hint("Show tiny arcs between the fingertips of an open hand")
  fingertipSparks: boolean = true

  @input
  @hint("Volume of the crackle loop between the hands")
  @widget(new SliderWidget(0, 1, 0.05))
  crackleVolume: number = 0.6
  @ui.group_end

  readonly powerId = PowerId.Lightning

  private vfxRoot: SceneObject | null = null
  private glowRibbons: QuadBatch | null = null
  private coreRibbons: QuadBatch | null = null
  private sparks: QuadBatch | null = null
  private glows: QuadBatch | null = null
  private sparkPool = new ParticlePool(90)
  private crackle: SfxEmitter | null = null
  private crackleHost: SceneObject | null = null
  private probe: SurfaceProbe | null = null
  private bolts: Bolt[] = []
  private arcIntensity = 0
  private blastCharge = 0
  private blastVis = 0
  private time = 0
  private built = false
  private scratch: vec3[] = []

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("LightningVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    const white = new vec4(1, 1, 1, 1)
    this.glowRibbons = new QuadBatch(this.vfxRoot, "ArcGlow", cloneGlowMaterial(ctx.glowMaterial, tex.beam, white), 420)
    this.coreRibbons = new QuadBatch(this.vfxRoot, "ArcCore", cloneGlowMaterial(ctx.glowMaterial, tex.beam, white), 420)
    this.sparks = new QuadBatch(this.vfxRoot, "Sparks", cloneGlowMaterial(ctx.glowMaterial, tex.spark, white), 90)
    this.glows = new QuadBatch(this.vfxRoot, "Glows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 24)
    this.crackleHost = global.scene.createSceneObject("CrackleSfx")
    this.crackleHost.setParent(this.vfxRoot)
    this.crackle = new SfxEmitter(this.crackleHost, MagicSfx.lightningCrackle, this.crackleVolume, false)
    this.probe = new SurfaceProbe()
    this.built = true
  }

  protected onActivate(): void {
    this.ensureBuilt()
    if (this.vfxRoot) this.vfxRoot.enabled = true
  }

  protected onDeactivate(): void {
    if (this.crackle) this.crackle.stop(true)
    this.sparkPool.clear()
    this.bolts.length = 0
    this.arcIntensity = 0
    this.blastCharge = 0
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  // ── Gestures ────────────────────────────────────────────────────────────────

  onGesture(e: GestureEvent): void {
    if (!this.built) return
    switch (e.type) {
      case GestureType.Point:
        this.fireBolt(e.position, e.direction)
        break
      case GestureType.HandsSpread:
        if (this.blastCharge > 0.35) this.releaseBlast(e.position)
        break
      case GestureType.OpenPalm:
        // immediate feedback: a burst of fingertip sparks
        for (let i = 0; i < 8; i++) this.spawnSpark(e.position.add(randomUnitVector().uniformScale(4)), 1)
        break
      default:
        break
    }
  }

  private fireBolt(from: vec3, dir: vec3): void {
    const ctx = this.ctx!
    const d = dir.normalize()
    const fallbackEnd = from.add(d.uniformScale(this.boltRangeCm))
    const spawn = (end: vec3) => {
      this.bolts.push({ from, to: end, age: 0, duration: this.boltDurationSec, seed: Math.random() * 100, width: 1 })
      playOneShotAt(ctx.effectsRoot, MagicSfx.lightningBolt, from, 0.9)
      for (let i = 0; i < 18; i++) this.spawnSpark(end, 2.2)
      for (let i = 0; i < 6; i++) this.spawnSpark(from, 1)
    }
    if (this.probe && this.probe.isAvailable) {
      this.probe.probe(from, fallbackEnd, (hit) => spawn(hit ? hit.position : fallbackEnd))
    } else spawn(fallbackEnd)
  }

  private releaseBlast(centre: vec3): void {
    const ctx = this.ctx!
    const charge = this.blastCharge
    this.blastCharge = 0
    const n = Math.max(2, Math.round(this.blastBolts * charge))
    for (let i = 0; i < n; i++) {
      const d = randomUnitVector()
      this.bolts.push({ from: centre, to: centre.add(d.uniformScale(lerp(60, 220, charge))), age: 0, duration: 0.28, seed: Math.random() * 100, width: 1.4 })
    }
    for (let i = 0; i < 40; i++) this.spawnSpark(centre, 2.5)
    playOneShotAt(ctx.effectsRoot, MagicSfx.lightningBolt, centre, 1)
  }

  private spawnSpark(at: vec3, scale: number): void {
    this.sparkPool.spawn({
      pos: at,
      vel: randomUnitVector().uniformScale(randRange(40, 140) * scale),
      life: randRange(0.15, 0.4),
      size: randRange(0.8, 1.8) * scale,
      sizeEnd: 0.1,
      color: Math.random() < 0.5 ? this.colorCore : this.colorGlow,
      drag: 3,
      gravity: 80,
      spin: randRange(-10, 10),
    })
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    this.glowRibbons!.begin()
    this.coreRibbons!.begin()
    this.sparks!.begin()
    this.glows!.begin()

    // Palm-to-palm arcs
    const bothVisible = left.tracked && right.tracked && left.confidence > 0 && right.confidence > 0
    const inRange = bothVisible && two.distance < this.arcMaxDistanceCm && two.distance > 4
    const closeness = inRange ? clamp01(1 - two.distance / this.arcMaxDistanceCm) : 0
    const conf = Math.min(left.confidence, right.confidence)
    this.arcIntensity = approach(this.arcIntensity, inRange ? (0.25 + 0.75 * closeness) * conf : 0, inRange ? 10 : 6, dt)
    if (this.arcIntensity > 0.02) {
      const a = left.palmCenter.add(left.palmNormal.uniformScale(2))
      const b = right.palmCenter.add(right.palmNormal.uniformScale(2))
      const len = a.distance(b)
      const arcs = Math.max(1, Math.round(this.maxArcs * (0.3 + 0.7 * closeness)))
      const stretch = clamp01((two.distance - this.arcMaxDistanceCm * 0.6) / (this.arcMaxDistanceCm * 0.4)) // 0 close .. 1 about to snap
      for (let i = 0; i < arcs; i++) {
        // stretched arcs flicker in and out before snapping
        const flick = flickerNoise(i + 40, 3, this.time, 12)
        if (stretch > 0.4 && flick < lerp(-1, 0.6, stretch)) continue
        const amp = len * this.jitterFraction * (0.6 + 0.4 * flickerNoise(i, 9, this.time, 3)) * (1 - stretch * 0.5)
        buildArc(a, b, this.arcSegments, amp, i * 13.7 + 1, this.time, this.flickerHz, this.scratch)
        const thick = (i === 0 ? 1 : 0.65) * this.arcIntensity * (1 - stretch * 0.5)
        drawArc(this.scratch, this.glowRibbons!, this.coreRibbons!, this.glowWidthCm * thick, this.coreWidthCm * thick, tint(this.colorGlow, 1, 0.7 * this.arcIntensity), tint(this.colorCore, 1, 0.95 * this.arcIntensity), cam.pos)
      }
      // palm glows + random sparks
      this.glows!.quad(a, cam.right, cam.up, 5 * this.arcIntensity, 5 * this.arcIntensity, tint(this.colorGlow, 1, 0.7 * this.arcIntensity))
      this.glows!.quad(b, cam.right, cam.up, 5 * this.arcIntensity, 5 * this.arcIntensity, tint(this.colorGlow, 1, 0.7 * this.arcIntensity))
      if (Math.random() < 30 * this.arcIntensity * dt) this.spawnSpark(vec3.lerp(a, b, Math.random()), 1)
      if (this.crackleHost) this.crackleHost.getTransform().setWorldPosition(two.midpoint)
    }
    if (this.crackle) {
      this.crackle.setLevel(this.arcIntensity + this.blastVis * 0.8)
      if (this.arcIntensity > 0.05 || this.blastVis > 0.05) this.crackle.playIfSilent(-1)
      else if (this.crackle.isPlaying && this.arcIntensity < 0.02 && this.blastVis < 0.02) this.crackle.stop(true)
      this.crackle.update(dt)
    }

    // Blast charge: both fists facing each other
    const charging = two.palmsFacing && left.isFist && right.isFist && conf > 0.5
    this.blastCharge = charging ? clamp01(this.blastCharge + dt / this.blastChargeSec) : Math.max(0, this.blastCharge - dt * 0.8)
    this.blastVis = approach(this.blastVis, charging ? this.blastCharge : 0, 8, dt)
    if (this.blastVis > 0.02) this.drawBlastBall(two, cam, dt)

    // Fingertip sparks on open hands (single-hand feedback)
    if (this.fingertipSparks) {
      this.drawFingertipArcs(left, cam)
      this.drawFingertipArcs(right, cam)
    }

    // Bolts
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i]
      bolt.age += dt
      const t = bolt.age / bolt.duration
      if (t >= 1) {
        this.bolts.splice(i, 1)
        continue
      }
      const fade = 1 - t * t
      const len = bolt.from.distance(bolt.to)
      buildArc(bolt.from, bolt.to, Math.max(8, Math.round(len / 12)), len * 0.05 * (1 + 0.5 * t), bolt.seed, this.time, 40, this.scratch)
      drawArc(this.scratch, this.glowRibbons!, this.coreRibbons!, this.glowWidthCm * 1.8 * bolt.width * fade, this.coreWidthCm * 1.6 * bolt.width * fade, tint(this.colorGlow, 1, 0.9 * fade), tint(this.colorCore, 1, fade), cam.pos)
      this.glows!.quad(bolt.to, cam.right, cam.up, 10 * fade, 10 * fade, tint(this.colorCore, 1, 0.9 * fade))
      this.glows!.quad(bolt.from, cam.right, cam.up, 5 * fade, 5 * fade, tint(this.colorGlow, 1, 0.8 * fade))
    }

    this.sparkPool.update(dt, this.time)
    this.sparkPool.draw(this.sparks!, cam.right, cam.up, 1)

    this.glowRibbons!.end()
    this.coreRibbons!.end()
    this.sparks!.end()
    this.glows!.end()
  }

  private drawFingertipArcs(pose: HandPose, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }): void {
    if (!pose.tracked || pose.confidence <= 0 || !pose.isOpen) return
    const amt = pose.confidence * (1 - this.arcIntensity * 0.6)
    if (amt <= 0.02) return
    const seedBase = pose.side === "left" ? 200 : 300
    for (let i = 0; i < 4; i++) {
      // each adjacent pair flickers on/off independently
      const on = flickerNoise(i + 1, seedBase, this.time, 8) > -0.2
      if (!on) continue
      const a = pose.fingertips[i]
      const b = pose.fingertips[i + 1]
      buildArc(a, b, 6, a.distance(b) * 0.25, seedBase + i * 3.1, this.time, this.flickerHz, this.scratch)
      drawArc(this.scratch, this.glowRibbons!, this.coreRibbons!, 1.6 * amt, 0.45 * amt, tint(this.colorGlow, 1, 0.8 * amt), tint(this.colorCore, 1, amt), cam.pos)
    }
    // palm → index arc keeps the "electricity in the hand" alive
    const centre = pose.palmCenter.add(pose.palmNormal.uniformScale(1.5))
    if (flickerNoise(9, seedBase, this.time, 5) > 0.1) {
      buildArc(centre, pose.fingertips[2], 6, 2.5, seedBase + 77, this.time, this.flickerHz, this.scratch)
      drawArc(this.scratch, this.glowRibbons!, this.coreRibbons!, 1.8 * amt, 0.5 * amt, tint(this.colorGlow, 1, 0.8 * amt), tint(this.colorCore, 1, amt), cam.pos)
    }
    this.glows!.quad(centre, cam.right, cam.up, 3.5 * amt, 3.5 * amt, tint(this.colorGlow, 1, 0.35 * amt))
    for (let i = 0; i < 5; i++) {
      const s = 0.5 + 0.5 * flickerNoise(i + 20, seedBase, this.time, 10)
      this.sparks!.quadRotated(pose.fingertips[i], cam.right, cam.up, 0.5 * s * amt, 1.2 * s * amt, tint(this.colorCore, 1, 0.8 * s * amt), this.time * 3 + i)
    }
  }

  private drawBlastBall(two: TwoHandState, cam: { pos: vec3; right: vec3; up: vec3; look: vec3 }, dt: number): void {
    const v = this.blastVis
    const centre = two.midpoint
    const radius = lerp(3, Math.max(5, two.distance * 0.35), v)
    const arcs = Math.floor(3 + 7 * v)
    for (let i = 0; i < arcs; i++) {
      const p0 = centre.add(randomUnitVector().uniformScale(radius))
      const p1 = centre.add(randomUnitVector().uniformScale(radius))
      buildArc(p0, p1, 8, radius * 0.4, i * 5.3 + 500, this.time, this.flickerHz, this.scratch)
      drawArc(this.scratch, this.glowRibbons!, this.coreRibbons!, this.glowWidthCm * v, this.coreWidthCm * v, tint(this.colorGlow, 1, 0.8 * v), tint(this.colorCore, 1, v), cam.pos)
    }
    const pulse = 1 + 0.1 * Math.sin(this.time * 20 * v)
    this.glows!.quad(centre, cam.right, cam.up, radius * 2.5 * pulse, radius * 2.5 * pulse, tint(this.colorGlow, 1, 0.8 * v))
    this.glows!.quad(centre, cam.right, cam.up, radius * 1.1 * pulse, radius * 1.1 * pulse, tint(this.colorCore, 1, 0.9 * v))
    if (Math.random() < 40 * v * dt) this.spawnSpark(centre.add(randomUnitVector().uniformScale(radius)), 1.3)
    if (this.crackleHost) this.crackleHost.getTransform().setWorldPosition(centre)
  }
}
