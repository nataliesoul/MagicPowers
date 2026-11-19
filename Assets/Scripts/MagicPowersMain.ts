/**
 * MagicPowersMain — orchestrator for the Magic Powers experience (Free Magic mode).
 *
 * Owns: lifecycle + reference validation, the EffectsContext handed to every power, the
 *       SpellManager (active power, routing), the palm-up spell-selector flow (show above the
 *       upturned palm, follow it, pinch a symbol with the other hand, hide when the palm drops),
 *       and the editor keyboard shortcuts (1-6 select a power, U toggles the mock palm-up).
 * Expects (wired by the scene bootstrap): the gesture recognizer, the spell selector UI, one
 *       component per power (Fireball, Lightning, Energy, Ice, Telekinesis, Portal), the two glow
 *       materials, the sphere mesh and the effects root.
 * Must not: implement spell mechanics or author UI — powers and the UI module own those.
 */

import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import { MagicPowersGestureRecognizer } from "./MagicPowersGestureRecognizer"
import { MagicPowersSpellSelectorUI } from "./MagicPowersSpellSelectorUI"
import { MagicPowersFireballPower } from "./MagicPowersFireballPower"
import { MagicPowersLightningPower } from "./MagicPowersLightningPower"
import { MagicPowersEnergyPower } from "./MagicPowersEnergyPower"
import { MagicPowersIcePower } from "./MagicPowersIcePower"
import { MagicPowersTelekinesisPower } from "./MagicPowersTelekinesisPower"
import { MagicPowersPortalPower } from "./MagicPowersPortalPower"
import { SpellManager } from "./MagicPowersSpellManager"
import { EffectsContext, GestureEvent, GestureType, HandSide, MagicPower, POWER_NAMES, PowerId } from "./MagicPowersTypes"
import { MagicSfx, MagicTextures } from "./MagicPowersAssetManifest"
import { playOneShotAt, updateOneShots } from "./MagicPowersAudioLib"
import { approachVec } from "./MagicPowersEffectsLib"

@component
export class MagicPowersMain extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">MagicPowersMain – orchestrates gestures, powers and the spell selector</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">References</span>')
  @ui.group_start("References")
  @input
  @hint("Hand-tracking → gesture recognizer component")
  gestureRecognizer!: MagicPowersGestureRecognizer

  @input
  @hint("Floating spell selector UI module")
  spellSelector!: MagicPowersSpellSelectorUI

  @input
  @hint("Fire magic power component")
  fireballPower!: MagicPowersFireballPower

  @input
  @hint("Lightning magic power component")
  lightningPower!: MagicPowersLightningPower

  @input
  @hint("Energy sphere power component")
  energyPower!: MagicPowersEnergyPower

  @input
  @hint("Ice magic power component")
  icePower!: MagicPowersIcePower

  @input
  @hint("Telekinesis power component")
  telekinesisPower!: MagicPowersTelekinesisPower

  @input
  @hint("Portal magic power component")
  portalPower!: MagicPowersPortalPower

  @input
  @hint("Additive UberUnlit material with vertex colour enabled — used for every billboard / ribbon batch")
  glowMaterial!: Material

  @input
  @hint("Additive Unlit material — used for the untextured energy / charge spheres")
  solidMaterial!: Material

  @input
  @hint("Sphere mesh used for charge spheres, energy spheres and projectile cores")
  sphereMesh!: RenderMesh

  @input
  @hint("Parent for every runtime effect object (keeps the hierarchy tidy)")
  effectsRoot!: SceneObject
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Power that is active when the Lens starts")
  @widget(new ComboBoxWidget([new ComboBoxItem("Fireball", 0), new ComboBoxItem("Lightning", 1), new ComboBoxItem("Energy Sphere", 2), new ComboBoxItem("Ice", 3), new ComboBoxItem("Telekinesis", 4), new ComboBoxItem("Portal", 5)]))
  defaultPower: number = 0

  @input
  @hint("How far (cm) above the upturned palm the spell selector floats")
  @widget(new SliderWidget(4, 30, 0.5))
  selectorHeightCm: number = 13

  @input
  @hint("Seconds the selector stays after the palm stops facing up")
  @widget(new SliderWidget(0, 3, 0.1))
  selectorHideDelaySec: number = 0.7

  @input
  @hint("How quickly the selector follows the palm (per second)")
  @widget(new SliderWidget(1, 30, 0.5))
  selectorFollowRate: number = 10

  @input
  @hint("In Lens Studio: keys 1-6 select a power, U toggles the mock palm-up gesture")
  editorKeyboardShortcuts: boolean = true

  @input
  @hint("While the editor mock hands are active, rotate through all six powers automatically so every power can be previewed")
  mockCyclePowers: boolean = true

  @input
  @hint("Seconds each power stays active while mock-cycling")
  @widget(new SliderWidget(3, 30, 0.5))
  mockCycleSec: number = 9
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @ui.group_start("Debug")
  @input
  @hint("Log power switches and selector events")
  debugLogging: boolean = false
  @ui.group_end

  private spells = new SpellManager()
  private ctx: EffectsContext | null = null
  private selectorHand: HandSide | null = null
  private selectorTarget: vec3 = vec3.zero()
  private selectorPos: vec3 = vec3.zero()
  private hideTimer: DelayedCallbackEvent | null = null
  private mockPalmUp = false
  private mockClock = 0
  private started = false

  onAwake(): void {
    if (!this.validateRefs()) return
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    if (this.editorKeyboardShortcuts) this.createEvent("KeyPressEvent").bind((e) => this.onKey(e))
    this.hideTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.hideTimer.bind(() => this.hideSelector())
    this.hideTimer.enabled = false
  }

  private validateRefs(): boolean {
    const missing: string[] = []
    if (!this.gestureRecognizer) missing.push("gestureRecognizer")
    if (!this.spellSelector) missing.push("spellSelector")
    if (!this.fireballPower) missing.push("fireballPower")
    if (!this.lightningPower) missing.push("lightningPower")
    if (!this.energyPower) missing.push("energyPower")
    if (!this.icePower) missing.push("icePower")
    if (!this.telekinesisPower) missing.push("telekinesisPower")
    if (!this.portalPower) missing.push("portalPower")
    if (!this.glowMaterial) missing.push("glowMaterial")
    if (!this.solidMaterial) missing.push("solidMaterial")
    if (!this.sphereMesh) missing.push("sphereMesh")
    if (!this.effectsRoot) missing.push("effectsRoot")
    if (missing.length > 0) {
      console.error(`[MagicPowersMain] Required @input(s) not wired: ${missing.join(", ")}. Check the scene bootstrap (Phase B).`)
      return false
    }
    return true
  }

  private onStart(): void {
    const cameraTransform = WorldCameraFinderProvider.getInstance().getTransform()
    this.ctx = {
      glowMaterial: this.glowMaterial,
      solidMaterial: this.solidMaterial,
      sphereMesh: this.sphereMesh,
      textures: MagicTextures,
      camera: cameraTransform,
      effectsRoot: this.effectsRoot,
    }
    // Spatial audio needs a listener on the head; add one at runtime if the camera has none.
    const cameraObject = cameraTransform.getSceneObject()
    if (!cameraObject.getComponent("Component.AudioListenerComponent")) cameraObject.createComponent("Component.AudioListenerComponent")

    const powers: Array<{ power: MagicPower; available: boolean }> = [
      { power: this.fireballPower, available: true },
      { power: this.lightningPower, available: true },
      { power: this.energyPower, available: true },
      { power: this.icePower, available: true },
      { power: this.telekinesisPower, available: true },
      { power: this.portalPower, available: true },
    ]
    for (const entry of powers) {
      entry.power.setContext(this.ctx)
      this.spells.register(entry.power, entry.available)
      this.spellSelector.setPowerAvailable(entry.power.powerId, entry.available)
    }

    this.spells.onActivePowerChanged.add((id) => {
      this.spellSelector.setActivePower(id)
      if (this.debugLogging) console.log(`[MagicPowersMain] Active power → ${POWER_NAMES[id]}`)
    })
    this.spellSelector.onPowerSelected.add((id) => this.onPowerSelected(id))
    this.gestureRecognizer.onGesture.add((e) => this.onGesture(e))
    this.gestureRecognizer.onFrame.add((dt) => this.onFrame(dt))

    this.spells.setActive(this.defaultPower as PowerId)
    this.spellSelector.setActivePower(this.defaultPower as PowerId)
    this.spellSelector.hide()
    this.started = true
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  private onGesture(e: GestureEvent): void {
    if (e.hand !== "both") {
      if (e.type === GestureType.PalmUp) this.showSelector(e.hand)
      else if (e.type === GestureType.PalmUpEnd && e.hand === this.selectorHand) this.scheduleHide()
      else if (e.type === GestureType.TrackingLost && e.hand === this.selectorHand) this.scheduleHide()
    }
    this.spells.handleGesture(e)
  }

  private onFrame(dt: number): void {
    if (!this.started) return
    const rec = this.gestureRecognizer
    updateOneShots()
    if (this.mockCyclePowers && rec.isMocking) {
      this.mockClock += dt
      const slot = Math.floor(this.mockClock / this.mockCycleSec) % 6
      const wanted = [PowerId.Fireball, PowerId.Lightning, PowerId.EnergySphere, PowerId.Ice, PowerId.Telekinesis, PowerId.Portal][slot]
      if (this.spells.activePowerId !== wanted) {
        this.spells.setActive(wanted)
        this.spellSelector.setActivePower(wanted)
      }
    }
    if (this.selectorHand !== null && this.spellSelector.isVisible) {
      const pose = this.selectorHand === "left" ? rec.left : rec.right
      this.selectorTarget = pose.palmCenter.add(vec3.up().uniformScale(this.selectorHeightCm))
      this.selectorPos = approachVec(this.selectorPos, this.selectorTarget, this.selectorFollowRate, dt)
      this.spellSelector.setWorldPosition(this.selectorPos)
    }
    this.spells.tick(dt, rec.left, rec.right, rec.two)
  }

  private onPowerSelected(id: PowerId): void {
    if (!this.spells.hasPower(id)) return
    const accepted = this.spells.setActive(id)
    this.spellSelector.setActivePower(this.spells.activePowerId ?? id)
    if (accepted && this.ctx) playOneShotAt(this.ctx.effectsRoot, MagicSfx.spellSelect, this.selectorPos, 0.8)
    // Selected power stays active until changed; the selector lingers briefly for confirmation.
    if (this.hideTimer) {
      this.hideTimer.enabled = true
      this.hideTimer.reset(Math.max(0.3, this.selectorHideDelaySec))
    }
  }

  // ── Selector flow ───────────────────────────────────────────────────────────

  private showSelector(hand: HandSide): void {
    if (this.hideTimer) this.hideTimer.enabled = false
    const rec = this.gestureRecognizer
    const pose = hand === "left" ? rec.left : rec.right
    this.selectorHand = hand
    this.spells.setSuppressedHand(hand)
    this.selectorTarget = pose.palmCenter.add(vec3.up().uniformScale(this.selectorHeightCm))
    if (!this.spellSelector.isVisible) {
      this.selectorPos = this.selectorTarget
      this.spellSelector.show(this.selectorPos)
      if (this.ctx) playOneShotAt(this.ctx.effectsRoot, MagicSfx.selectorOpen, this.selectorPos, 0.6)
      if (this.debugLogging) console.log(`[MagicPowersMain] Selector shown above ${hand} palm`)
    }
  }

  private scheduleHide(): void {
    if (!this.hideTimer) return
    this.hideTimer.enabled = true // a disabled DelayedCallbackEvent never fires, even after reset()
    this.hideTimer.reset(this.selectorHideDelaySec)
  }

  private hideSelector(): void {
    this.spellSelector.hide()
    this.spells.setSuppressedHand(null)
    this.selectorHand = null
    if (this.debugLogging) console.log("[MagicPowersMain] Selector hidden")
  }

  // ── Editor shortcuts ────────────────────────────────────────────────────────

  private onKey(e: KeyPressEvent): void {
    if (!this.started) return
    const map: Array<[Keys, PowerId]> = [
      [Keys.One, PowerId.Fireball],
      [Keys.Two, PowerId.Lightning],
      [Keys.Three, PowerId.EnergySphere],
      [Keys.Four, PowerId.Ice],
      [Keys.Five, PowerId.Telekinesis],
      [Keys.Six, PowerId.Portal],
    ]
    for (const [key, id] of map) {
      if (e.key === key) {
        this.onPowerSelected(id)
        return
      }
    }
    if (e.key === Keys.U) {
      this.mockPalmUp = !this.mockPalmUp
      this.gestureRecognizer.setMockPalmUp(this.mockPalmUp)
    }
  }
}
