/**
 * MagicPowersMain — orchestrator for the Magic Powers experience.
 *
 * Owns: lifecycle + reference validation, the EffectsContext handed to every power, the SpellManager
 *       (active power, routing), and the systems every element shares: the two-hand orb and its
 *       casting (MagicPowersCaster), the magic left in the room (MagicPowersWorldMagic), the
 *       palm-up element wheel (MagicPowersElementWheel), the onboarding + spellbook journey
 *       (MagicPowersGuide) and casting on people (MagicPowersBodyTarget).
 * Expects (wired in the scene): the gesture recognizer, one component per power, the two glow
 *       materials, the sphere mesh and the effects root.
 * Must not: implement spell mechanics or draw effects — the modules above own those.
 *
 * Everything is driven by hand gestures; there are no buttons:
 *   palms facing each other → summon and charge an orb       push both hands → cast it where you look
 *   one palm up → element wheel       pinch (wheel open) → next element
 *   both palms up, held (after mastery) → begin a new journey
 */

import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import { MagicPowersGestureRecognizer } from "./MagicPowersGestureRecognizer"
import { MagicPowersFireballPower } from "./MagicPowersFireballPower"
import { MagicPowersLightningPower } from "./MagicPowersLightningPower"
import { MagicPowersEnergyPower } from "./MagicPowersEnergyPower"
import { MagicPowersIcePower } from "./MagicPowersIcePower"
import { MagicPowersTelekinesisPower } from "./MagicPowersTelekinesisPower"
import { MagicPowersPortalPower } from "./MagicPowersPortalPower"
import { MagicPowersBodyTarget } from "./MagicPowersBodyTarget"
import { SpellManager } from "./MagicPowersSpellManager"
import { CastImpact, ELEMENT_PALETTES, EffectsContext, GestureEvent, GestureType, HandSide, MagicPower, POWER_COUNT, POWER_NAMES, PowerId } from "./MagicPowersTypes"
import { MagicSfx, MagicTextures } from "./MagicPowersAssetManifest"
import { playOneShotAt, prewarmSfx, tickAudio } from "./MagicPowersAudioLib"
import { FxCanvas, cameraBasis } from "./MagicPowersEffectsLib"
import { WorldMagic } from "./MagicPowersWorldMagic"
import { TwoHandCaster } from "./MagicPowersCaster"
import { ElementWheel } from "./MagicPowersElementWheel"
import { MagicGuide } from "./MagicPowersGuide"

@component
export class MagicPowersMain extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">MagicPowersMain – orchestrates gestures, casting, world magic and the journey</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">References</span>')
  @ui.group_start("References")
  @input
  @hint("Hand-tracking → gesture recognizer component")
  gestureRecognizer!: MagicPowersGestureRecognizer

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
  @ui.label('<span style="color: #60A5FA;">Casting</span>')
  @ui.group_start("Casting")
  @input
  @hint("Power that is active when the Lens starts")
  @widget(new ComboBoxWidget([new ComboBoxItem("Fireball", 0), new ComboBoxItem("Lightning", 1), new ComboBoxItem("Energy Sphere", 2), new ComboBoxItem("Ice", 3), new ComboBoxItem("Telekinesis", 4), new ComboBoxItem("Portal", 5)]))
  defaultPower: number = 0

  @input
  @hint("Seconds of holding the orb between the palms for a full charge (bigger, longer-lasting effect)")
  @widget(new SliderWidget(0.4, 4, 0.1))
  orbChargeSec: number = 1.3

  @input
  @hint("How fast (cm/s) both hands must push forward to release the orb; lower = easier to cast, higher = fewer accidental casts")
  @widget(new SliderWidget(40, 200, 5))
  castThrustSpeed: number = 90

  @input
  @hint("How far (cm) the gaze reaches for a surface to cast onto")
  @widget(new SliderWidget(150, 900, 10))
  castRangeCm: number = 600

  @input
  @hint("Let casts land on a tracked person (needs the Body Mesh object with MagicPowersBodyTarget in the scene)")
  castOnPeople: boolean = true
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Element wheel</span>')
  @ui.group_start("Element wheel")
  @input
  @hint("How far (cm) above the upturned palm the element wheel floats")
  @widget(new SliderWidget(6, 30, 0.5))
  selectorHeightCm: number = 13

  @input
  @hint("Seconds the wheel stays after the palm stops facing up")
  @widget(new SliderWidget(0, 3, 0.1))
  selectorHideDelaySec: number = 0.7
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Journey</span>')
  @ui.group_start("Journey")
  @input
  @hint("Remember the wearer's spellbook and that they finished the onboarding between sessions (on device)")
  rememberProgress: boolean = true
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Editor</span>')
  @ui.group_start("Editor")
  @input
  @hint("In Lens Studio: keys 1-6 select a power, N = next element, U toggles the mock palm-up gesture, B casts the current element at a tracked person")
  editorKeyboardShortcuts: boolean = true

  @input
  @hint("While the editor mock hands are active, the mock palm-up also 'pinches' so every element is previewed in turn")
  mockCyclePowers: boolean = true

  @input
  @hint("Log power switches, casts and discoveries")
  debugLogging: boolean = false
  @ui.group_end

  private spells = new SpellManager()
  private ctx: EffectsContext | null = null
  private canvas: FxCanvas | null = null
  private world: WorldMagic | null = null
  private caster: TwoHandCaster | null = null
  private wheel: ElementWheel | null = null
  private guide: MagicGuide | null = null
  private wheelHand: HandSide | null = null
  private hideTimer: DelayedCallbackEvent | null = null
  private mockPalmUp = false
  private mockPinchClock = 0
  private mockPinched = false
  private resetHold = 0
  private clock = 0
  private started = false

  onAwake(): void {
    if (!this.validateRefs()) return
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("OnDestroyEvent").bind(() => {
      this.started = false
      if (this.caster) this.caster.destroy()
    })
    if (this.editorKeyboardShortcuts) this.createEvent("KeyPressEvent").bind((e) => this.onKey(e))
    this.hideTimer = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.hideTimer.bind(() => this.hideWheel())
    this.hideTimer.enabled = false
  }

  private validateRefs(): boolean {
    const missing: string[] = []
    if (!this.gestureRecognizer) missing.push("gestureRecognizer")
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
      console.error(`[MagicPowersMain] Required @input(s) not wired: ${missing.join(", ")}.`)
      return false
    }
    return true
  }

  private onStart(): void {
    const cameraTransform = WorldCameraFinderProvider.getInstance().getTransform()
    const isEditor = global.deviceInfoSystem.isEditor()
    this.canvas = new FxCanvas(this.effectsRoot, this.glowMaterial, MagicTextures)
    this.world = new WorldMagic(this.canvas, this.effectsRoot)
    this.ctx = {
      glowMaterial: this.glowMaterial,
      solidMaterial: this.solidMaterial,
      sphereMesh: this.sphereMesh,
      textures: MagicTextures,
      camera: cameraTransform,
      effectsRoot: this.effectsRoot,
      world: this.world,
      orb: { presence: 0, charge: 0, centre: vec3.zero(), radius: 4 },
    }
    this.caster = new TwoHandCaster(this.ctx, this.canvas, {
      chargeSec: this.orbChargeSec,
      thrustSpeed: this.castThrustSpeed,
      minCharge: 0.12,
      flightSpeed: 650,
      aimRangeCm: this.castRangeCm,
      floorDropCm: 150,
    })
    this.caster.onImpact = (hit) => this.onCastImpact(hit)
    this.wheel = new ElementWheel(this.effectsRoot, this.canvas, this.selectorHeightCm)
    // In the editor every run starts as a first run, so the onboarding can always be previewed.
    this.guide = new MagicGuide(this.effectsRoot, this.canvas, this.rememberProgress && !isEditor)
    this.guide.onMastery = () => this.celebrate()
    this.world.onSpell.add((e) => {
      if (this.guide && this.ctx) this.guide.notifySpell(e.spell, e.position, e.surface, cameraBasis(this.ctx.camera))
      if (this.debugLogging) console.log(`[MagicPowersMain] Spell: ${e.spell} on ${e.surface}`)
    })

    const body = this.castOnPeople ? MagicPowersBodyTarget.instance : null
    this.world.setBody(body)
    this.caster.setBody(body)

    // Spatial audio needs a listener on the head; add one at runtime if the camera has none.
    const cameraObject = cameraTransform.getSceneObject()
    if (!cameraObject.getComponent("Component.AudioListenerComponent")) cameraObject.createComponent("Component.AudioListenerComponent")
    // Build the one-shot voices before they are needed, a track per frame (see MagicPowersAudioLib).
    const s = MagicSfx
    prewarmSfx(this.effectsRoot, [s.selectorOpen, s.spellSelect, s.fireLaunch, s.fireImpact, s.fireIgnite, s.energyLaunch, s.energyImpact, s.iceShoot, s.iceImpact, s.iceForm, s.lightningBolt, s.teleThrow, s.teleLand, s.portalOpen, s.portalClose, s.iceShield, s.teleGrab])

    const powers: MagicPower[] = [this.fireballPower, this.lightningPower, this.energyPower, this.icePower, this.telekinesisPower, this.portalPower]
    for (const power of powers) {
      power.setContext(this.ctx)
      this.spells.register(power, true)
    }
    this.spells.onActivePowerChanged.add((id) => {
      if (this.debugLogging) console.log(`[MagicPowersMain] Active power → ${POWER_NAMES[id]}`)
    })
    this.gestureRecognizer.onGesture.add((e) => this.onGesture(e))
    this.gestureRecognizer.onFrame.add((dt) => this.onFrame(dt))

    this.spells.setActive(this.defaultPower as PowerId)
    this.wheel.setActive(this.defaultPower as PowerId, false)
    this.started = true
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

  private onGesture(e: GestureEvent): void {
    if (!this.started || !this.ctx || !this.wheel || !this.caster) return
    if (e.hand !== "both") {
      if (e.type === GestureType.PalmUp) this.showWheel(e.hand)
      else if ((e.type === GestureType.PalmUpEnd || e.type === GestureType.TrackingLost) && e.hand === this.wheelHand) this.scheduleHide()
      else if (e.type === GestureType.Pinch && this.wheel.isVisible) {
        // With the wheel open a pinch is "next element" (the other hand turns it back) — it is not a spell gesture.
        this.stepElement(e.hand === this.wheelHand ? 1 : -1)
        return
      }
    }
    this.caster.onGesture(e, cameraBasis(this.ctx.camera))
    this.spells.handleGesture(e)
  }

  private onFrame(dt: number): void {
    if (!this.started || !this.ctx || !this.canvas || !this.world || !this.caster || !this.wheel || !this.guide) return
    this.clock += dt
    tickAudio()
    const rec = this.gestureRecognizer
    const cam = cameraBasis(this.ctx.camera)

    // Editor preview: the mock palm-up also performs the pinch, so the wheel is seen turning.
    if (this.mockCyclePowers && rec.isMocking && this.wheel.isVisible) {
      this.mockPinchClock += dt
      if (this.mockPinchClock > 0.5 && !this.mockPinched) {
        this.mockPinched = true
        this.stepElement(1)
      }
    } else {
      this.mockPinchClock = 0
      this.mockPinched = false
    }

    const active = this.spells.activePowerId ?? (this.defaultPower as PowerId)
    const power = this.spells.activePower
    this.canvas.begin()

    const wheelPose = this.wheelHand === "right" ? rec.right : rec.left
    this.wheel.update(dt, wheelPose.palmCenter, cam)

    // The orb cannot form while a palm is busy with the wheel or the power itself needs both hands.
    const allowOrb = !this.wheel.isVisible && !(power && power.claimsTwoHands)
    this.caster.update(dt, rec.left, rec.right, rec.two, active, allowOrb, cam)
    // A tracked person glows faintly while an orb is held, and brighter once the reticle is on them.
    this.world.bodyHint = this.ctx.orb.presence > 0.25 ? ELEMENT_PALETTES[active].main : null
    this.world.bodyHintStrong = this.caster.aimingAtPerson
    this.world.update(dt, cam, rec.left, rec.right)

    // After mastery: both palms raised and held begins a new journey.
    const offering = this.guide.isMastered && rec.left.isPalmUp && rec.right.isPalmUp
    this.resetHold = offering ? Math.min(1, this.resetHold + dt / 2.2) : Math.max(0, this.resetHold - dt * 2)
    if (this.resetHold >= 1) {
      this.resetHold = 0
      this.guide.reset()
      this.world.clear()
      playOneShotAt(this.effectsRoot, MagicSfx.portalClose, rec.two.midpoint, 0.9)
    }
    this.guide.update(dt, cam, this.ctx.orb, this.resetHold, rec.two.midpoint.add(vec3.up().uniformScale(14)))

    this.spells.tick(dt, rec.left, rec.right, rec.two)
    this.canvas.end(dt, this.clock, cam)
  }

  /** A released orb reached something: a person wears it, a power answers it, or it marks the surface. */
  private onCastImpact(hit: CastImpact): void {
    if (!this.world || !this.guide) return
    this.guide.notifyImpact()
    if (this.debugLogging) console.log(`[MagicPowersMain] ${POWER_NAMES[hit.element]} landed on ${hit.surface} (power ${hit.power.toFixed(2)})`)
    if (hit.surface === "person") {
      this.world.enchantBody(hit.element, hit.power, hit.position)
      return
    }
    const power = this.spells.get(hit.element)
    if (power && power.onCastImpact(hit)) {
      if (hit.element === PowerId.Portal) this.world.announce("gateway", hit.position, hit.surface)
      return
    }
    this.world.imprint(hit.element, hit.position, hit.normal, hit.power)
  }

  private celebrate(): void {
    if (!this.world || !this.ctx) return
    const cam = cameraBasis(this.ctx.camera)
    this.world.fanfare(cam.pos.add(cam.look.uniformScale(90)), cam)
  }

  // ── Element wheel ───────────────────────────────────────────────────────────

  private stepElement(dir: number): void {
    const current = this.spells.activePowerId ?? 0
    this.selectElement(((current + dir + POWER_COUNT) % POWER_COUNT) as PowerId, true)
  }

  private selectElement(id: PowerId, byGesture: boolean): void {
    if (!this.wheel || !this.guide || !this.spells.hasPower(id)) return
    if (!this.spells.setActive(id)) return
    this.wheel.setActive(id, byGesture)
    playOneShotAt(this.effectsRoot, MagicSfx.spellSelect, this.wheel.position, 0.8)
    if (byGesture) this.guide.notifyElementChanged()
  }

  private showWheel(hand: HandSide): void {
    if (!this.wheel) return
    if (this.hideTimer) this.hideTimer.enabled = false
    if (this.wheel.isVisible && this.wheelHand !== hand) return // the wheel stays with the palm that opened it
    this.wheelHand = hand
    this.spells.setSuppressedHand(hand)
    if (!this.wheel.isVisible) {
      this.wheel.show()
      const pose = hand === "left" ? this.gestureRecognizer.left : this.gestureRecognizer.right
      playOneShotAt(this.effectsRoot, MagicSfx.selectorOpen, pose.palmCenter, 0.6)
    }
  }

  private scheduleHide(): void {
    if (!this.hideTimer) return
    this.hideTimer.enabled = true // a disabled DelayedCallbackEvent never fires, even after reset()
    this.hideTimer.reset(this.selectorHideDelaySec)
  }

  private hideWheel(): void {
    if (this.wheel) this.wheel.hide()
    this.spells.setSuppressedHand(null)
    this.wheelHand = null
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
        this.selectElement(id, false)
        return
      }
    }
    if (e.key === Keys.N) this.stepElement(1)
    else if (e.key === Keys.B) this.castAtPersonForPreview()
    else if (e.key === Keys.U) {
      this.mockPalmUp = !this.mockPalmUp
      this.gestureRecognizer.setMockPalmUp(this.mockPalmUp)
    }
  }

  /**
   * Editor only (key B): land the current element on the person the preview is tracking. With a
   * photo or video of a person as the preview source there are no hands to cast with, so this is
   * the way to see magic on people without a headset.
   */
  private castAtPersonForPreview(): void {
    const body = MagicPowersBodyTarget.instance
    if (!body || !this.ctx) {
      print("[MagicPowersMain] No MagicPowersBodyTarget in the scene — casting on people is unavailable.")
      return
    }
    const cam = cameraBasis(this.ctx.camera)
    const joints = body.bodyPoints()
    const gaze = body.raycast(cam.pos, cam.look, this.castRangeCm)
    print(`[MagicPowersMain] Person: tracking=${body.isTracking()} mock=${body.isMock} points=${joints.length} first=${joints.length > 0 ? joints[0].toString() : "-"} gaze=${gaze ? gaze.distance.toFixed(0) + " cm" : "miss"}`)
    if (joints.length === 0) return
    const element = this.spells.activePowerId ?? (this.defaultPower as PowerId)
    this.onCastImpact({ element, position: gaze ? gaze.position : joints[0], normal: cam.look.uniformScale(-1), power: 0.8, surface: "person" })
  }
}
