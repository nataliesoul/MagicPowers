/**
 * MagicPowersCaster — the one casting grammar every element shares.
 *
 * Owns: the orb that forms between two facing palms (it charges while held and takes the look of the
 *       active element), the aim reticle painted on whatever real surface — or tracked person — the
 *       wearer is looking at, the two-hand thrust that releases the orb, and its flight to the target.
 * Expects: update() once per frame between canvas.begin()/end(); onGesture() for push events.
 * Must not: decide what a landed cast becomes — it reports onImpact and the orchestrator routes it.
 *
 * Grammar:  hold both palms facing each other  → the orb forms and charges
 *           look at a floor, wall or person     → the reticle shows exactly where it will land
 *           push both hands forward             → the orb flies there
 * The reticle is the truth: a released orb always arrives where the reticle was, so aiming is
 * learnable in one cast.
 */

import { BodyAnchor, CastImpact, ELEMENT_PALETTES, EffectsContext, ElementPalette, GestureEvent, GestureType, HandPose, OrbState, PowerId, TwoHandState } from "./MagicPowersTypes"
import { CamBasis, FxCanvas, SphereVisual, SurfaceProbe, approach, approachVec, bezier, clamp01, flickerNoise, hash1, lerp, perpendicularBasis, randRange, randomUnitVector, sideAxisFor, tint } from "./MagicPowersEffectsLib"
import { playOneShotAt } from "./MagicPowersAudioLib"
import { MagicSfx } from "./MagicPowersAssetManifest"
import { classifySurface } from "./MagicPowersWorldMagic"

export interface CasterOptions {
  /** Seconds of holding for a full charge. */
  chargeSec: number
  /** Mean palm speed (cm/s) that releases the orb. */
  thrustSpeed: number
  /** Charge (0..1) needed before a thrust releases. */
  minCharge: number
  /** Orb flight speed (cm/s). */
  flightSpeed: number
  /** How far (cm) the gaze reaches for a surface. */
  aimRangeCm: number
  /** Editor only: height (cm) of a stand-in floor below the starting head height when there is no world mesh. */
  floorDropCm: number
}

interface Target {
  pos: vec3
  normal: vec3
  person: boolean
}

interface Shot {
  element: PowerId
  pal: ElementPalette
  guided: boolean
  from: vec3
  ctrl: vec3
  to: vec3
  normal: vec3
  person: boolean
  t: number
  dur: number
  pos: vec3
  prev: vec3
  vel: vec3
  power: number
  radius: number
  travelled: number
  probing: boolean
  done: boolean
  /** Another player's orb: drawn in flight, but its landing is theirs to report. */
  remote: boolean
  seed: number
}

export class TwoHandCaster {
  readonly orb: OrbState
  /** Fired when an orb is released: (element, charge). */
  onLaunch: ((element: PowerId, power: number) => void) | null = null
  /** Fired when a released orb reaches a surface or a person. */
  onImpact: ((hit: CastImpact) => void) | null = null
  /** Fired when THIS player releases an orb, with its flight (multiplayer shows it to the others). */
  onShot: ((element: PowerId, from: vec3, to: vec3, normal: vec3, power: number) => void) | null = null

  private root: SceneObject
  private core: SphereVisual
  private shell: SphereVisual
  private probe: SurfaceProbe
  private body: BodyAnchor | null = null
  private shots: Shot[] = []
  /** Orbs other players are holding right now, by player. */
  private remoteOrbs: { [player: string]: { element: PowerId; centre: vec3; shown: vec3; radius: number; charge: number; seenAt: number; presence: number } } = {}
  private aim: Target = { pos: vec3.zero(), normal: vec3.up(), person: false }
  private aimValid = false
  private aimShown = 0
  private rawSurface: { pos: vec3; normal: vec3 } | null = null
  private surfaceMisses = 0
  private aimProbing = false
  private aimProbeAt = 0
  private grace = 0
  private cooldown = 0
  private thrustFrames = 0
  private formed = false
  private full = false
  private floorY: number | null = null
  private readonly editorFloor: boolean
  private time = 0
  private torn = false
  private lastElement: PowerId = PowerId.Fireball

  constructor(private ctx: EffectsContext, private canvas: FxCanvas, private opts: CasterOptions) {
    this.orb = ctx.orb
    this.root = global.scene.createSceneObject("TwoHandOrb")
    this.root.setParent(canvas.root)
    this.core = new SphereVisual(this.root, "OrbCore", ctx, new vec4(1, 1, 1, 1))
    this.shell = new SphereVisual(this.root, "OrbShell", ctx, new vec4(1, 1, 1, 1))
    this.core.setVisible(false)
    this.shell.setVisible(false)
    this.probe = new SurfaceProbe()
    this.editorFloor = global.deviceInfoSystem.isEditor()
  }

  setBody(body: BodyAnchor | null): void {
    this.body = body
  }

  /** True while the reticle sits on a tracked person. */
  get aimingAtPerson(): boolean {
    return this.aimValid && this.aim.person && this.aimShown > 0.3
  }

  /** True while the reticle has found something to land on. */
  get hasTarget(): boolean {
    return this.aimValid
  }

  destroy(): void {
    this.torn = true
    this.probe.destroy()
  }

  /** A single-hand push while the orb is held also releases it (palms turned forward mid-thrust). */
  onGesture(e: GestureEvent, cam: CamBasis): void {
    if (e.type !== GestureType.Push || this.orb.presence < 0.45 || this.orb.charge < this.opts.minCharge) return
    const away = this.orb.centre.sub(cam.pos).normalize()
    if (e.direction.dot(away) > 0.25) this.launch(this.lastElement, cam)
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  update(dt: number, left: HandPose, right: HandPose, two: TwoHandState, element: PowerId, allow: boolean, cam: CamBasis): void {
    this.time += dt
    this.lastElement = element
    if (this.floorY === null) this.floorY = cam.pos.y - this.opts.floorDropCm
    this.cooldown = Math.max(0, this.cooldown - dt)
    const pal = ELEMENT_PALETTES[element]
    const orb = this.orb
    const conf = Math.min(left.confidence, right.confidence)

    const posed = allow && two.bothTracked && two.palmsFacing && two.distance > 6 && left.openness > 0.45 && right.openness > 0.45 && !left.isPalmUp && !right.isPalmUp
    // Turning the palms forward mid-thrust breaks the pose for a moment; a short grace keeps the orb.
    this.grace = posed ? 0.3 : Math.max(0, this.grace - dt)
    const holding = this.cooldown <= 0 && conf > 0 && (posed || (this.grace > 0 && allow && two.bothTracked && orb.presence > 0.3))

    const was = orb.presence
    orb.presence = approach(was, holding ? conf : 0, holding ? 7 : 5, dt)
    if (holding) {
      if (!this.formed) {
        this.formed = true
        this.full = false
        orb.centre = two.midpoint
        orb.radius = 2
        playOneShotAt(this.ctx.effectsRoot, MagicSfx.selectorOpen, two.midpoint, 0.45)
        this.puff(two.midpoint, pal, 12, 30)
      }
      orb.charge = clamp01(orb.charge + dt / this.opts.chargeSec)
      if (orb.charge >= 1 && !this.full) {
        this.full = true
        playOneShotAt(this.ctx.effectsRoot, MagicSfx.spellSelect, orb.centre, 0.5)
        this.puff(orb.centre, pal, 16, 45)
      }
      const targetR = Math.max(3.5, Math.min(12, two.distance * 0.3)) * (0.65 + 0.35 * orb.charge)
      orb.radius = approach(orb.radius, targetR, 12, dt)
      orb.centre = approachVec(orb.centre, two.midpoint, 25, dt)
    } else if (orb.presence < 0.05 && this.formed) {
      this.formed = false
      if (orb.charge > 0.2) this.puff(orb.centre, pal, 10, 20) // let go without casting: the orb dissolves
      orb.charge = 0
    }

    // Release: both hands driven the same way, away from the body, fast enough, for two frames.
    if (holding && orb.presence > 0.45 && orb.charge >= this.opts.minCharge) {
      const v = left.velocity.add(right.velocity).uniformScale(0.5)
      const speed = v.length
      const away = orb.centre.sub(cam.pos).normalize()
      const outward = speed > 1 ? v.dot(away) / speed : 0
      const together = left.velocity.dot(right.velocity) > 0
      this.thrustFrames = speed > this.opts.thrustSpeed && outward > 0.3 && together ? this.thrustFrames + 1 : 0
      if (this.thrustFrames >= 2) this.launch(element, cam)
    } else this.thrustFrames = 0

    this.updateAim(dt, cam, holding && orb.presence > 0.25)
    if (orb.presence > 0.02) this.drawOrb(element, pal, left, right, dt, cam)
    else {
      this.core.setVisible(false)
      this.shell.setVisible(false)
    }
    if (this.aimShown > 0.02 && orb.presence > 0.02) this.drawReticle(pal, cam)
    this.updateShots(dt, cam)
    this.drawRemoteOrbs(dt, cam)
  }

  // ── Aim ─────────────────────────────────────────────────────────────────────

  private floorHit(origin: vec3, look: vec3): { pos: vec3; normal: vec3 } | null {
    if (this.floorY === null || look.y > -0.05) return null
    const t = (this.floorY - origin.y) / look.y
    if (t < 20 || t > this.opts.aimRangeCm) return null
    return { pos: origin.add(look.uniformScale(t)), normal: vec3.up() }
  }

  private updateAim(dt: number, cam: CamBasis, active: boolean): void {
    if (active) {
      if (this.aimProbing && this.time - this.aimProbeAt > 0.5) this.aimProbing = false // a probe that never answered
      if (!this.aimProbing) {
        const origin = cam.pos
        const look = cam.look
        if (this.probe.isAvailable) {
          this.aimProbing = true
          this.aimProbeAt = this.time
          this.probe.probe(origin.add(look.uniformScale(20)), origin.add(look.uniformScale(this.opts.aimRangeCm)), (hit) => {
            this.aimProbing = false
            if (this.torn) return
            if (hit) {
              this.rawSurface = { pos: hit.position, normal: hit.normal }
              this.surfaceMisses = 0
            } else if (++this.surfaceMisses > 3) {
              this.rawSurface = this.editorFloor ? this.floorHit(origin, look) : null
            }
          })
        } else this.rawSurface = this.floorHit(origin, look)
      }
      // A tracked person in the line of sight wins over the wall behind them.
      const surf = this.rawSurface
      const bodyHit = this.body ? this.body.raycast(cam.pos, cam.look, this.opts.aimRangeCm) : null
      let target: Target | null = null
      if (bodyHit && (!surf || bodyHit.distance < surf.pos.distance(cam.pos) + 40)) target = { pos: bodyHit.position, normal: bodyHit.normal, person: true }
      else if (surf) target = { pos: surf.pos, normal: surf.normal, person: false }
      if (target) {
        if (!this.aimValid || this.aim.person !== target.person || this.aimShown < 0.05) this.aim = target
        else {
          this.aim.pos = approachVec(this.aim.pos, target.pos, 18, dt)
          const n = approachVec(this.aim.normal, target.normal, 12, dt)
          this.aim.normal = n.length > 1e-3 ? n.normalize() : target.normal
        }
      }
      this.aimValid = target !== null
    }
    this.aimShown = approach(this.aimShown, active && this.aimValid ? 1 : 0, 8, dt)
  }

  private drawReticle(pal: ElementPalette, cam: CamBasis): void {
    const c = this.canvas
    const s = this.aimShown * this.orb.presence
    const ch = this.orb.charge
    const n = this.aim.normal
    const basis = perpendicularBasis(n)
    const at = this.aim.pos.add(n.uniformScale(1))
    const R = lerp(9, 20, ch)
    const rot = this.time * 0.7
    const dirAt = (a: number): vec3 => basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
    c.glows.quad(at, basis.n1, basis.n2, R * 1.3, R * 1.3, tint(pal.main, 1, 0.16 * s))
    c.rings.quad(at, dirAt(rot), dirAt(rot + Math.PI / 2), R, R, tint(pal.main, 1, 0.6 * s))
    const beat = 1 + 0.12 * Math.sin(this.time * 6)
    c.rings.quad(at, basis.n1, basis.n2, R * 0.3 * beat, R * 0.3 * beat, tint(pal.core, 1, 0.75 * s))
    // four marks close in on the ring as the charge fills
    const rr = lerp(R * 1.9, R * 1.1, ch)
    for (let k = 0; k < 4; k++) {
      const ang = -rot + (k * Math.PI) / 2
      c.stars.quadRotated(at.add(dirAt(ang).uniformScale(rr)), cam.right, cam.up, 1.4 * s, 1.4 * s, tint(pal.core, 1, 0.85 * s), ang)
    }
    if (ch >= 1) {
      const w = (this.time * 1.4) % 1
      c.rings.quad(at, basis.n1, basis.n2, R * (1 + 0.5 * w), R * (1 + 0.5 * w), tint(pal.core, 1, 0.5 * s * (1 - w)))
    }
    // a faint run of light from the orb to the target shows the path it will take
    const from = this.orb.centre
    const ctrl = this.arcControl(from, this.aim.pos)
    for (let k = 0; k < 5; k++) {
      const f = (this.time * 0.8 + k / 5) % 1
      const a = Math.sin(f * Math.PI)
      c.glows.quad(bezier(from, ctrl, this.aim.pos, f), cam.right, cam.up, 1.1 * a, 1.1 * a, tint(pal.main, 1, 0.35 * s * a))
    }
  }

  private arcControl(from: vec3, to: vec3): vec3 {
    return from.add(to).uniformScale(0.5).add(vec3.up().uniformScale(from.distance(to) * 0.07))
  }

  // ── The orb in the hands ────────────────────────────────────────────────────

  private puff(at: vec3, pal: ElementPalette, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      this.canvas.motePool.spawn({ pos: at.add(randomUnitVector().uniformScale(randRange(0, 2))), vel: randomUnitVector().uniformScale(randRange(speed * 0.4, speed)), life: randRange(0.4, 0.9), size: randRange(0.8, 1.8), sizeEnd: 0.1, color: Math.random() < 0.3 ? pal.core : pal.main, drag: 1.5, turbulence: 25 })
    }
  }

  private drawOrb(element: PowerId, pal: ElementPalette, left: HandPose, right: HandPose, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const orb = this.orb
    const p = orb.presence
    const ch = orb.charge
    const t = this.time
    const centre = orb.centre
    const pulse = 1 + 0.05 * Math.sin(t * (6 + 8 * ch))
    const r = orb.radius * p * pulse
    this.core.setVisible(true)
    this.shell.setVisible(true)
    this.core.setPosition(centre)
    this.shell.setPosition(centre)
    // a heart in the element's own colour with a small hot centre (a white ball would hide the element)
    this.core.setRadius(r * 0.3)
    this.shell.setRadius(r)
    this.core.setColor(tint(pal.main, 1, 0.75 * p))
    this.shell.setColor(tint(pal.main, 0.8, 0.1 * p))
    c.glows.quad(centre, cam.right, cam.up, r * 2.2, r * 2.2, tint(pal.main, 1, (0.4 + 0.2 * ch) * p))
    c.glows.quad(centre, cam.right, cam.up, r * (0.55 + 0.25 * ch), r * (0.55 + 0.25 * ch), tint(pal.core, 1, 0.85 * p))
    // the palms glow with what they are holding
    for (const h of [left, right]) {
      if (h.confidence <= 0) continue
      c.glows.quad(h.palmCenter.add(h.palmNormal.uniformScale(1.5)), cam.right, cam.up, 4.5 * p, 4.5 * p, tint(pal.main, 1, 0.4 * p * h.confidence))
    }
    const up = vec3.up()
    switch (element) {
      case PowerId.Fireball: {
        // tongues sit round the equator, rising and swirling
        const basis = perpendicularBasis(up)
        for (let i = 0; i < 10; i++) {
          const a = t * 2.2 + i * ((Math.PI * 2) / 10)
          const n = flickerNoise(i + 300, 5, t, 10)
          const lift = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(a * 2 + t))
          const pos = centre.add(basis.n1.uniformScale(Math.cos(a) * r * 0.6)).add(basis.n2.uniformScale(Math.sin(a) * r * 0.6)).add(up.uniformScale(r * (lift - 0.5)))
          const axis = pos.sub(centre).normalize().uniformScale(0.3).add(up.uniformScale(0.7)).normalize()
          const h = r * (1.5 + 0.6 * n)
          c.flames.quad(pos.add(axis.uniformScale(h * 0.4)), sideAxisFor(axis, cam), axis, h * 0.32, h * 0.5, tint(i % 3 === 0 ? pal.core : pal.main, 1, 0.7 * p))
        }
        if (Math.random() < 50 * p * dt) c.motePool.spawn({ pos: centre.add(randomUnitVector().uniformScale(r)), vel: up.uniformScale(randRange(18, 40)).add(randomUnitVector().uniformScale(15)), life: randRange(0.5, 1.1), size: randRange(0.8, 1.7), sizeEnd: 0.15, color: Math.random() < 0.25 ? pal.core : pal.accent, drag: 0.6, gravity: -14, turbulence: 35 })
        break
      }
      case PowerId.Ice: {
        // snowflakes spiral in and facets grow as the charge fills
        for (let i = 0; i < 8; i++) {
          const a = t * (1.2 + 2 * ch) + i * 0.785
          const orbit = r + lerp(5, 1.2, ch)
          const pos = centre.add(cam.right.uniformScale(Math.cos(a) * orbit)).add(cam.up.uniformScale(Math.sin(a) * orbit * 0.8)).add(cam.look.uniformScale(Math.sin(a * 1.7) * orbit * 0.4))
          c.flakes.quadRotated(pos, cam.right, cam.up, 1.3 * p, 1.3 * p, tint(pal.core, 1, 0.8 * p), t * 2 + i)
        }
        const facets = Math.floor(2 + 6 * ch)
        for (let i = 0; i < facets; i++) {
          const a = t * 0.8 + i * 2.399
          const dir = cam.right.uniformScale(Math.cos(a)).add(cam.up.uniformScale(Math.sin(a) * 0.8)).add(cam.look.uniformScale(Math.sin(a * 1.9) * 0.4)).normalize()
          const len = r * (0.5 + 0.5 * ch)
          c.crystals.quad(centre.add(dir.uniformScale(r * 0.9 + len * 0.3)), sideAxisFor(dir, cam), dir, len * 0.22, len * 0.5, tint(pal.main, 1, 0.75 * p))
        }
        if (Math.random() < 18 * p * dt) c.motePool.spawn({ pos: centre.add(randomUnitVector().uniformScale(r)), vel: randomUnitVector().uniformScale(10), life: randRange(0.7, 1.4), size: randRange(0.5, 1.1), sizeEnd: 0.1, color: pal.core, drag: 1.2, gravity: 9, turbulence: 18 })
        break
      }
      case PowerId.Lightning: {
        // ball lightning: arcs skitter over the surface and leap to each palm
        const arcs = 3 + Math.floor(5 * ch)
        const step = Math.floor(t * 12)
        const onSphere = (k: number): vec3 => {
          const z = hash1(k * 3.3 + step * 0.71)
          const a = hash1(k * 7.1 + step * 1.37) * Math.PI
          const rr = Math.sqrt(Math.max(0, 1 - z * z))
          return centre.add(new vec3(rr * Math.cos(a), rr * Math.sin(a), z).uniformScale(r))
        }
        for (let i = 0; i < arcs; i++) c.arc(onSphere(i), onSphere(i + 20), 7, r * 0.4, i * 5.3 + 500, t, 2.6 * p, 0.55 * p, tint(pal.main, 1, 0.8 * p), tint(pal.core, 1, p), cam.pos)
        for (const h of [left, right]) {
          if (h.confidence <= 0.3) continue
          const from = h.palmCenter.add(h.palmNormal.uniformScale(1.5))
          const to = centre.add(from.sub(centre).normalize().uniformScale(r * 0.8))
          c.arc(from, to, 7, from.distance(to) * 0.18, h.side === "left" ? 61 : 83, t, 2.2 * p, 0.5 * p, tint(pal.main, 1, 0.7 * p), tint(pal.core, 1, 0.95 * p), cam.pos)
        }
        if (Math.random() < 30 * p * dt) c.sparkPool.spawn({ pos: centre.add(randomUnitVector().uniformScale(r)), vel: randomUnitVector().uniformScale(randRange(40, 120)), life: randRange(0.15, 0.35), size: randRange(0.8, 1.8), sizeEnd: 0.1, color: pal.core, drag: 3, gravity: 60 })
        break
      }
      case PowerId.EnergySphere: {
        // a shell of motes on three tilted orbits, faster and tighter as it charges
        for (let i = 0; i < 30; i++) {
          const ring = i % 3
          const a = t * (1.8 + 3 * ch) * (ring === 0 ? 1 : ring === 1 ? -0.8 : 1.3) + i * 2.399
          const tilt = ring * 1.1
          const rr = r * (1.08 + 0.12 * flickerNoise(i, 7, t, 4))
          const pos = centre.add(cam.right.uniformScale(Math.cos(a) * rr)).add(cam.up.uniformScale(Math.sin(a) * rr * Math.cos(tilt))).add(cam.look.uniformScale(Math.sin(a) * rr * Math.sin(tilt)))
          const sz = 0.8 * p * (0.7 + 0.3 * Math.sin(a * 3))
          c.motes.quad(pos, cam.right, cam.up, sz, sz, tint(i % 4 === 0 ? pal.core : pal.accent, 1, 0.8 * p))
        }
        break
      }
      case PowerId.Telekinesis: {
        // stars fall inwards along a spiral: a small well of gravity
        c.rings.quad(centre, cam.right, cam.up, r * 1.3, r * 1.3, tint(pal.main, 1, 0.7 * p))
        for (let k = 0; k < 14; k++) {
          const f = (t * 0.6 + k / 14) % 1
          const rr = r * (1.9 - 1.6 * f)
          const ang = k * 2.4 + f * 5
          const sz = 1.3 * (1 - 0.6 * f) * p
          c.stars.quadRotated(centre.add(cam.right.uniformScale(Math.cos(ang) * rr)).add(cam.up.uniformScale(Math.sin(ang) * rr)), cam.right, cam.up, sz, sz, tint(k % 3 === 0 ? pal.core : pal.main, 1, 0.85 * p * Math.sin(f * Math.PI)), ang)
        }
        break
      }
      default: {
        // a doorway in miniature: counter-turning rings with rune sparks riding the rim
        const rot = t * 1.4
        const r1 = cam.right.uniformScale(Math.cos(rot)).add(cam.up.uniformScale(Math.sin(rot)))
        const u1 = cam.up.uniformScale(Math.cos(rot)).sub(cam.right.uniformScale(Math.sin(rot)))
        c.rings.quad(centre, r1, u1, r * 1.35, r * 1.35, tint(pal.main, 1, 0.9 * p))
        c.rings.quad(centre, cam.right, cam.up, r * 1.05, r * 1.05, tint(pal.core, 1, 0.5 * p))
        for (let k = 0; k < 10; k++) {
          const ang = -rot * 1.3 + (k / 10) * Math.PI * 2
          const fl = 0.7 + 0.3 * flickerNoise(k, 3, t, 8)
          c.stars.quadRotated(centre.add(cam.right.uniformScale(Math.cos(ang) * r * 1.35)).add(cam.up.uniformScale(Math.sin(ang) * r * 1.35)), cam.right, cam.up, 1.1 * p * fl, 1.1 * p * fl, tint(k % 2 === 0 ? pal.accent : pal.core, 1, 0.9 * p), ang)
        }
        break
      }
    }
  }

  // ── Other players ───────────────────────────────────────────────────────────

  /** Another player released an orb: show it flying. Its landing arrives as its own network event. */
  spawnRemoteShot(element: PowerId, from: vec3, to: vec3, normal: vec3, power: number): void {
    this.shots.push({
      element,
      pal: ELEMENT_PALETTES[element],
      guided: true,
      from,
      ctrl: this.arcControl(from, to),
      to,
      normal,
      person: false,
      t: 0,
      dur: Math.max(0.22, Math.min(1.1, from.distance(to) / this.opts.flightSpeed)),
      pos: from,
      prev: from,
      vel: vec3.zero(),
      power,
      radius: lerp(4, 8, clamp01(power)),
      travelled: 0,
      probing: false,
      done: false,
      remote: true,
      seed: Math.random() * 100,
    })
    if (this.shots.length > 8) this.shots.shift()
    playOneShotAt(this.ctx.effectsRoot, element === PowerId.Fireball ? MagicSfx.fireLaunch : element === PowerId.Ice ? MagicSfx.iceShoot : MagicSfx.energyLaunch, from, 0.7)
  }

  /** The orb another player is holding (radius 0 = they have let go). */
  setRemoteOrb(player: string, element: PowerId, centre: vec3, radius: number, charge: number): void {
    let o = this.remoteOrbs[player]
    if (!o) {
      if (radius <= 0) return
      o = { element, centre, shown: centre, radius, charge, seenAt: this.time, presence: 0 }
      this.remoteOrbs[player] = o
    }
    if (radius > 0) {
      o.element = element
      o.centre = centre
      o.radius = radius
      o.charge = charge
      o.seenAt = this.time
    } else o.seenAt = -10
  }

  private drawRemoteOrbs(dt: number, cam: CamBasis): void {
    const c = this.canvas
    for (const id in this.remoteOrbs) {
      const o = this.remoteOrbs[id]
      const fresh = this.time - o.seenAt < 0.6
      o.presence = approach(o.presence, fresh ? 1 : 0, fresh ? 8 : 5, dt)
      if (o.presence < 0.02) {
        if (!fresh) delete this.remoteOrbs[id]
        continue
      }
      o.shown = approachVec(o.shown, o.centre, 14, dt)
      const pal = ELEMENT_PALETTES[o.element]
      const p = o.presence
      const r = Math.max(3, o.radius) * p
      c.glows.quad(o.shown, cam.right, cam.up, r * 2.2, r * 2.2, tint(pal.main, 1, 0.45 * p))
      c.glows.quad(o.shown, cam.right, cam.up, r * (0.6 + 0.3 * o.charge), r * (0.6 + 0.3 * o.charge), tint(pal.core, 1, 0.85 * p))
      c.rings.quad(o.shown, cam.right, cam.up, r * 1.25, r * 1.25, tint(pal.main, 1, 0.5 * p))
      for (let k = 0; k < 8; k++) {
        const a = this.time * (1.8 + 3 * o.charge) + k * 0.785
        const pos = o.shown.add(cam.right.uniformScale(Math.cos(a) * r * 1.1)).add(cam.up.uniformScale(Math.sin(a) * r * 0.8)).add(cam.look.uniformScale(Math.sin(a * 1.3) * r * 0.4))
        c.motes.quad(pos, cam.right, cam.up, 0.7 * p, 0.7 * p, tint(k % 2 === 0 ? pal.core : pal.accent, 1, 0.85 * p))
      }
    }
  }

  // ── Release + flight ────────────────────────────────────────────────────────

  private launch(element: PowerId, cam: CamBasis): void {
    const orb = this.orb
    const pal = ELEMENT_PALETTES[element]
    const power = orb.charge
    const from = orb.centre
    const speed = this.opts.flightSpeed
    const guided = this.aimValid
    const to = guided ? this.aim.pos : from.add(cam.look.uniformScale(this.opts.aimRangeCm))
    const dist = from.distance(to)
    this.shots.push({
      element,
      pal,
      guided,
      from,
      ctrl: this.arcControl(from, to),
      to,
      normal: guided ? this.aim.normal : vec3.up(),
      person: guided && this.aim.person,
      t: 0,
      dur: Math.max(0.22, Math.min(1.1, dist / speed)),
      pos: from,
      prev: from,
      vel: cam.look.uniformScale(speed),
      power,
      radius: Math.max(4, orb.radius * 0.8),
      travelled: 0,
      probing: false,
      done: false,
      remote: false,
      seed: Math.random() * 100,
    })
    if (this.shots.length > 8) this.shots.shift()
    if (this.onShot) this.onShot(element, from, to, guided ? this.aim.normal : vec3.up(), power)
    const root = this.ctx.effectsRoot
    switch (element) {
      case PowerId.Fireball:
        playOneShotAt(root, MagicSfx.fireLaunch, from, 0.9)
        break
      case PowerId.Ice:
        playOneShotAt(root, MagicSfx.iceShoot, from, 0.9)
        break
      case PowerId.Telekinesis:
        playOneShotAt(root, MagicSfx.teleThrow, from, 0.9)
        break
      default:
        playOneShotAt(root, MagicSfx.energyLaunch, from, 0.9)
        break
    }
    this.puff(from, pal, 18, 70)
    orb.presence = 0
    orb.charge = 0
    this.formed = false
    this.full = false
    this.grace = 0
    this.thrustFrames = 0
    this.cooldown = 0.45
    this.core.setVisible(false)
    this.shell.setVisible(false)
    if (this.onLaunch) this.onLaunch(element, power)
  }

  private land(s: Shot, position: vec3, normal: vec3, person: boolean): void {
    if (s.done) return
    s.done = true
    if (!s.remote && this.onImpact) this.onImpact({ element: s.element, position, normal, power: s.power, surface: person ? "person" : classifySurface(normal) })
  }

  private updateShots(dt: number, cam: CamBasis): void {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      if (s.done) {
        this.shots.splice(i, 1)
        continue
      }
      s.prev = s.pos
      if (s.guided) {
        s.t += dt / s.dur
        const u = Math.min(1, s.t)
        s.pos = bezier(s.from, s.ctrl, s.to, u)
        if (u >= 1) {
          this.land(s, s.to, s.normal, s.person)
          continue
        }
      } else {
        // nothing in sight when it was released: fly on and land on the first thing it meets
        s.vel = new vec3(s.vel.x, s.vel.y - 90 * dt, s.vel.z)
        s.pos = s.pos.add(s.vel.uniformScale(dt))
        s.travelled += s.vel.length * dt
        if (this.editorFloor && this.floorY !== null && s.pos.y <= this.floorY) {
          this.land(s, new vec3(s.pos.x, this.floorY, s.pos.z), vec3.up(), false)
          continue
        }
        if (s.travelled > 900) {
          s.done = true
          this.puff(s.pos, s.pal, 20, 60)
          continue
        }
        if (this.probe.isAvailable && !s.probing) {
          s.probing = true
          const ahead = s.pos.add(s.vel.uniformScale(dt * 3 + 0.02))
          this.probe.probe(s.prev, ahead, (hit) => {
            s.probing = false
            if (hit && !this.torn) this.land(s, hit.position, hit.normal, false)
          })
        }
      }
      this.drawShot(s, dt, cam)
    }
  }

  private drawShot(s: Shot, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const pal = s.pal
    const r = s.radius
    const t = this.time
    const move = s.pos.sub(s.prev)
    const dir = move.length > 1e-3 ? move.normalize() : cam.look
    const back = dir.uniformScale(-1)
    const side = sideAxisFor(back, cam)
    c.glows.quad(s.pos, cam.right, cam.up, r * 2.6, r * 2.6, tint(pal.main, 1, 0.6))
    c.glows.quad(s.pos, cam.right, cam.up, r * 1.2, r * 1.2, tint(pal.core, 1, 0.9))
    switch (s.element) {
      case PowerId.Fireball:
        for (let k = 0; k < 5; k++) {
          const n = flickerNoise(k, s.seed, t, 16)
          const len = r * (1.8 + 0.6 * n) * (1 - k * 0.12)
          c.flames.quad(s.pos.add(back.uniformScale(r * 0.6 + k * r * 0.5 + len * 0.5)).add(side.uniformScale(n * r * 0.35)), side, back, r * 0.45, len * 0.5, tint(k < 2 ? pal.core : pal.main, 1, 0.8 - k * 0.12))
        }
        break
      case PowerId.Ice:
        for (let k = 0; k < 3; k++) {
          const off = side.uniformScale((k - 1) * r * 0.5).add(back.uniformScale(k === 1 ? 0 : r * 0.6))
          c.crystals.quad(s.pos.add(off), side, dir, r * 0.3, r * 1.3, tint(k === 1 ? pal.core : pal.main, 1, 0.95))
        }
        break
      case PowerId.Lightning:
        for (let k = 0; k < 3; k++) {
          const a = s.pos.add(randomUnitVector().uniformScale(r * 1.4))
          c.arc(a, s.pos.add(back.uniformScale(r * (1.5 + k))), 6, r * 0.5, s.seed + k * 3.3, t, 2.6, 0.6, tint(pal.main, 1, 0.8), tint(pal.core, 1, 1), cam.pos)
        }
        break
      default: {
        const basis = perpendicularBasis(dir)
        for (let k = 0; k < 3; k++) {
          const rr = r * (1.1 + k * 0.35)
          c.rings.quad(s.pos.add(back.uniformScale(r * (0.8 + k * 1.1))), basis.n1, basis.n2, rr, rr, tint(k === 0 ? pal.main : pal.accent, 1, 0.55 - k * 0.14))
        }
        break
      }
    }
    if (Math.random() < 70 * dt) {
      const pool = s.element === PowerId.Lightning ? c.sparkPool : s.element === PowerId.Telekinesis || s.element === PowerId.Portal ? c.starPool : c.motePool
      pool.spawn({ pos: s.pos.add(back.uniformScale(r)), vel: back.uniformScale(randRange(20, 60)).add(randomUnitVector().uniformScale(18)), life: randRange(0.4, 0.9), size: randRange(0.9, 2), sizeEnd: 0.15, color: Math.random() < 0.3 ? pal.core : pal.main, drag: 1.2, turbulence: 25 })
    }
  }
}
