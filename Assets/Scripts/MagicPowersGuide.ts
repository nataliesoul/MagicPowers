/**
 * MagicPowersGuide — the journey: onboarding, the spellbook, and the way back to the start.
 *
 * Owns: the three-step gesture onboarding (summon → cast → change element), each step shown as a
 *       short caption and completed by actually doing it; the spellbook of ten discoveries (six
 *       elemental imprints and four reactions) with its hints, world-space toasts and progress;
 *       the mastery finale; and the saved progress that lets a returning wearer skip the lesson.
 * Expects: notify*() calls from the orchestrator and update() once per frame between
 *       canvas.begin()/end().
 * Must not: read hands or change game state — it watches and tells.
 *
 * Arc:  beginning — learn the three gestures  ·  middle — discover every spell and reaction
 *       end — Archmage  ·  again — raise both palms to begin a new journey
 */

import { ELEMENT_PALETTES, OrbState, PowerId, SPELL_ORDER, SpellId, SurfaceKind } from "./MagicPowersTypes"
import { CamBasis, FadingLabel, FxCanvas, approach, approachVec, tint } from "./MagicPowersEffectsLib"

const SPELLS: Record<SpellId, { name: string; hint: string }> = {
  ignite: { name: "Ignite", hint: "Cast Fire at the floor" },
  storm: { name: "Storm Cell", hint: "Cast Lightning at a surface" },
  sigil: { name: "Arcane Sigil", hint: "Cast Energy at a surface" },
  frost: { name: "Frost", hint: "Cast Ice at a surface" },
  gravity: { name: "Gravity Well", hint: "Cast Gravity at the floor" },
  gateway: { name: "Gateway", hint: "Cast Portal at a wall" },
  steam: { name: "Steam", hint: "Cast Ice onto Fire" },
  shatter: { name: "Shatter", hint: "Strike Ice with Lightning" },
  firestorm: { name: "Firestorm", hint: "Strike Fire with Lightning" },
  amplify: { name: "Amplify", hint: "Cast Energy onto another spell" },
}

const REACTIONS: SpellId[] = ["steam", "shatter", "firestorm", "amplify"]

/** Onboarding steps, in order. 3 = finished. */
const STEP_TEXT: Array<[string, string]> = [
  ["Cradle an invisible ball", "Hold your palms facing each other"],
  ["Look at the floor or a wall", "Push both hands forward to cast"],
  ["Turn one palm up", "Pinch to change your element"],
]

const KEY_SPELLS = "magicpowers_spells"
const KEY_TUTORIAL = "magicpowers_tutorial"
const CAPTION_DISTANCE = 95
const WHITE = new vec4(1, 1, 1, 1)
const GOLD = new vec4(1, 0.9, 0.6, 1)

interface Toast {
  label: FadingLabel
  pos: vec3
  /** How far (cm) it drifts upward over its life — scaled with distance so it reads the same anywhere. */
  rise: number
  age: number
  dur: number
  live: boolean
}

export class MagicGuide {
  /** Fired once when the last spell is discovered. */
  onMastery: (() => void) | null = null

  private title: FadingLabel
  private sub: FadingLabel
  private toasts: Toast[] = []
  private step = 0
  private found: boolean[] = []
  private mastered = false
  private captionAlpha = 0
  private captionFor = 0
  private sticky = false
  private anchor: vec3 | null = null
  private gliding = true
  private idle = 0
  private time = 0
  private queued: Array<{ title: string; sub: string; hold: number }> = []
  private ghostAt: vec3 | null = null
  private ghostAmt = 0

  constructor(parent: SceneObject, private canvas: FxCanvas, private persist: boolean) {
    this.title = new FadingLabel(parent, "GuideTitle", 100, WHITE)
    this.sub = new FadingLabel(parent, "GuideSub", 72, GOLD)
    for (let i = 0; i < 3; i++) this.toasts.push({ label: new FadingLabel(parent, `Toast_${i}`, 96, WHITE), pos: vec3.zero(), rise: 10, age: 0, dur: 1, live: false })
    for (let i = 0; i < SPELL_ORDER.length; i++) this.found.push(false)
    this.load()
    if (this.step < 3) this.showStep()
    else this.say("Welcome back, mage", this.progressLine(), 4)
  }

  // ── State ───────────────────────────────────────────────────────────────────

  get tutorialDone(): boolean {
    return this.step >= 3
  }

  get isMastered(): boolean {
    return this.mastered
  }

  get foundCount(): number {
    let n = 0
    for (const f of this.found) if (f) n++
    return n
  }

  private progressLine(): string {
    return `Spellbook ${this.foundCount} of ${SPELL_ORDER.length}`
  }

  private nextHint(): string {
    for (let i = 0; i < SPELL_ORDER.length; i++) if (!this.found[i]) return SPELLS[SPELL_ORDER[i]].hint
    return ""
  }

  private load(): void {
    if (!this.persist) return
    try {
      const store = global.persistentStorageSystem.store
      const mask = store.getInt(KEY_SPELLS)
      for (let i = 0; i < this.found.length; i++) this.found[i] = (mask & (1 << i)) !== 0
      if (store.getInt(KEY_TUTORIAL) === 1) this.step = 3
      this.mastered = this.foundCount === this.found.length
    } catch (e) {
      // no storage in this configuration — the journey simply starts fresh
    }
  }

  private save(): void {
    if (!this.persist) return
    try {
      const store = global.persistentStorageSystem.store
      let mask = 0
      for (let i = 0; i < this.found.length; i++) if (this.found[i]) mask |= 1 << i
      store.putInt(KEY_SPELLS, mask)
      store.putInt(KEY_TUTORIAL, this.step >= 3 ? 1 : 0)
    } catch (e) {
      // non-fatal
    }
  }

  /** Start over: the spellbook empties (the gestures, once learned, are not re-taught). */
  reset(): void {
    for (let i = 0; i < this.found.length; i++) this.found[i] = false
    this.mastered = false
    this.idle = 0
    this.queued.length = 0
    this.save()
    this.say("A new journey", "Your spellbook is empty again", 4.5)
  }

  // ── What the orchestrator tells us ──────────────────────────────────────────

  /** A released orb reached a surface or a person. */
  notifyImpact(): void {
    if (this.step === 1) this.advance()
  }

  /** The wearer changed element with the palm-up pinch. */
  notifyElementChanged(): void {
    if (this.step === 2) this.advance()
  }

  /** A spell or reaction happened in the world. */
  notifySpell(spell: SpellId, position: vec3, surface: SurfaceKind, cam: CamBasis): void {
    const i = SPELL_ORDER.indexOf(spell)
    if (i < 0) return
    const isNew = !this.found[i]
    const isReaction = REACTIONS.indexOf(spell) >= 0
    // Toasts sit a little below the spell in the wearer's view: captions own the space above the
    // centre of view and the effect itself rises from the hit point, so below is the clear spot.
    const lift = position.sub(cam.up.uniformScale(0.07 * position.distance(cam.pos)))
    if (isNew) {
      this.found[i] = true
      this.idle = 0
      this.save()
      this.toast(`New spell: ${SPELLS[spell].name}`, lift, GOLD, cam, 2.8)
      if (this.step >= 3) {
        if (this.foundCount === this.found.length) this.master()
        else this.say(SPELLS[spell].name, this.progressLine(), 3)
      }
    } else if (isReaction) this.toast(SPELLS[spell].name, lift, WHITE, cam, 1.8)
    else if (surface === "person") this.toast("Enchanted", lift, WHITE, cam, 1.6)
  }

  private advance(): void {
    this.step++
    if (this.step < 3) {
      this.showStep()
      return
    }
    this.save()
    this.sticky = false
    this.say("You are ready", "Mix elements to fill your spellbook", 4.5)
    if (this.foundCount === this.found.length) this.master()
  }

  private master(): void {
    if (this.mastered) return
    this.mastered = true
    this.save()
    this.queued.length = 0
    this.say("Archmage", "Every spell is yours", 6)
    this.queued.push({ title: "Begin a new journey?", sub: "Raise both palms to the sky and hold", hold: 9 })
    if (this.onMastery) this.onMastery()
  }

  // ── Captions + toasts ───────────────────────────────────────────────────────

  private showStep(): void {
    const [title, sub] = STEP_TEXT[this.step]
    this.title.setText(title)
    this.sub.setText(sub)
    this.sticky = true
    this.captionFor = 0
  }

  /** Show a two-line caption for a few seconds. */
  say(title: string, sub: string, hold: number): void {
    this.title.setText(title)
    this.sub.setText(sub)
    this.sticky = false
    this.captionFor = hold
  }

  private toast(text: string, pos: vec3, color: vec4, cam: CamBasis, dur: number): void {
    let slot = this.toasts[0]
    for (const t of this.toasts) {
      if (!t.live) {
        slot = t
        break
      }
      if (t.age / t.dur > slot.age / slot.dur) slot = t
    }
    slot.live = true
    slot.age = 0
    slot.dur = dur
    slot.pos = pos
    slot.rise = 0.025 * pos.distance(cam.pos)
    slot.label.setText(text)
    slot.label.setColor(color)
    // keep the words a constant apparent size wherever in the room the spell landed
    slot.label.setSize(Math.max(60, Math.min(300, 92 * (pos.distance(cam.pos) / 100))))
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  /**
   * @param orb         the orb between the hands (step 0 completes when it is well charged)
   * @param resetHold   0..1 progress of the both-palms-up "new journey" hold
   * @param resetAt     where to draw that progress
   */
  update(dt: number, cam: CamBasis, orb: OrbState, resetHold: number, resetAt: vec3): void {
    this.time += dt
    if (this.step === 0 && orb.charge > 0.55) this.advance()

    // Caption timing
    if (!this.sticky) {
      if (this.captionFor > 0) this.captionFor -= dt
      else if (this.captionAlpha < 0.03 && this.queued.length > 0) {
        const q = this.queued.shift()!
        this.say(q.title, q.sub, q.hold)
      }
    }
    const wantCaption = this.sticky || this.captionFor > 0
    this.captionAlpha = approach(this.captionAlpha, wantCaption ? 1 : 0, wantCaption ? 6 : 3, dt)

    // A nudge towards the next undiscovered spell after a quiet spell of play
    if (this.step >= 3 && !this.mastered) {
      this.idle += dt
      if (this.idle > 22 && this.captionFor <= 0) {
        this.idle = 0
        this.say("Try this", this.nextHint(), 6)
      }
    }

    // The caption floats just above the centre of view and follows lazily, so it never chases the head
    const want = cam.pos.add(cam.look.uniformScale(CAPTION_DISTANCE)).add(cam.up.uniformScale(11))
    if (!this.anchor) this.anchor = want
    const off = this.anchor.distance(want)
    if (off > 26) this.gliding = true
    if (this.gliding) {
      this.anchor = approachVec(this.anchor, want, 4, dt)
      if (off < 2) this.gliding = false
    }
    this.title.setAlpha(this.captionAlpha)
    this.sub.setAlpha(this.captionAlpha * 0.95)
    if (this.captionAlpha > 0.02) {
      this.title.place(this.anchor, cam)
      this.sub.place(this.anchor.sub(vec3.up().uniformScale(5)), cam)
    }

    for (const t of this.toasts) {
      if (!t.live) continue
      t.age += dt
      const f = t.age / t.dur
      if (f >= 1) {
        t.live = false
        t.label.setAlpha(0)
        continue
      }
      t.label.setAlpha(Math.min(1, f * 6) * Math.min(1, (1 - f) * 3))
      t.label.place(t.pos.add(cam.up.uniformScale(t.rise * f)), cam)
    }

    this.drawGhost(dt, cam, orb)
    if (resetHold > 0.01) this.drawResetRing(resetHold, resetAt, cam)
  }

  /**
   * Step 0's invitation: a faint orb with a palm of light on either side, hanging where the hands
   * should go. It fades the moment a real orb starts to form.
   */
  private drawGhost(dt: number, cam: CamBasis, orb: OrbState): void {
    const want = this.step === 0 && orb.presence < 0.1
    this.ghostAmt = approach(this.ghostAmt, want ? 1 : 0, 4, dt)
    if (this.ghostAmt < 0.02) return
    const target = cam.pos.add(cam.look.uniformScale(42)).sub(cam.up.uniformScale(9))
    if (!this.ghostAt || this.ghostAt.distance(target) > 22) this.ghostAt = this.ghostAt ? approachVec(this.ghostAt, target, 3, dt) : target
    const c = this.canvas
    const g = this.ghostAmt
    const at = this.ghostAt
    const pal = ELEMENT_PALETTES[PowerId.Fireball]
    const breathe = 1 + 0.08 * Math.sin(this.time * 2.4)
    c.rings.quad(at, cam.right, cam.up, 5 * breathe, 5 * breathe, tint(pal.core, 1, 0.4 * g))
    c.glows.quad(at, cam.right, cam.up, 6 * breathe, 6 * breathe, tint(pal.main, 1, 0.18 * g))
    // two palms of light closing in on the orb, over and over
    const reach = 10 + 4 * (0.5 + 0.5 * Math.cos(this.time * 2.4))
    for (const sign of [-1, 1]) {
      c.glows.quad(at.add(cam.right.uniformScale(sign * reach)), cam.right, cam.up, 2.2, 6.5, tint(pal.core, 1, 0.5 * g))
    }
  }

  private drawResetRing(f: number, at: vec3, cam: CamBasis): void {
    const c = this.canvas
    const dots = 16
    const lit = Math.floor(f * dots)
    for (let k = 0; k < dots; k++) {
      const a = Math.PI / 2 - (k / dots) * Math.PI * 2
      const pos = at.add(cam.right.uniformScale(Math.cos(a) * 9)).add(cam.up.uniformScale(Math.sin(a) * 9))
      const on = k <= lit
      c.stars.quadRotated(pos, cam.right, cam.up, on ? 1.5 : 0.7, on ? 1.5 : 0.7, tint(on ? GOLD : WHITE, 1, on ? 0.95 : 0.3), a)
    }
    c.glows.quad(at, cam.right, cam.up, 7 * f, 7 * f, tint(GOLD, 1, 0.4 * f))
  }
}
