/**
 * MagicPowersElementWheel — choosing an element with gestures alone (no buttons, no panel).
 *
 * Owns: the ring of six elemental wisps that rises above an upturned palm, the turn it makes when
 *       the wearer pinches, and the name caption of the element at the top.
 * Expects: show()/hide() and setActive() from the orchestrator, update() once per frame between
 *       canvas.begin()/end().
 * Must not: decide which power is active or listen to gestures itself.
 *
 * Gesture:  turn a palm up → the wheel appears above it  ·  pinch → it turns to the next element
 */

import { ELEMENT_NAMES, ELEMENT_PALETTES, POWER_COUNT, PowerId } from "./MagicPowersTypes"
import { CamBasis, FadingLabel, FxCanvas, approach, tint } from "./MagicPowersEffectsLib"

const WHEEL_RADIUS = 6.5
const STEP = (Math.PI * 2) / POWER_COUNT

export class ElementWheel {
  private amount = 0
  private wanted = false
  private active: PowerId = PowerId.Fireball
  /** Continuous wheel position in element steps; eases towards `active` the short way round. */
  private turn = 0
  private kick = 0
  private time = 0
  private centre: vec3 = vec3.zero()
  private name: FadingLabel
  private hint: FadingLabel
  /** The "pinch to change" line stops showing once the wearer has clearly got it. */
  private pinchesSeen = 0
  private labelled = -1

  constructor(parent: SceneObject, private canvas: FxCanvas, private heightCm: number) {
    this.name = new FadingLabel(parent, "WheelName", 62, new vec4(1, 1, 1, 1))
    this.hint = new FadingLabel(parent, "WheelHint", 38, new vec4(0.85, 0.88, 0.95, 1))
    this.hint.setText("pinch to change")
  }

  get isVisible(): boolean {
    return this.wanted
  }

  get position(): vec3 {
    return this.centre
  }

  show(): void {
    this.wanted = true
  }

  hide(): void {
    this.wanted = false
  }

  setActive(id: PowerId, byPinch: boolean): void {
    this.active = id
    if (byPinch) {
      this.kick = 1
      this.pinchesSeen++
    }
  }

  update(dt: number, palm: vec3, cam: CamBasis): void {
    this.time += dt
    this.amount = approach(this.amount, this.wanted ? 1 : 0, this.wanted ? 9 : 7, dt)
    this.kick = Math.max(0, this.kick - dt * 3)
    // ease the wheel round the short way
    let delta = this.active - this.turn
    while (delta > POWER_COUNT / 2) delta -= POWER_COUNT
    while (delta < -POWER_COUNT / 2) delta += POWER_COUNT
    this.turn += delta * (1 - Math.exp(-11 * dt))

    const a = this.amount
    if (a < 0.02) {
      this.name.setAlpha(0)
      this.hint.setAlpha(0)
      return
    }
    const target = palm.add(vec3.up().uniformScale(this.heightCm))
    this.centre = a < 0.1 ? target : vec3.lerp(this.centre, target, 1 - Math.exp(-14 * dt))
    const c = this.canvas
    const t = this.time
    const centre = this.centre
    // a thread of light ties the wheel to the palm it rose from
    for (let k = 0; k < 3; k++) {
      const f = (k + 1) / 4
      c.glows.quad(vec3.lerp(palm, centre, f * 0.6), cam.right, cam.up, 2.4 * a * (1 - f * 0.5), 2.4 * a * (1 - f * 0.5), tint(ELEMENT_PALETTES[this.active].main, 1, 0.22 * a))
    }
    for (let k = 0; k < POWER_COUNT; k++) {
      let off = k - this.turn
      while (off > POWER_COUNT / 2) off -= POWER_COUNT
      while (off < -POWER_COUNT / 2) off += POWER_COUNT
      const ang = Math.PI / 2 - off * STEP // the active element sits at the top
      const closeness = Math.max(0, 1 - Math.abs(off))
      const s = (1.15 + 0.6 * closeness + 0.35 * this.kick * closeness) * a
      const alpha = (0.75 + 0.25 * closeness) * a
      const pos = centre.add(cam.right.uniformScale(Math.cos(ang) * WHEEL_RADIUS * a)).add(cam.up.uniformScale(Math.sin(ang) * WHEEL_RADIUS * a))
      this.drawWisp(k as PowerId, pos, s, alpha, cam)
      if (closeness > 0.5) {
        const beat = 1 + 0.06 * Math.sin(t * 5)
        c.rings.quad(pos, cam.right, cam.up, 2.5 * s * beat, 2.5 * s * beat, tint(ELEMENT_PALETTES[k].core, 1, 0.55 * alpha * closeness))
      }
    }
    if (this.labelled !== this.active) {
      this.labelled = this.active
      const pal = ELEMENT_PALETTES[this.active]
      this.name.setText(ELEMENT_NAMES[this.active])
      this.name.setColor(new vec4(0.5 + 0.5 * pal.main.x, 0.5 + 0.5 * pal.main.y, 0.5 + 0.5 * pal.main.z, 1))
    }
    this.name.setAlpha(a)
    this.name.place(centre.add(cam.up.uniformScale(WHEEL_RADIUS + 9)), cam)
    this.hint.setAlpha(this.pinchesSeen < 3 ? 0.85 * a : 0)
    this.hint.place(centre.add(cam.up.uniformScale(WHEEL_RADIUS + 6.4)), cam)
  }

  /** A miniature of each element, drawn from the shared batches (no icon textures, no extra draw calls). */
  private drawWisp(id: PowerId, pos: vec3, s: number, alpha: number, cam: CamBasis): void {
    const c = this.canvas
    const pal = ELEMENT_PALETTES[id]
    const t = this.time
    const r = cam.right
    const u = cam.up
    c.glows.quad(pos, r, u, 2.4 * s, 2.4 * s, tint(pal.main, 1, 0.5 * alpha))
    c.glows.quad(pos, r, u, 0.95 * s, 0.95 * s, tint(pal.core, 1, 0.85 * alpha))
    switch (id) {
      case PowerId.Fireball:
        for (let f = 0; f < 3; f++) {
          const h = (1.9 + 0.4 * Math.sin(t * 9 + f * 2.1)) * s * (f === 0 ? 1.15 : 0.85)
          c.flames.quad(pos.add(u.uniformScale(h * 0.45)).add(r.uniformScale((f - 1) * 0.7 * s)), r, u, h * 0.3, h * 0.55, tint(f === 0 ? pal.core : pal.main, 1, 0.85 * alpha))
        }
        break
      case PowerId.Lightning:
        c.arc(pos.add(r.uniformScale(-1.5 * s)).add(u.uniformScale(1.3 * s)), pos.add(r.uniformScale(1.5 * s)).add(u.uniformScale(-1.3 * s)), 5, 0.9 * s, 31, t, 1.4 * s, 0.35 * s, tint(pal.main, 1, 0.8 * alpha), tint(pal.core, 1, alpha), cam.pos)
        break
      case PowerId.EnergySphere:
        for (let f = 0; f < 4; f++) {
          const a = t * 2.6 + f * 1.571
          c.motes.quad(pos.add(r.uniformScale(Math.cos(a) * 1.6 * s)).add(u.uniformScale(Math.sin(a) * 1.6 * s * 0.6)), r, u, 0.45 * s, 0.45 * s, tint(pal.accent, 1, 0.9 * alpha))
        }
        break
      case PowerId.Ice:
        c.flakes.quadRotated(pos, r, u, 1.7 * s, 1.7 * s, tint(pal.core, 1, 0.9 * alpha), t * 0.7)
        break
      case PowerId.Telekinesis:
        c.rings.quad(pos, r, u, 1.6 * s, 1.6 * s, tint(pal.main, 1, 0.85 * alpha))
        c.stars.quadRotated(pos.add(u.uniformScale(0.5 * s * Math.sin(t * 3))), r, u, 0.9 * s, 0.9 * s, tint(pal.core, 1, 0.9 * alpha), t)
        break
      default:
        c.rings.quad(pos, r, u, 1.8 * s, 1.8 * s, tint(pal.main, 1, 0.9 * alpha))
        c.rings.quad(pos, r, u, 1.1 * s, 1.1 * s, tint(pal.accent, 1, 0.6 * alpha))
        break
    }
  }
}
