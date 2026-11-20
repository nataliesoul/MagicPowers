/**
 * MagicPowersSpellManager — the "active power" concept and gesture routing (pure logic, no scene access).
 *
 * Owns: the registry of MagicPower instances, which one is active, which powers are available
 *       (wired vs. stub), suppression of a hand that is busy with the spell selector, and the
 *       Free Magic mode flag (the only mode shipped in this pass; Training / Target Practice /
 *       Combat plug in here as further modes).
 * Expects: powers registered by MagicPowersMain before the first tick.
 * Must not: read hand data itself, create objects, or render anything.
 */

import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { GestureEvent, GestureType, HandPose, HandSide, MagicPower, POWER_NAMES, PowerId, TwoHandState } from "./MagicPowersTypes"

export enum GameMode {
  FreeMagic = 0,
  // SpellTraining, TargetPractice, MagicCombat — reserved for later passes.
}

export class SpellManager {
  private powers = new Map<PowerId, MagicPower>()
  private available = new Map<PowerId, boolean>()
  private activeId: PowerId | null = null
  private suppressedHand: HandSide | null = null
  private onActiveChangedEvent = new Event<PowerId>()
  mode: GameMode = GameMode.FreeMagic

  get onActivePowerChanged(): PublicApi<PowerId> {
    return this.onActiveChangedEvent.publicApi()
  }

  register(power: MagicPower, isAvailable: boolean): void {
    this.powers.set(power.powerId, power)
    this.available.set(power.powerId, isAvailable)
  }

  isAvailable(id: PowerId): boolean {
    return this.available.get(id) === true
  }

  hasPower(id: PowerId): boolean {
    return this.powers.has(id)
  }

  /** The power registered for an element (active or not). */
  get(id: PowerId): MagicPower | null {
    return this.powers.get(id) ?? null
  }

  get activePowerId(): PowerId | null {
    return this.activeId
  }

  get activePower(): MagicPower | null {
    return this.activeId === null ? null : this.powers.get(this.activeId) ?? null
  }

  /** Switch the active power. The previous power is deactivated first so only one renders at a time. */
  setActive(id: PowerId): boolean {
    const next = this.powers.get(id)
    if (!next) {
      console.warn(`[SpellManager] No power registered for ${POWER_NAMES[id]}`)
      return false
    }
    if (this.activeId === id) return true
    const prev = this.activePower
    if (prev) prev.deactivate()
    this.activeId = id
    next.activate()
    this.onActiveChangedEvent.invoke(id)
    return true
  }

  /** A hand holding the spell selector open does not cast. */
  setSuppressedHand(hand: HandSide | null): void {
    this.suppressedHand = hand
  }

  handleGesture(e: GestureEvent): void {
    const power = this.activePower
    if (!power) return
    if (this.suppressedHand !== null && e.hand === this.suppressedHand) {
      // Always let tracking events through so the power can fade gracefully.
      if (e.type !== GestureType.TrackingLost && e.type !== GestureType.TrackingAcquired) return
    }
    power.onGesture(e)
  }

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    const power = this.activePower
    if (!power) return
    power.tick(dt, left, right, two)
  }
}
