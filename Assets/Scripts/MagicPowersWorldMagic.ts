/**
 * MagicPowersWorldMagic — the magic that stays in the room.
 *
 * Owns: every lasting elemental effect left on a real surface (a burning patch of floor, a frozen
 *       wall, a storm cell, an arcane sigil, a gravity well), how each one adapts to the surface it
 *       landed on (flames climb walls, icicles hang from ceilings), the reactions between them
 *       (fire + ice = steam, lightning + ice = shatter, fire + lightning = firestorm, energy
 *       amplifies), the enchantment worn by a tracked person, hand-proximity "stirring", and the
 *       spatial loops that make each effect audible where it sits.
 * Expects: an FxCanvas to draw into and update() once per frame between canvas.begin()/end().
 * Must not: read gestures or decide what gets cast — the caster and the powers call imprint().
 *
 * Effects outlive the power that made them: the wearer can set the floor alight, switch to Ice and
 * put it out. That is why this lives outside the per-power VFX roots.
 */

import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { BodyAnchor, ELEMENT_PALETTES, ElementPalette, HandPose, PowerId, SpellId, SurfaceKind, WorldMagicApi } from "./MagicPowersTypes"
import { CamBasis, FxCanvas, approach, clamp01, flickerNoise, hash1, lerp, perpendicularBasis, randRange, randomUnitVector, sideAxisFor, smoothstep, tint } from "./MagicPowersEffectsLib"
import { LoopVoice, LoopVoices, playOneShotAt } from "./MagicPowersAudioLib"
import { MagicSfx } from "./MagicPowersAssetManifest"

export interface SpellEvent {
  spell: SpellId
  position: vec3
  surface: SurfaceKind
}

type Reaction = "steam" | "shatter" | "firestorm" | "amplify"

interface ScatterPoint {
  u: number
  v: number
  /** distance from the centre, 0..1 */
  d: number
  s: number
  phase: number
}

interface Patch {
  element: PowerId
  pal: ElementPalette
  pos: vec3
  normal: vec3
  n1: vec3
  n2: vec3
  /** Axis flames / spikes grow along — depends on the surface. */
  rise: vec3
  surface: SurfaceKind
  radius: number
  age: number
  life: number
  presence: number
  dying: boolean
  fadeRate: number
  /** Fire that has been struck by lightning. */
  charged: boolean
  seed: number
  points: ScatterPoint[]
  emit: number
  strikeIn: number
  pulse: number
  stir: number
  stirAt: vec3
  voice: LoopVoice | null
}

interface Flash {
  pos: vec3
  normal: vec3
  n1: vec3
  n2: vec3
  age: number
  dur: number
  size: number
  pal: ElementPalette
}

interface Strike {
  from: vec3
  to: vec3
  age: number
  dur: number
  seed: number
  pal: ElementPalette
}

interface Enchant {
  element: PowerId
  pal: ElementPalette
  age: number
  life: number
  presence: number
  dying: boolean
  charged: boolean
  emit: number
  seed: number
}

const MAX_PATCHES = 6
const MAX_RADIUS = 68
const SPREAD_SEC = 1.3
const POINTS = 22
const STEAM = new vec4(0.85, 0.93, 1.0, 0.55)
/** Marks the editor's stand-in person so it can be found and aimed at. */
const MOCK_TINT = new vec4(0.6, 0.75, 1.0, 1)
/** index = PowerId */
const IMPRINT_SPELL: SpellId[] = ["ignite", "storm", "sigil", "frost", "gravity", "gateway"]

export function classifySurface(n: vec3): SurfaceKind {
  return n.y > 0.6 ? "floor" : n.y < -0.6 ? "ceiling" : "wall"
}

export class WorldMagic implements WorldMagicApi {
  private patches: Patch[] = []
  private flashes: Flash[] = []
  private strikes: Strike[] = []
  private enchant: Enchant | null = null
  private body: BodyAnchor | null = null
  /** THIS player's magic marked a surface (multiplayer shares it with the others). */
  onLocalImprint: ((element: PowerId, position: vec3, normal: vec3, power: number) => void) | null = null
  /** THIS player's cast landed on a person. */
  onLocalEnchant: ((element: PowerId, power: number, at: vec3) => void) | null = null
  private selfHit: { element: PowerId; pal: ElementPalette; age: number; life: number; seed: number } | null = null
  private headAt: vec3 = vec3.zero()
  /** Element colour while the wearer holds an orb: a tracked person glows faintly in it ("you can cast on them"). */
  bodyHint: vec4 | null = null
  /** True while the reticle is on the person: the glow brightens. */
  bodyHintStrong = false
  private hintShown = 0
  private hintColor: vec4 = new vec4(1, 1, 1, 1)
  private bodyAuraOn = false
  private loops: LoopVoices
  private spellEvent = new Event<SpellEvent>()
  private time = 0

  constructor(private canvas: FxCanvas, private sfxRoot: SceneObject) {
    this.loops = new LoopVoices(sfxRoot, 6)
  }

  /** Fires for every imprint and every reaction (the spellbook listens). */
  get onSpell(): PublicApi<SpellEvent> {
    return this.spellEvent.publicApi()
  }

  setBody(body: BodyAnchor | null): void {
    this.body = body
  }

  get liveCount(): number {
    return this.patches.length
  }

  /** Report a spell this system did not draw itself (a portal opened on a wall). */
  announce(spell: SpellId, position: vec3, surface: SurfaceKind): void {
    this.spellEvent.invoke({ spell, position, surface })
  }

  /** Let everything burn out now (new journey). */
  clear(): void {
    for (const p of this.patches) {
      p.dying = true
      p.fadeRate = 3
    }
    if (this.enchant) this.enchant.dying = true
  }

  // ── Imprinting + reactions ──────────────────────────────────────────────────

  /** `fromRemote` = another player's magic, arriving over the network: apply it, do not send it back. */
  imprint(element: PowerId, position: vec3, normal: vec3, power: number, fromRemote = false): void {
    if (element === PowerId.Portal) return
    const n = normal.length > 1e-3 ? normal.normalize() : vec3.up()
    const pw = clamp01(power)
    if (!fromRemote && this.onLocalImprint) this.onLocalImprint(element, position, n, pw)
    const newR = this.radiusFor(element, pw)
    const hit = this.overlapping(position, newR)
    if (hit) {
      if (hit.element === element) {
        this.refuel(hit, pw)
        return
      }
      const reaction = this.reactionFor(element, hit.element)
      if (reaction) {
        this.react(reaction, element, hit, n, pw)
        return
      }
    }
    this.spawn(element, position, n, pw, 1, false)
    this.spellEvent.invoke({ spell: IMPRINT_SPELL[element], position, surface: classifySurface(n) })
  }

  nearest(element: PowerId, from: vec3, rangeCm: number): { position: vec3; normal: vec3; radius: number } | null {
    let best: Patch | null = null
    let bestD = rangeCm
    for (const p of this.patches) {
      if (p.element !== element || p.dying) continue
      const d = p.pos.distance(from)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best ? { position: best.pos, normal: best.normal, radius: best.radius } : null
  }

  private radiusFor(element: PowerId, power: number): number {
    switch (element) {
      case PowerId.Fireball:
        return lerp(20, 42, power)
      case PowerId.Ice:
        return lerp(22, 46, power)
      case PowerId.Telekinesis:
        return lerp(18, 34, power)
      default:
        return lerp(20, 40, power)
    }
  }

  private lifeFor(element: PowerId, power: number): number {
    switch (element) {
      case PowerId.Fireball:
        return lerp(11, 17, power)
      case PowerId.Ice:
        return lerp(13, 19, power)
      case PowerId.Lightning:
        return lerp(7, 11, power)
      default:
        return lerp(12, 17, power)
    }
  }

  private overlapping(pos: vec3, newR: number): Patch | null {
    let best: Patch | null = null
    let bestD = 1e9
    for (const p of this.patches) {
      if (p.dying) continue
      const d = p.pos.distance(pos)
      if (d < p.radius * 0.85 + newR * 0.35 && d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  }

  private reactionFor(a: PowerId, b: PowerId): Reaction | null {
    const has = (x: PowerId) => a === x || b === x
    if (has(PowerId.Fireball) && has(PowerId.Ice)) return "steam"
    if (has(PowerId.Ice) && has(PowerId.Lightning)) return "shatter"
    if (has(PowerId.Fireball) && has(PowerId.Lightning)) return "firestorm"
    if (has(PowerId.EnergySphere)) return "amplify"
    return null
  }

  private spawn(element: PowerId, position: vec3, n: vec3, power: number, scale: number, charged: boolean): Patch {
    // Never let the room fill up: the oldest effect bows out for the new one.
    let live = 0
    for (const p of this.patches) if (!p.dying) live++
    if (live >= MAX_PATCHES) {
      for (const p of this.patches) {
        if (!p.dying) {
          p.dying = true
          p.fadeRate = 2
          break
        }
      }
    }
    const pal = ELEMENT_PALETTES[element]
    const basis = perpendicularBasis(n)
    const surface = classifySurface(n)
    const seed = Math.random() * 100
    const points: ScatterPoint[] = []
    for (let i = 0; i < POINTS; i++) {
      const d = Math.sqrt((i + 0.5) / POINTS)
      const a = i * 2.399963 + seed
      points.push({ u: d * Math.cos(a), v: d * Math.sin(a), d, s: 0.7 + 0.3 * Math.abs(hash1(i * 3.1 + seed)), phase: hash1(i * 7.7 + seed) * Math.PI })
    }
    const radius = Math.min(MAX_RADIUS, this.radiusFor(element, power) * scale)
    const p: Patch = {
      element,
      pal,
      pos: position,
      normal: n,
      n1: basis.n1,
      n2: basis.n2,
      rise: this.riseAxis(element, n, surface, basis.n1),
      surface,
      radius,
      age: 0,
      life: this.lifeFor(element, power) * (charged ? 1.2 : 1),
      presence: 0,
      dying: false,
      fadeRate: 0.7,
      charged,
      seed,
      points,
      emit: 0,
      strikeIn: 0.3,
      pulse: 1,
      stir: 0,
      stirAt: position,
      voice: null,
    }
    this.patches.push(p)
    this.flash(position, n, radius * 1.5, pal, 0.65)
    this.burstParticles(element, position, n, 0.7 + 0.6 * power)
    this.impactSound(element, position)
    const loop = this.loopTrack(element)
    if (loop) p.voice = this.loops.acquire(loop.track, position, loop.volume)
    return p
  }

  private riseAxis(element: PowerId, n: vec3, surface: SurfaceKind, n1: vec3): vec3 {
    const up = vec3.up()
    if (element === PowerId.Fireball) {
      if (surface === "floor") return up
      if (surface === "wall") return up.uniformScale(0.85).add(n.uniformScale(0.4)).normalize() // flames climb the wall
      return n.uniformScale(0.6).add(n1.uniformScale(0.4)).normalize() // fire rolling across a ceiling
    }
    if (element === PowerId.Ice && surface === "wall") return n.uniformScale(0.75).add(up.uniformScale(-0.55)).normalize() // icicles droop
    return n
  }

  private refuel(p: Patch, power: number): void {
    p.radius = Math.min(MAX_RADIUS, p.radius * 1.2)
    p.age = Math.min(p.age, SPREAD_SEC)
    p.life = this.lifeFor(p.element, power) + SPREAD_SEC
    p.pulse = 1
    this.flash(p.pos, p.normal, p.radius * 1.4, p.pal, 0.5)
    this.burstParticles(p.element, p.pos, p.normal, 0.8)
    this.impactSound(p.element, p.pos)
    this.spellEvent.invoke({ spell: IMPRINT_SPELL[p.element], position: p.pos, surface: p.surface })
  }

  private react(reaction: Reaction, incoming: PowerId, target: Patch, n: vec3, power: number): void {
    const at = target.pos
    const sfx = this.sfxRoot
    switch (reaction) {
      case "steam":
        this.kill(target, 5)
        this.steam(at, target.normal, target.radius)
        playOneShotAt(sfx, MagicSfx.fireIgnite, at, 0.7)
        playOneShotAt(sfx, MagicSfx.iceImpact, at, 0.6)
        break
      case "shatter":
        this.kill(target, 8)
        this.shatter(at, target.normal, target.radius)
        playOneShotAt(sfx, MagicSfx.iceImpact, at, 1)
        playOneShotAt(sfx, MagicSfx.lightningBolt, at, 0.7)
        break
      case "firestorm": {
        let fire = target
        if (target.element !== PowerId.Fireball) {
          this.kill(target, 6)
          fire = this.spawn(PowerId.Fireball, at, target.normal, Math.max(power, 0.6), 1.3, true)
        } else {
          fire.charged = true
          fire.radius = Math.min(MAX_RADIUS, fire.radius * 1.35)
          fire.age = Math.min(fire.age, SPREAD_SEC)
          fire.life = this.lifeFor(PowerId.Fireball, 1) * 1.2
          fire.pulse = 1
        }
        this.flash(at, fire.normal, fire.radius * 2.2, ELEMENT_PALETTES[PowerId.Lightning], 0.7)
        this.burstParticles(PowerId.Fireball, at, fire.normal, 1.8)
        this.burstParticles(PowerId.Lightning, at, fire.normal, 1.4)
        playOneShotAt(sfx, MagicSfx.fireImpact, at, 1)
        playOneShotAt(sfx, MagicSfx.lightningBolt, at, 0.8)
        break
      }
      case "amplify": {
        let boosted = target
        if (incoming === PowerId.EnergySphere) {
          boosted.radius = Math.min(MAX_RADIUS, boosted.radius * 1.5)
          boosted.age = Math.min(boosted.age, SPREAD_SEC)
          boosted.life = this.lifeFor(boosted.element, 1) * 1.3
          boosted.pulse = 1
        } else {
          // something was cast onto a sigil: the sigil is spent and the spell lands supercharged
          this.kill(target, 5)
          boosted = this.spawn(incoming, at, target.normal, Math.max(power, 0.6), 1.5, false)
        }
        const e = ELEMENT_PALETTES[PowerId.EnergySphere]
        this.flash(at, boosted.normal, boosted.radius * 1.6, e, 0.6)
        this.flash(at, boosted.normal, boosted.radius * 2.4, boosted.pal, 0.9)
        for (let i = 0; i < 26; i++) {
          this.canvas.starPool.spawn({ pos: at.add(boosted.normal.uniformScale(2)), vel: randomUnitVector().uniformScale(randRange(50, 150)).add(boosted.normal.uniformScale(60)), life: randRange(0.5, 1.1), size: randRange(1.5, 3), sizeEnd: 0.2, color: Math.random() < 0.5 ? e.core : e.accent, drag: 1.8, spin: randRange(-8, 8) })
        }
        playOneShotAt(sfx, MagicSfx.energyImpact, at, 0.9)
        playOneShotAt(sfx, MagicSfx.spellSelect, at, 0.8)
        break
      }
    }
    this.spellEvent.invoke({ spell: reaction, position: at, surface: target.surface })
  }

  private kill(p: Patch, rate: number): void {
    p.dying = true
    p.fadeRate = rate
  }

  private steam(at: vec3, n: vec3, radius: number): void {
    const basis = perpendicularBasis(n)
    this.flash(at, n, radius * 1.6, { core: STEAM, main: STEAM, accent: STEAM }, 0.8)
    for (let i = 0; i < 38; i++) {
      const a = randRange(0, Math.PI * 2)
      const r = Math.sqrt(Math.random()) * radius
      const radial = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
      this.canvas.motePool.spawn({
        pos: at.add(radial.uniformScale(r)).add(n.uniformScale(2)),
        vel: vec3.up().uniformScale(randRange(25, 75)).add(radial.uniformScale(randRange(8, 40))).add(n.uniformScale(randRange(5, 30))),
        life: randRange(1.2, 2.4),
        size: randRange(4, 7),
        sizeEnd: randRange(13, 20),
        color: STEAM,
        drag: 0.9,
        gravity: -16,
        turbulence: 30,
      })
    }
  }

  private shatter(at: vec3, n: vec3, radius: number): void {
    const basis = perpendicularBasis(n)
    const ice = ELEMENT_PALETTES[PowerId.Ice]
    this.flash(at, n, radius * 2, ice, 0.55)
    for (let i = 0; i < 30; i++) {
      const a = randRange(0, Math.PI * 2)
      const radial = basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
      this.canvas.shardPool.spawn({
        pos: at.add(radial.uniformScale(Math.random() * radius * 0.7)).add(n.uniformScale(3)),
        vel: radial.uniformScale(randRange(120, 300)).add(n.uniformScale(randRange(60, 220))),
        life: randRange(0.6, 1.1),
        size: randRange(3, 6.5),
        sizeEnd: 1,
        color: Math.random() < 0.5 ? ice.core : ice.main,
        drag: 0.8,
        gravity: 380,
        spin: randRange(-14, 14),
      })
    }
    this.burstParticles(PowerId.Lightning, at, n, 1.3)
  }

  private impactSound(element: PowerId, at: vec3): void {
    const s = this.sfxRoot
    switch (element) {
      case PowerId.Fireball:
        playOneShotAt(s, MagicSfx.fireImpact, at, 0.9)
        break
      case PowerId.Lightning:
        playOneShotAt(s, MagicSfx.lightningBolt, at, 0.8)
        break
      case PowerId.EnergySphere:
        playOneShotAt(s, MagicSfx.energyImpact, at, 0.9)
        break
      case PowerId.Ice:
        playOneShotAt(s, MagicSfx.iceImpact, at, 0.9)
        playOneShotAt(s, MagicSfx.iceForm, at, 0.6)
        break
      case PowerId.Telekinesis:
        playOneShotAt(s, MagicSfx.teleLand, at, 0.9)
        break
      default:
        break
    }
  }

  private loopTrack(element: PowerId): { track: AudioTrackAsset; volume: number } | null {
    switch (element) {
      case PowerId.Fireball:
        return { track: MagicSfx.fireLoop, volume: 0.5 }
      case PowerId.Lightning:
        return { track: MagicSfx.lightningCrackle, volume: 0.38 }
      case PowerId.EnergySphere:
        return { track: MagicSfx.energyHum, volume: 0.34 }
      case PowerId.Ice:
        return { track: MagicSfx.iceShimmer, volume: 0.26 }
      case PowerId.Telekinesis:
        return { track: MagicSfx.teleHum, volume: 0.3 }
      default:
        return null
    }
  }

  // ── Bursts ──────────────────────────────────────────────────────────────────

  /** Expanding ring + glow on a surface. */
  flash(pos: vec3, normal: vec3, size: number, pal: ElementPalette, dur = 0.6): void {
    const basis = perpendicularBasis(normal)
    this.flashes.push({ pos, normal, n1: basis.n1, n2: basis.n2, age: 0, dur, size, pal })
    if (this.flashes.length > 10) this.flashes.shift()
  }

  /** A puff of the element's own particles, thrown off a surface. */
  burstParticles(element: PowerId, pos: vec3, normal: vec3, scale: number): void {
    const c = this.canvas
    const pal = ELEMENT_PALETTES[element]
    const basis = perpendicularBasis(normal)
    const radial = (): vec3 => {
      const a = randRange(0, Math.PI * 2)
      return basis.n1.uniformScale(Math.cos(a)).add(basis.n2.uniformScale(Math.sin(a)))
    }
    const at = pos.add(normal.uniformScale(1.5))
    switch (element) {
      case PowerId.Fireball:
        for (let i = 0; i < 28; i++) c.motePool.spawn({ pos: at, vel: radial().uniformScale(randRange(60, 160) * scale).add(normal.uniformScale(randRange(20, 90))), life: randRange(0.5, 1.1), size: randRange(1.5, 3.5), sizeEnd: 0.2, color: Math.random() < 0.3 ? pal.core : pal.accent, drag: 1.4, gravity: 120, turbulence: 40 })
        for (let i = 0; i < 12; i++) c.sparkPool.spawn({ pos: at, vel: randomUnitVector().uniformScale(randRange(120, 260) * scale), life: randRange(0.25, 0.5), size: randRange(2, 4), sizeEnd: 0.3, color: pal.core, drag: 2.5, gravity: 60 })
        break
      case PowerId.Ice:
        for (let i = 0; i < 22; i++) c.motePool.spawn({ pos: at, vel: radial().uniformScale(randRange(40, 140) * scale).add(normal.uniformScale(randRange(30, 110))), life: randRange(0.5, 1.0), size: randRange(0.8, 2.0), sizeEnd: 0.1, color: Math.random() < 0.4 ? pal.core : pal.main, drag: 1.6, gravity: 160 })
        for (let i = 0; i < 8; i++) c.shardPool.spawn({ pos: at, vel: radial().uniformScale(randRange(70, 180) * scale).add(normal.uniformScale(randRange(60, 150))), life: randRange(0.5, 0.9), size: randRange(2.5, 4.5), sizeEnd: 0.6, color: pal.core, drag: 1, gravity: 320, spin: randRange(-12, 12) })
        break
      case PowerId.Lightning:
        for (let i = 0; i < 26; i++) c.sparkPool.spawn({ pos: at, vel: randomUnitVector().uniformScale(randRange(80, 220) * scale), life: randRange(0.15, 0.4), size: randRange(1.2, 3), sizeEnd: 0.1, color: Math.random() < 0.5 ? pal.core : pal.main, drag: 3, gravity: 80, spin: randRange(-10, 10) })
        break
      case PowerId.Telekinesis:
        for (let i = 0; i < 22; i++) c.starPool.spawn({ pos: at, vel: normal.uniformScale(randRange(30, 90)).add(radial().uniformScale(randRange(10, 60) * scale)), life: randRange(0.6, 1.3), size: randRange(1.2, 2.6), sizeEnd: 0.2, color: Math.random() < 0.4 ? pal.core : pal.main, drag: 1.5, gravity: -20, spin: randRange(-6, 6) })
        break
      default:
        for (let i = 0; i < 30; i++) c.motePool.spawn({ pos: at, vel: radial().uniformScale(randRange(80, 220) * scale).add(normal.uniformScale(randRange(10, 60))), life: randRange(0.4, 0.9), size: randRange(1.2, 2.6), sizeEnd: 0.1, color: Math.random() < 0.4 ? pal.core : pal.accent, drag: 2 })
        break
    }
  }

  /** A ring of every element's colours — the mastery finale. */
  fanfare(centre: vec3, cam: CamBasis): void {
    const toCam = cam.pos.sub(centre).normalize()
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      const pos = centre.add(cam.right.uniformScale(Math.cos(a) * 38)).add(cam.up.uniformScale(Math.sin(a) * 24))
      this.flash(pos, toCam, 26, ELEMENT_PALETTES[k], 1.1)
      this.burstParticles(k as PowerId, pos, toCam, 1.1)
    }
    playOneShotAt(this.sfxRoot, MagicSfx.portalOpen, centre, 0.9)
    playOneShotAt(this.sfxRoot, MagicSfx.spellSelect, centre, 1)
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  update(dt: number, cam: CamBasis, left: HandPose, right: HandPose): void {
    this.time += dt
    for (let i = this.patches.length - 1; i >= 0; i--) {
      const p = this.patches[i]
      p.age += dt
      if (!p.dying && p.age > p.life) {
        p.dying = true
        p.fadeRate = 0.7
      }
      p.presence = approach(p.presence, p.dying ? 0 : 1, p.dying ? p.fadeRate : 5, dt)
      p.pulse = Math.max(0, p.pulse - dt * 1.6)
      if (p.dying && p.presence < 0.02) {
        this.loops.release(p.voice)
        this.patches.splice(i, 1)
        continue
      }
      // A hand held near an effect stirs it: fire leaps, the storm reaches for the palm.
      let stir = this.stirFrom(p, left)
      const sr = this.stirFrom(p, right)
      if (sr > stir) {
        stir = sr
        p.stirAt = right.palmCenter
      } else if (stir > 0) p.stirAt = left.palmCenter
      p.stir = approach(p.stir, stir, 6, dt)

      const I = p.presence
      switch (p.element) {
        case PowerId.Fireball:
          this.drawFire(p, I, dt, cam)
          break
        case PowerId.Ice:
          this.drawIce(p, I, dt, cam)
          break
        case PowerId.Lightning:
          this.drawStorm(p, I, dt, cam)
          break
        case PowerId.EnergySphere:
          this.drawSigil(p, I, dt, cam)
          break
        default:
          this.drawGravity(p, I, dt, cam)
          break
      }
      if (p.voice) {
        p.voice.emitter.setLevel(I * (1 + 0.4 * p.stir))
        p.voice.emitter.update(dt, 6)
      }
    }
    this.updateStrikes(dt, cam)
    this.updateFlashes(dt, cam)
    this.updateBody(dt, cam)
    this.headAt = cam.pos
    this.updateSelf(dt, cam, left, right)
  }

  private stirFrom(p: Patch, h: HandPose): number {
    if (h.confidence <= 0.3) return 0
    const d = h.palmCenter.distance(p.pos)
    const inner = p.radius * 0.4
    const reach = p.radius + 28
    return d < reach ? clamp01(1 - (d - inner) / (reach - inner)) : 0
  }

  private foot(p: Patch, pt: ScatterPoint, R: number, lift: number): vec3 {
    return p.pos.add(p.n1.uniformScale(pt.u * R)).add(p.n2.uniformScale(pt.v * R)).add(p.normal.uniformScale(lift))
  }

  private randomIn(p: Patch, R: number, lift: number): vec3 {
    const a = randRange(0, Math.PI * 2)
    const r = Math.sqrt(Math.random()) * R
    return p.pos.add(p.n1.uniformScale(Math.cos(a) * r)).add(p.n2.uniformScale(Math.sin(a) * r)).add(p.normal.uniformScale(lift))
  }

  private drawFire(p: Patch, I: number, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const t = this.time
    const spread = clamp01(p.age / SPREAD_SEC)
    const R = p.radius * (0.35 + 0.65 * smoothstep(0, 1, spread))
    const flick = 0.85 + 0.15 * flickerNoise(1, p.seed, t, 11)
    const hot = (p.charged ? 1.3 : 1) * (1 + 0.35 * p.stir + 0.6 * p.pulse)
    const base = p.pos.add(p.normal.uniformScale(0.6))
    // light thrown on the surface, a hot heart and a scorched rim
    c.glows.quad(base, p.n1, p.n2, R * 1.4, R * 1.4, tint(p.pal.main, 1, 0.5 * I * flick))
    c.glows.quad(base.add(p.normal.uniformScale(0.3)), p.n1, p.n2, R * 0.7, R * 0.7, tint(p.pal.core, 1, 0.45 * I * flick))
    c.rings.quad(base, p.n1, p.n2, R * 1.02, R * 1.02, tint(p.pal.accent, 1, 0.35 * I))
    const up = p.rise
    const side = sideAxisFor(up, cam)
    const tall = lerp(20, 34, clamp01((p.radius - 20) / 30)) * hot
    for (let i = 0; i < p.points.length; i++) {
      const pt = p.points[i]
      const lit = smoothstep(pt.d - 0.2, pt.d + 0.05, spread * 1.15) // the fire spreads outwards from where it landed
      if (lit <= 0.01) continue
      const n = flickerNoise(i, p.seed, t, 9)
      const n2 = flickerNoise(i + 20, p.seed, t, 13)
      const h = tall * pt.s * (1.15 - 0.45 * pt.d) * (0.6 + 0.4 * (0.5 + 0.5 * n)) * I * lit
      const w = h * 0.78 * (0.85 + 0.15 * n2)
      const foot = this.foot(p, pt, R * 0.92, 0.6)
      const hotCore = i % 3 === 0
      // a low, wide flare keeps the fire bedded on the surface; the tongue above it does the dancing
      c.flames.quad(foot.add(up.uniformScale(h * 0.24)), side, up, w * 0.62, h * 0.26, tint(p.pal.accent, 1, 0.55 * I * lit))
      c.flames.quad(foot.add(up.uniformScale(h * 0.5)).add(side.uniformScale(n2 * 1.4)), side, up, w * 0.5, h * 0.5, tint(hotCore ? p.pal.core : p.pal.main, 1, (hotCore ? 0.9 : 0.78) * I * lit))
    }
    // the heart of the blaze: three tall tongues over the spot where the spell landed
    for (let k = 0; k < 3; k++) {
      const n = flickerNoise(k + 50, p.seed, t, 8)
      const h = tall * (1.45 + 0.35 * n) * (k === 0 ? 1 : 0.8) * I * Math.min(1, spread * 2)
      const off = side.uniformScale((k - 1) * R * 0.16 + n * 1.5)
      c.flames.quad(base.add(off).add(up.uniformScale(h * 0.5)), side, up, h * 0.3, h * 0.5, tint(k === 0 ? p.pal.core : p.pal.main, 1, 0.85 * I))
    }
    p.emit += (9 + R * 0.5) * (1 + 2 * p.stir + (p.charged ? 1 : 0)) * I * dt
    while (p.emit >= 1) {
      p.emit -= 1
      c.motePool.spawn({ pos: this.randomIn(p, R * 0.9 * Math.max(0.3, spread), 2), vel: up.uniformScale(randRange(22, 48)).add(randomUnitVector().uniformScale(8)), life: randRange(0.8, 1.6), size: randRange(0.8, 1.8), sizeEnd: 0.15, color: Math.random() < 0.25 ? p.pal.core : p.pal.accent, drag: 0.6, gravity: -14, turbulence: 35 })
    }
    if (p.charged) {
      // a firestorm: lightning keeps licking through the flames
      const L = ELEMENT_PALETTES[PowerId.Lightning]
      for (let k = 0; k < 2; k++) {
        const step = Math.floor(t * 7 + k * 0.5)
        const ia = Math.floor(Math.abs(hash1(step * 1.7 + k * 9.1 + p.seed)) * POINTS) % POINTS
        const ib = (ia + 3 + k * 4) % POINTS
        const a = this.foot(p, p.points[ia], R * 0.9, 2).add(up.uniformScale(tall * 0.4))
        const b = this.foot(p, p.points[ib], R * 0.9, 2).add(up.uniformScale(tall * 0.7))
        c.arc(a, b, 7, a.distance(b) * 0.22, p.seed + k * 3.1, t, 2.2 * I, 0.5 * I, tint(L.main, 1, 0.7 * I), tint(L.core, 1, 0.95 * I), cam.pos)
      }
    }
  }

  private drawIce(p: Patch, I: number, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const t = this.time
    const spread = clamp01(p.age / (SPREAD_SEC * 1.2))
    const R = p.radius * (0.3 + 0.7 * smoothstep(0, 1, spread))
    const base = p.pos.add(p.normal.uniformScale(0.5))
    const glint = 0.9 + 0.1 * Math.sin(t * 2.3 + p.seed) + 0.5 * p.pulse + 0.3 * p.stir
    // a sheet of frost with a crisp creeping edge
    c.glows.quad(base, p.n1, p.n2, R * 1.3, R * 1.3, tint(p.pal.accent, 1, 0.42 * I))
    c.glows.quad(base.add(p.normal.uniformScale(0.2)), p.n1, p.n2, R * 0.75, R * 0.75, tint(p.pal.main, 1, 0.3 * I * glint))
    c.rings.quad(base, p.n1, p.n2, R * 1.03, R * 1.03, tint(p.pal.main, 1, 0.6 * I))
    c.rings.quad(base, p.n1, p.n2, R * 0.6, R * 0.6, tint(p.pal.core, 1, 0.22 * I))
    const spike = lerp(9, 17, clamp01((p.radius - 22) / 30))
    for (let i = 0; i < p.points.length; i++) {
      const pt = p.points[i]
      const grow = smoothstep(pt.d - 0.1, pt.d + 0.25, spread * 1.3)
      if (grow <= 0.01) continue
      const foot = this.foot(p, pt, R * 0.9, 0.6)
      if (i % 2 === 0) {
        // frost flowers lying on the surface
        const tw = 0.6 + 0.4 * flickerNoise(i, p.seed, t, 4)
        const s = (2.2 + 2 * pt.s) * grow
        c.flakes.quadRotated(foot, p.n1, p.n2, s, s, tint(p.pal.core, 1, 0.65 * I * tw * glint), pt.phase)
      }
      // crystal spikes lean outwards, taller in the middle; they pop up as the frost reaches them
      const radial = pt.d > 0.05 ? p.n1.uniformScale(pt.u).add(p.n2.uniformScale(pt.v)).normalize() : p.n1
      const tilt = 0.12 + 0.55 * pt.d
      const dir = p.rise.uniformScale(Math.cos(tilt)).add(radial.uniformScale(Math.sin(tilt))).normalize()
      const pop = grow * (1 + 0.18 * Math.sin(grow * Math.PI))
      const len = spike * pt.s * (1.2 - 0.5 * pt.d) * pop * I
      c.crystals.quad(foot.add(dir.uniformScale(len * 0.5)), sideAxisFor(dir, cam), dir, len * 0.19, len * 0.5, tint(i % 2 === 0 ? p.pal.core : p.pal.main, 1, 0.9 * I * grow))
    }
    p.emit += (5 + 6 * p.stir) * I * dt
    while (p.emit >= 1) {
      p.emit -= 1
      const at = this.randomIn(p, R, 2)
      if (Math.random() < 0.6) c.motePool.spawn({ pos: at, vel: randomUnitVector().uniformScale(6).add(p.normal.uniformScale(4)), life: randRange(1.4, 2.4), size: randRange(3, 5), sizeEnd: 8, color: tint(p.pal.main, 1, 0.22), drag: 0.5, turbulence: 10 })
      else c.starPool.spawn({ pos: at.add(p.rise.uniformScale(randRange(2, spike))), life: randRange(0.3, 0.7), size: randRange(1.2, 2.4), sizeEnd: 0.2, color: p.pal.core, spin: randRange(-3, 3) })
    }
  }

  private drawStorm(p: Patch, I: number, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const t = this.time
    const R = p.radius * (0.4 + 0.6 * smoothstep(0, 1, clamp01(p.age / 0.5)))
    const flick = 0.6 + 0.4 * flickerNoise(2, p.seed, t, 18)
    const base = p.pos.add(p.normal.uniformScale(0.6))
    c.glows.quad(base, p.n1, p.n2, R * 1.3, R * 1.3, tint(p.pal.main, 1, (0.26 + 0.3 * p.pulse) * I * flick))
    c.rings.quad(base, p.n1, p.n2, R, R, tint(p.pal.main, 1, 0.3 * I * flick))
    // arcs crawling across the surface, re-rolling their endpoints a few times a second
    for (let k = 0; k < 4; k++) {
      const step = Math.floor(t * 6 + k * 0.37)
      const ia = Math.floor(Math.abs(hash1(step * 1.3 + k * 5.7 + p.seed)) * POINTS) % POINTS
      const ib = Math.floor(Math.abs(hash1(step * 2.9 + k * 11.3 + p.seed)) * POINTS) % POINTS
      if (ia === ib) continue
      const a = this.foot(p, p.points[ia], R, 1.5)
      const b = this.foot(p, p.points[ib], R, 1.5)
      c.arc(a, b, 7, a.distance(b) * 0.25, p.seed + k * 3.1, t, 2.4 * I, 0.55 * I, tint(p.pal.main, 1, 0.7 * I), tint(p.pal.core, 1, 0.95 * I), cam.pos)
    }
    // the storm reaches for a hand held over it
    if (p.stir > 0.3) {
      const a = this.foot(p, p.points[Math.floor(t * 5) % POINTS], R * 0.6, 2)
      c.arc(a, p.stirAt, 9, a.distance(p.stirAt) * 0.16, p.seed + 77, t, 2.6 * I, 0.6 * I, tint(p.pal.main, 1, 0.8 * I), tint(p.pal.core, 1, I), cam.pos)
      if (Math.random() < 30 * dt) c.sparkPool.spawn({ pos: p.stirAt, vel: randomUnitVector().uniformScale(randRange(30, 90)), life: randRange(0.15, 0.3), size: randRange(1, 2), sizeEnd: 0.1, color: p.pal.core, drag: 3 })
    }
    // bolts keep striking down into the cell
    p.strikeIn -= dt
    if (p.strikeIn <= 0 && !p.dying) {
      p.strikeIn = randRange(0.7, 1.7)
      const to = this.randomIn(p, R * 0.8, 1)
      const from = to.add(p.normal.uniformScale(randRange(55, 95))).add(p.n1.uniformScale(randRange(-18, 18))).add(p.n2.uniformScale(randRange(-18, 18)))
      this.strikes.push({ from, to, age: 0, dur: 0.16, seed: Math.random() * 100, pal: p.pal })
      for (let i = 0; i < 10; i++) c.sparkPool.spawn({ pos: to, vel: randomUnitVector().uniformScale(randRange(60, 180)).add(p.normal.uniformScale(50)), life: randRange(0.15, 0.35), size: randRange(1, 2.4), sizeEnd: 0.1, color: p.pal.core, drag: 3, gravity: 80 })
      if (Math.random() < 0.5) playOneShotAt(this.sfxRoot, MagicSfx.lightningBolt, to, 0.3 * I)
    }
    if (Math.random() < 12 * I * dt) c.sparkPool.spawn({ pos: this.randomIn(p, R, 1.5), vel: p.normal.uniformScale(randRange(30, 90)).add(randomUnitVector().uniformScale(25)), life: randRange(0.15, 0.35), size: randRange(0.8, 1.8), sizeEnd: 0.1, color: p.pal.main, drag: 3, gravity: 60 })
  }

  private drawSigil(p: Patch, I: number, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const t = this.time
    const R = p.radius * (0.3 + 0.7 * smoothstep(0, 1, clamp01(p.age / 0.6)))
    const base = p.pos.add(p.normal.uniformScale(0.6))
    const rot = t * 0.5 * (1 + p.stir)
    const dirAt = (a: number): vec3 => p.n1.uniformScale(Math.cos(a)).add(p.n2.uniformScale(Math.sin(a)))
    const breathe = 0.85 + 0.15 * Math.sin(t * 3 + p.seed) + 0.6 * p.pulse
    c.glows.quad(base, p.n1, p.n2, R * 1.25, R * 1.25, tint(p.pal.main, 1, 0.4 * I * breathe))
    c.rings.quad(base, dirAt(rot), dirAt(rot + Math.PI / 2), R, R, tint(p.pal.accent, 1, 0.85 * I))
    c.rings.quad(base.add(p.normal.uniformScale(0.2)), dirAt(-rot * 1.4), dirAt(-rot * 1.4 + Math.PI / 2), R * 0.62, R * 0.62, tint(p.pal.core, 1, 0.55 * I))
    // the hexagram: two triangles drawn rim point to rim point
    for (let k = 0; k < 6; k++) {
      const a = base.add(dirAt(rot + (k * Math.PI) / 3).uniformScale(R * 0.94))
      const b = base.add(dirAt(rot + ((k + 2) * Math.PI) / 3).uniformScale(R * 0.94))
      c.arcGlow.segment(a, b, 1.5 * I, tint(p.pal.main, 1, 0.55 * I), cam.pos)
      c.arcCore.segment(a, b, 0.45 * I, tint(p.pal.core, 1, 0.8 * I), cam.pos)
    }
    for (let k = 0; k < 10; k++) {
      const ang = -rot * 1.8 + (k / 10) * Math.PI * 2
      const fl = 0.7 + 0.3 * flickerNoise(k, p.seed, t, 6)
      c.stars.quadRotated(base.add(dirAt(ang).uniformScale(R * 1.02)).add(p.normal.uniformScale(0.5)), cam.right, cam.up, 1.2 * I * fl, 1.2 * I * fl, tint(p.pal.core, 1, 0.9 * I * fl), ang)
    }
    // a slow pulse rolling outwards
    const w = (t * 0.55 + p.seed) % 1
    c.rings.quad(base, p.n1, p.n2, R * (0.3 + 1.4 * w), R * (0.3 + 1.4 * w), tint(p.pal.accent, 1, 0.5 * I * (1 - w) * (1 - w)))
    p.emit += (12 + 14 * p.stir) * I * dt
    while (p.emit >= 1) {
      p.emit -= 1
      c.motePool.spawn({ pos: this.randomIn(p, R * 0.85, 1), vel: p.normal.uniformScale(randRange(18, 46)), life: randRange(0.9, 1.6), size: randRange(0.8, 1.6), sizeEnd: 0.1, color: Math.random() < 0.3 ? p.pal.core : p.pal.accent, drag: 0.4, turbulence: 12 })
    }
  }

  private drawGravity(p: Patch, I: number, dt: number, cam: CamBasis): void {
    const c = this.canvas
    const t = this.time
    const R = p.radius * (0.3 + 0.7 * smoothstep(0, 1, clamp01(p.age / 0.7)))
    const base = p.pos.add(p.normal.uniformScale(0.6))
    const breathe = 1 + 0.04 * Math.sin(t * 2.2 + p.seed)
    c.glows.quad(base, p.n1, p.n2, R * 1.2, R * 1.2, tint(p.pal.accent, 1, (0.4 + 0.4 * p.pulse) * I))
    c.rings.quad(base, p.n1, p.n2, R * breathe, R * breathe, tint(p.pal.main, 1, 0.8 * I))
    c.rings.quad(base.add(p.normal.uniformScale(0.2)), p.n1, p.n2, R * 0.55 / breathe, R * 0.55 / breathe, tint(p.pal.core, 1, 0.45 * I))
    // rain falling upwards: stars spiral up out of the well
    const tall = lerp(45, 70, clamp01((p.radius - 18) / 16))
    for (let k = 0; k < 16; k++) {
      const f = (t * 0.22 * (1 + p.stir) + k / 16) % 1
      const ang = k * 2.399 + t * 0.8
      const rr = R * 0.75 * (1 - 0.6 * f)
      const pos = base.add(p.n1.uniformScale(Math.cos(ang) * rr)).add(p.n2.uniformScale(Math.sin(ang) * rr)).add(p.normal.uniformScale(f * tall))
      const a = Math.sin(f * Math.PI)
      c.stars.quadRotated(pos, cam.right, cam.up, 1.4 * a * I, 1.4 * a * I, tint(k % 3 === 0 ? p.pal.core : p.pal.main, 1, 0.85 * a * I), ang)
    }
    if (Math.random() < 6 * I * dt) c.motePool.spawn({ pos: this.randomIn(p, R, 1), vel: p.normal.uniformScale(randRange(8, 20)), life: randRange(1.5, 2.5), size: randRange(0.6, 1.2), sizeEnd: 0.1, color: p.pal.main, drag: 0.2, turbulence: 8 })
  }

  private updateStrikes(dt: number, cam: CamBasis): void {
    const c = this.canvas
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i]
      s.age += dt
      const t = s.age / s.dur
      if (t >= 1) {
        this.strikes.splice(i, 1)
        continue
      }
      const fade = 1 - t * t
      const len = s.from.distance(s.to)
      c.arc(s.from, s.to, Math.max(8, Math.round(len / 10)), len * 0.07, s.seed, this.time, 5 * fade, 1.1 * fade, tint(s.pal.main, 1, 0.9 * fade), tint(s.pal.core, 1, fade), cam.pos)
      c.glows.quad(s.to, cam.right, cam.up, 11 * fade, 11 * fade, tint(s.pal.core, 1, 0.9 * fade))
    }
  }

  private updateFlashes(dt: number, cam: CamBasis): void {
    const c = this.canvas
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]
      f.age += dt
      const t = f.age / f.dur
      if (t >= 1) {
        this.flashes.splice(i, 1)
        continue
      }
      const fade = (1 - t) * (1 - t)
      const r = f.size * smoothstep(0, 1, t)
      const at = f.pos.add(f.normal.uniformScale(0.8))
      c.rings.quad(at, f.n1, f.n2, r, r, tint(f.pal.main, 1, 0.9 * fade))
      c.rings.quad(at, f.n1, f.n2, r * 0.6, r * 0.6, tint(f.pal.core, 1, 0.7 * fade))
      c.glows.quad(f.pos, cam.right, cam.up, f.size * (0.4 + 0.5 * t), f.size * (0.4 + 0.5 * t), tint(f.pal.core, 1, 0.8 * fade))
    }
  }

  // ── Magic on people ─────────────────────────────────────────────────────────

  /** True while a tracked person is wearing an enchantment. */
  get bodyEnchanted(): boolean {
    return this.enchant !== null && !this.enchant.dying
  }

  /** A cast landed on a tracked person: they wear the element until it fades (or reacts). */
  enchantBody(element: PowerId, power: number, at: vec3, fromRemote = false): void {
    if (element === PowerId.Portal) return
    if (!fromRemote && this.onLocalEnchant) this.onLocalEnchant(element, power, at)
    const cur = this.enchant
    const pal = ELEMENT_PALETTES[element]
    const toCam = vec3.up()
    if (cur && !cur.dying && cur.element !== element) {
      const reaction = this.reactionFor(element, cur.element)
      if (reaction === "steam" || reaction === "shatter") {
        cur.dying = true
        if (reaction === "steam") {
          this.steam(at, toCam, 30)
          playOneShotAt(this.sfxRoot, MagicSfx.fireIgnite, at, 0.7)
        } else {
          this.shatter(at, toCam, 30)
          playOneShotAt(this.sfxRoot, MagicSfx.iceImpact, at, 1)
        }
        this.spellEvent.invoke({ spell: reaction, position: at, surface: "person" })
        return
      }
      if (reaction === "firestorm") {
        this.enchant = { element: PowerId.Fireball, pal: ELEMENT_PALETTES[PowerId.Fireball], age: 0, life: 11, presence: cur.presence, dying: false, charged: true, emit: 0, seed: cur.seed }
        this.burstParticles(PowerId.Lightning, at, toCam, 1.4)
        playOneShotAt(this.sfxRoot, MagicSfx.lightningBolt, at, 0.8)
        this.spellEvent.invoke({ spell: "firestorm", position: at, surface: "person" })
        return
      }
      if (reaction === "amplify") {
        const keep = element === PowerId.EnergySphere ? cur.element : element
        this.enchant = { element: keep, pal: ELEMENT_PALETTES[keep], age: 0, life: 14, presence: cur.presence, dying: false, charged: cur.charged, emit: 0, seed: cur.seed }
        this.burstParticles(PowerId.EnergySphere, at, toCam, 1.4)
        playOneShotAt(this.sfxRoot, MagicSfx.energyImpact, at, 0.9)
        this.spellEvent.invoke({ spell: "amplify", position: at, surface: "person" })
        return
      }
    }
    this.enchant = { element, pal, age: 0, life: lerp(7, 11, clamp01(power)), presence: cur && !cur.dying ? cur.presence : 0, dying: false, charged: false, emit: 0, seed: Math.random() * 100 }
    this.burstParticles(element, at, toCam, 1)
    this.impactSound(element, at)
    this.spellEvent.invoke({ spell: IMPRINT_SPELL[element], position: at, surface: "person" })
  }

  /** Another player's cast landed on the wearer: the element flares around them for a few seconds. */
  enchantSelf(element: PowerId, power: number): void {
    if (element === PowerId.Portal) return
    this.selfHit = { element, pal: ELEMENT_PALETTES[element], age: 0, life: lerp(4, 7, clamp01(power)), seed: Math.random() * 100 }
    this.impactSound(element, this.headAt)
  }

  /**
   * Being hit is drawn where the wearer can see it: rising from the lower edge of their view and on
   * both hands (their own body is outside the display).
   */
  private updateSelf(dt: number, cam: CamBasis, left: HandPose, right: HandPose): void {
    const hit = this.selfHit
    if (!hit) return
    hit.age += dt
    const f = hit.age / hit.life
    if (f >= 1) {
      this.selfHit = null
      return
    }
    const I = Math.min(1, hit.age * 4) * (1 - f * f)
    const c = this.canvas
    const t = this.time
    const pal = hit.pal
    const up = cam.up
    const spots: vec3[] = []
    const edge = cam.pos.add(cam.look.uniformScale(55)).sub(up.uniformScale(13))
    for (let k = 0; k < 6; k++) spots.push(edge.add(cam.right.uniformScale(-22 + k * 8.8)))
    if (left.confidence > 0.3) spots.push(left.palmCenter)
    if (right.confidence > 0.3) spots.push(right.palmCenter)
    for (let i = 0; i < spots.length; i++) {
      const j = spots[i]
      const nz = flickerNoise(i, hit.seed, t, 10)
      c.glows.quad(j, cam.right, up, 7 * I, 7 * I, tint(pal.main, 1, 0.3 * I))
      if (hit.element === PowerId.Fireball) {
        const h = 11 * (0.6 + 0.4 * (0.5 + 0.5 * nz)) * I
        c.flames.quad(j.add(up.uniformScale(h * 0.45)), cam.right, up, h * 0.3, h * 0.5, tint(i % 2 === 0 ? pal.core : pal.main, 1, 0.8 * I))
      } else if (hit.element === PowerId.Ice) {
        const len = (6 + 3 * Math.abs(hash1(i * 2.3 + hit.seed))) * Math.min(1, hit.age * 2) * I
        c.crystals.quad(j.add(up.uniformScale(len * 0.5)), cam.right, up, len * 0.2, len * 0.5, tint(i % 2 === 0 ? pal.core : pal.main, 1, 0.85 * I))
      } else if (hit.element === PowerId.Lightning) {
        if (i + 1 < spots.length && nz > -0.2) c.arc(j, spots[i + 1], 6, j.distance(spots[i + 1]) * 0.3, hit.seed + i * 3.1, t, 2.2 * I, 0.5 * I, tint(pal.main, 1, 0.75 * I), tint(pal.core, 1, I), cam.pos)
      } else {
        const a = t * 2.2 + i
        c.stars.quadRotated(j.add(cam.right.uniformScale(Math.cos(a) * 4)).add(up.uniformScale(Math.sin(a) * 4)), cam.right, up, 1.2 * I, 1.2 * I, tint(pal.core, 1, 0.85 * I), a)
      }
    }
  }

  private updateBody(dt: number, cam: CamBasis): void {
    const body = this.body
    if (!body) return
    const c = this.canvas
    const t = this.time
    const tracked = body.isTracking()
    const points = tracked ? body.bodyPoints() : []
    const bones = tracked ? body.bodyBones() : []
    const n = points.length
    const en = this.enchant

    if (!en) {
      // No enchantment. While the wearer holds an orb a tracked person glows faintly in its colour —
      // "you can cast on them" — and brightens when the reticle is on them.
      if (this.bodyHint) this.hintColor = this.bodyHint
      const level = this.bodyHint ? (this.bodyHintStrong ? 1 : 0.6) : 0
      this.hintShown = approach(this.hintShown, tracked ? level : 0, 6, dt)
      const h = this.hintShown
      if (h > 0.02) {
        const pulse = 0.8 + 0.2 * Math.sin(t * 5)
        const k = 0.3 * h * pulse
        body.setAura(this.hintColor.x * k, this.hintColor.y * k, this.hintColor.z * k)
        this.bodyAuraOn = true
        for (let i = 0; i < n; i++) c.glows.quad(points[i], cam.right, cam.up, 6.5 * h, 6.5 * h, tint(this.hintColor, 1, 0.32 * h * pulse))
        for (let i = 0; i + 1 < bones.length; i += 2) c.arcGlow.segment(points[bones[i]], points[bones[i + 1]], 7 * h, tint(this.hintColor, 1, 0.3 * h * pulse), cam.pos)
      } else {
        if (this.bodyAuraOn) {
          body.setAura(0, 0, 0)
          this.bodyAuraOn = false
        }
        // the editor's stand-in is always faintly marked, so it can be found
        if (body.isMock) {
          for (let i = 0; i < n; i++) c.glows.quad(points[i], cam.right, cam.up, 3.5, 3.5, tint(MOCK_TINT, 1, 0.22))
          for (let i = 0; i + 1 < bones.length; i += 2) c.arcGlow.segment(points[bones[i]], points[bones[i + 1]], 2.5, tint(MOCK_TINT, 1, 0.16), cam.pos)
        }
      }
      return
    }

    en.age += dt
    if (en.age > en.life) en.dying = true
    en.presence = approach(en.presence, en.dying || !tracked ? 0 : 1, en.dying ? 2.5 : 5, dt)
    if (en.dying && en.presence < 0.02) {
      this.enchant = null
      this.hintShown = 0
      body.setAura(0, 0, 0)
      this.bodyAuraOn = false
      return
    }
    const I = en.presence
    const pal = en.pal
    const flick = en.element === PowerId.Fireball || en.element === PowerId.Lightning ? 0.75 + 0.25 * flickerNoise(3, en.seed, t, 14) : 0.9 + 0.1 * Math.sin(t * 3)
    const k = 0.55 * I * flick
    body.setAura(pal.main.x * k, pal.main.y * k, pal.main.z * k)
    this.bodyAuraOn = true
    if (n === 0 || I < 0.02) return
    let lo = points[0]
    let hi = points[0]
    for (const j of points) {
      if (j.y < lo.y) lo = j
      if (j.y > hi.y) hi = j
    }
    const up = vec3.up()
    const side = sideAxisFor(up, cam)
    // A glow along every limb draws the person's own silhouette in the element's colour, whether
    // or not the body mesh is showing; lightning also crawls along the limbs.
    for (let i = 0; i + 1 < bones.length; i += 2) {
      const a = points[bones[i]]
      const b = points[bones[i + 1]]
      c.arcGlow.segment(a, b, 11 * I, tint(pal.main, 1, 0.32 * I * flick), cam.pos)
      c.arcCore.segment(a, b, 3 * I, tint(pal.core, 1, 0.3 * I * flick), cam.pos)
      if (en.element === PowerId.Lightning && flickerNoise(i + 9, en.seed, t, 9) > -0.2) {
        c.arc(a, b, 6, a.distance(b) * 0.3, en.seed + i * 3.1, t, 2.6 * I, 0.6 * I, tint(pal.main, 1, 0.75 * I), tint(pal.core, 1, I), cam.pos)
      }
    }
    for (let i = 0; i < n; i++) {
      const j = points[i]
      c.glows.quad(j, cam.right, cam.up, 10 * I, 10 * I, tint(pal.main, 1, 0.3 * I * flick))
      switch (en.element) {
        case PowerId.Fireball: {
          for (let f = 0; f < 2; f++) {
            const nz = flickerNoise(i * 2 + f, en.seed, t, 10)
            const h = (20 + 9 * f) * (0.6 + 0.4 * (0.5 + 0.5 * nz)) * I * (en.charged ? 1.3 : 1)
            c.flames.quad(j.add(up.uniformScale(h * 0.4)).add(side.uniformScale((f - 0.5) * 6 + nz * 1.5)), side, up, h * 0.3, h * 0.5, tint(f === 0 ? pal.core : pal.main, 1, 0.82 * I))
          }
          break
        }
        case PowerId.Ice: {
          const shards = i % 2 === 0 ? 2 : 1
          for (let f = 0; f < shards; f++) {
            const a = hash1(i * 5.1 + f * 3.3 + en.seed) * Math.PI
            const dir = cam.right.uniformScale(Math.cos(a) * 0.7).add(up.uniformScale(0.5 + 0.4 * Math.abs(Math.sin(a)))).normalize()
            const len = (11 + 7 * Math.abs(hash1(i * 2.3 + f))) * smoothstep(0, 1.2, en.age) * I
            c.crystals.quad(j.add(dir.uniformScale(len * 0.5 + 3)), sideAxisFor(dir, cam), dir, len * 0.2, len * 0.5, tint(f === 0 ? pal.core : pal.main, 1, 0.85 * I))
          }
          break
        }
        case PowerId.Lightning: {
          // sparks spit off every point; the arcs themselves run along the limbs (above)
          const fl = 0.5 + 0.5 * flickerNoise(i + 40, en.seed, t, 12)
          c.sparks.quadRotated(j, cam.right, cam.up, 1.2 * fl * I, 3.2 * fl * I, tint(pal.core, 1, 0.85 * fl * I), t * 3 + i)
          break
        }
        default: {
          // energy / gravity: stars orbit each point
          for (let f = 0; f < 2; f++) {
            const a = t * (en.element === PowerId.EnergySphere ? 2.4 : 1.1) + f * Math.PI + i
            const p = j.add(cam.right.uniformScale(Math.cos(a) * 7)).add(up.uniformScale(Math.sin(a) * 7))
            c.stars.quadRotated(p, cam.right, cam.up, 1.3 * I, 1.3 * I, tint(f === 0 ? pal.core : pal.accent, 1, 0.85 * I), a)
          }
          break
        }
      }
    }
    // rings sweeping up the body for energy and gravity
    if (en.element === PowerId.EnergySphere || en.element === PowerId.Telekinesis) {
      for (let r = 0; r < 3; r++) {
        const f = (t * 0.4 + r / 3) % 1
        const at = vec3.lerp(lo, hi, f)
        const a = Math.sin(f * Math.PI)
        c.rings.quad(at, cam.right, cam.look, 26 * a, 26 * a, tint(pal.accent, 1, 0.6 * a * I))
      }
    }
    en.emit += 30 * I * dt
    while (en.emit >= 1) {
      en.emit -= 1
      const j = points[Math.floor(Math.random() * n) % n].add(randomUnitVector().uniformScale(6))
      if (en.element === PowerId.Fireball) c.motePool.spawn({ pos: j, vel: up.uniformScale(randRange(25, 55)).add(randomUnitVector().uniformScale(8)), life: randRange(0.7, 1.4), size: randRange(0.9, 2), sizeEnd: 0.15, color: Math.random() < 0.25 ? pal.core : pal.accent, drag: 0.6, gravity: -14, turbulence: 35 })
      else if (en.element === PowerId.Ice) c.motePool.spawn({ pos: j, vel: up.uniformScale(-randRange(4, 14)), life: randRange(1, 2), size: randRange(0.8, 1.6), sizeEnd: 0.1, color: pal.core, drag: 0.5, turbulence: 14 })
      else if (en.element === PowerId.Lightning) c.sparkPool.spawn({ pos: j, vel: randomUnitVector().uniformScale(randRange(40, 120)), life: randRange(0.15, 0.3), size: randRange(1, 2.2), sizeEnd: 0.1, color: pal.core, drag: 3 })
      else c.starPool.spawn({ pos: j, vel: up.uniformScale(en.element === PowerId.Telekinesis ? randRange(15, 40) : randRange(-5, 20)), life: randRange(0.6, 1.2), size: randRange(1, 2.2), sizeEnd: 0.2, color: Math.random() < 0.4 ? pal.core : pal.main, drag: 0.6, spin: randRange(-4, 4) })
    }
  }
}
