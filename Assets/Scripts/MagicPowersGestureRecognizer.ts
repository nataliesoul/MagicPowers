/**
 * MagicPowersGestureRecognizer — turns SIK hand tracking into HandPose data + discrete gesture events.
 *
 * Owns: per-hand pose extraction (palm center / normal, finger direction, openness, pointing,
 *       velocity), the two-hand relation (palms facing, distance, spread rate), the gesture state
 *       machine with hysteresis + minimum hold times + cooldowns, the index-fingertip circle-trace
 *       detector (Portal), tracking-loss fading, and an editor mock that synthesises hands so the
 *       Lens can be previewed without a headset.
 * Expects: the SpectaclesInteractionKit prefab in the scene (HandInputData singleton).
 * Must not: know which power is active or render anything.
 *
 * Init-order rule: SIK hand events are subscribed inside OnStartEvent, never in onAwake.
 */

import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData"
import TrackedHand from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { GestureEvent, GestureType, HandPose, HandSide, TwoHandState } from "./MagicPowersTypes"
import { approach, approachVec, clamp01 } from "./MagicPowersEffectsLib"

interface HandRuntime {
  pose: HandPose
  tracked: TrackedHand | null
  prevPalm: vec3 | null
  prevOpenness: number
  openSince: number
  fistSince: number
  pointSince: number
  lastPush: number
  lastPoint: number
  lostAt: number
  pinchWas: boolean
  palmUpWas: boolean
  pushFrames: number
  /** Index-fingertip trail (world positions + timestamps) while the hand is pointing. */
  trace: Array<{ p: vec3; t: number }>
  lastCircle: number
  traceIdleSince: number
}

@component
export class MagicPowersGestureRecognizer extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">MagicPowersGestureRecognizer – hand poses → gesture events</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gesture thresholds</span>')
  @ui.group_start("Gesture thresholds")
  @input
  @hint("Openness (0 fist … 1 open) above which a hand counts as an open palm")
  @widget(new SliderWidget(0.4, 0.95, 0.01))
  openThreshold: number = 0.7

  @input
  @hint("Openness below which a hand counts as a fist")
  @widget(new SliderWidget(0.05, 0.6, 0.01))
  fistThreshold: number = 0.3

  @input
  @hint("Hysteresis band added/subtracted before an open/fist state is released")
  @widget(new SliderWidget(0.0, 0.3, 0.01))
  hysteresis: number = 0.12

  @input
  @hint("Seconds a pose must be held before the gesture fires (filters tracking jitter)")
  @widget(new SliderWidget(0.0, 0.4, 0.01))
  minHoldSec: number = 0.08

  @input
  @hint("Palm speed along the palm normal (cm/s) that counts as a push / throw")
  @widget(new SliderWidget(40, 300, 5))
  pushSpeedCmPerSec: number = 110

  @input
  @hint("Seconds between two push gestures from the same hand")
  @widget(new SliderWidget(0.1, 2, 0.05))
  pushCooldownSec: number = 0.45

  @input
  @hint("Seconds between two point (bolt) gestures from the same hand")
  @widget(new SliderWidget(0.1, 2, 0.05))
  pointCooldownSec: number = 0.5

  @input
  @hint("Dot(palm normal, world up) above which the palm counts as facing the sky")
  @widget(new SliderWidget(0.4, 0.95, 0.01))
  palmUpDot: number = 0.72

  @input
  @hint("Dot(left normal, right normal) below which the palms face each other (−1 = perfectly facing)")
  @widget(new SliderWidget(-0.95, 0, 0.01))
  palmsFacingDot: number = -0.55

  @input
  @hint("Maximum palm-to-palm distance (cm) for the palms-facing state")
  @widget(new SliderWidget(15, 80, 1))
  palmsFacingMaxDistCm: number = 45

  @input
  @hint("Inter-palm distance change (cm/s) that fires HandsSpread / HandsTogether")
  @widget(new SliderWidget(20, 200, 5))
  spreadRateCmPerSec: number = 70

  @input
  @hint("Finger tip/wrist ÷ knuckle/wrist ratio at which a finger counts as fully curled")
  @widget(new SliderWidget(0.8, 1.6, 0.01))
  fingerCurlRatio: number = 1.2

  @input
  @hint("Finger tip/wrist ÷ knuckle/wrist ratio at which a finger counts as fully extended")
  @widget(new SliderWidget(1.4, 2.4, 0.01))
  fingerExtendRatio: number = 1.85
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Circle trace (Portal)</span>')
  @ui.group_start("Circle trace")
  @input
  @hint("Smallest circle radius (cm) the pointing index finger can trace to open a portal")
  @widget(new SliderWidget(2, 15, 0.5))
  circleMinRadiusCm: number = 4

  @input
  @hint("Largest circle radius (cm) accepted for a traced circle")
  @widget(new SliderWidget(10, 60, 1))
  circleMaxRadiusCm: number = 32

  @input
  @hint("Seconds of fingertip history examined for a closed circle (slower circles need a longer window)")
  @widget(new SliderWidget(0.8, 4, 0.1))
  circleWindowSec: number = 2.2

  @input
  @hint("Seconds between two circle-trace gestures from the same hand")
  @widget(new SliderWidget(0.2, 3, 0.1))
  circleCooldownSec: number = 1.2
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Tracking</span>')
  @ui.group_start("Tracking")
  @input
  @hint("Seconds effects take to fade out after a hand is lost (state is kept, effects resume on re-acquire)")
  @widget(new SliderWidget(0.05, 1.5, 0.05))
  trackingFadeOutSec: number = 0.3

  @input
  @hint("Seconds effects take to fade back in after a hand is re-acquired")
  @widget(new SliderWidget(0.0, 1.0, 0.05))
  trackingFadeInSec: number = 0.15

  @input
  @hint("Velocity smoothing rate (per second); higher = snappier, lower = steadier")
  @widget(new SliderWidget(2, 40, 1))
  velocitySmoothing: number = 14
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Editor mock</span>')
  @ui.group_start("Editor mock")
  @input
  @hint("In Lens Studio (no headset) synthesise two hands in front of the camera that cycle through the gestures so every power can be previewed")
  editorMockHands: boolean = true

  @input
  @hint("Distance in front of the camera (cm) where the mock hands float")
  @widget(new SliderWidget(30, 90, 1))
  mockDistanceCm: number = 55

  @input
  @hint("Length of one mock gesture cycle in seconds")
  @widget(new SliderWidget(4, 20, 0.5))
  mockCycleSec: number = 9
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @ui.group_start("Debug")
  @input
  @hint("Print every gesture event to the console")
  logGestures: boolean = false
  @ui.group_end

  private hands: Record<HandSide, HandRuntime>
  private twoState = new TwoHandState()
  private prevDistance: number | null = null
  private palmsFacingWas = false
  private lastSpreadEvent = 0
  private cameraTransform: Transform | null = null
  private mocking = false
  private mockPalmUp = false
  private mockTime = 0
  private gestureEvent = new Event<GestureEvent>()
  private frameEvent = new Event<number>()

  /** Fired for every discrete gesture (after the poses for this frame are updated). */
  get onGesture(): PublicApi<GestureEvent> {
    return this.gestureEvent.publicApi()
  }

  /** Fired once per frame after poses + gestures are refreshed; payload = dt. */
  get onFrame(): PublicApi<number> {
    return this.frameEvent.publicApi()
  }

  get left(): HandPose {
    return this.hands.left.pose
  }

  get right(): HandPose {
    return this.hands.right.pose
  }

  get two(): TwoHandState {
    return this.twoState
  }

  /** True while the editor mock is driving the poses (no real hands tracked in the editor). */
  get isMocking(): boolean {
    return this.mocking
  }

  /** Editor helper: toggle the mock left hand into the palm-up pose (opens the spell selector). */
  setMockPalmUp(up: boolean): void {
    this.mockPalmUp = up
  }

  onAwake(): void {
    this.hands = {
      left: this.makeRuntime("left"),
      right: this.makeRuntime("right"),
    }
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())
  }

  private makeRuntime(side: HandSide): HandRuntime {
    return {
      pose: new HandPose(side),
      tracked: null,
      prevPalm: null,
      prevOpenness: 0,
      openSince: -1,
      fistSince: -1,
      pointSince: -1,
      lastPush: -10,
      lastPoint: -10,
      lostAt: -10,
      pinchWas: false,
      palmUpWas: false,
      pushFrames: 0,
      trace: [],
      lastCircle: -10,
      traceIdleSince: -1,
    }
  }

  private onStart(): void {
    const provider = HandInputData.getInstance()
    this.hands.left.tracked = provider.getHand("left")
    this.hands.right.tracked = provider.getHand("right")
    this.cameraTransform = WorldCameraFinderProvider.getInstance().getTransform()
    // SIK hand events bind here (OnStartEvent), per the init-order rule.
    for (const side of ["left", "right"] as HandSide[]) {
      const rt = this.hands[side]
      const hand = rt.tracked
      if (!hand) continue
      hand.onPinchDown.add(() => this.onPinchChanged(side, true))
      hand.onPinchUp.add(() => this.onPinchChanged(side, false))
      hand.onPinchCancel.add(() => this.onPinchChanged(side, false))
    }
  }

  private onPinchChanged(side: HandSide, down: boolean): void {
    const rt = this.hands[side]
    if (rt.pinchWas === down) return
    rt.pinchWas = down
    rt.pose.isPinching = down
    this.emit(down ? GestureType.Pinch : GestureType.PinchEnd, side, rt.pose.palmCenter, rt.pose.palmNormal, 1)
  }

  private onUpdate(): void {
    const dt = Math.min(getDeltaTime(), 0.1)
    const now = getTime()
    const anyReal = this.updateRealHand(this.hands.left, dt, now) || this.updateRealHand(this.hands.right, dt, now)
    const isEditor = global.deviceInfoSystem.isEditor()
    this.mocking = this.editorMockHands && isEditor && !anyReal
    if (this.mocking) {
      this.mockTime += dt
      this.updateMockHand(this.hands.left, dt, now)
      this.updateMockHand(this.hands.right, dt, now)
    }
    this.updateTracking(this.hands.left, dt, now)
    this.updateTracking(this.hands.right, dt, now)
    this.deriveGestures(this.hands.left, dt, now)
    this.deriveGestures(this.hands.right, dt, now)
    this.updateTwoHands(dt, now)
    this.frameEvent.invoke(dt)
  }

  // ── Real hand → raw pose ────────────────────────────────────────────────────

  private updateRealHand(rt: HandRuntime, dt: number, now: number): boolean {
    const hand = rt.tracked
    const pose = rt.pose
    if (!hand || !hand.isTracked()) {
      pose.tracked = false
      return false
    }
    const palm = hand.getPalmCenter()
    if (!palm) {
      pose.tracked = false
      return false
    }
    pose.tracked = true
    const wrist = hand.wrist.position
    const middleKnuckle = hand.middleKnuckle.position
    const indexKnuckle = hand.indexKnuckle.position
    const pinkyKnuckle = hand.pinkyKnuckle.position

    const fingerDir = middleKnuckle.sub(wrist).normalize()
    // Right hand: cross(fingers, pinky→index side) points out of the palm; mirrored for the left hand.
    let normal = fingerDir.cross(pinkyKnuckle.sub(indexKnuckle)).normalize()
    if (pose.side === "left") normal = normal.uniformScale(-1)

    const tips = [hand.thumbTip, hand.indexTip, hand.middleTip, hand.ringTip, hand.pinkyTip]
    const knuckles = [hand.thumbKnuckle, hand.indexKnuckle, hand.middleKnuckle, hand.ringKnuckle, hand.pinkyKnuckle]
    let opennessSum = 0
    const ext: number[] = []
    for (let i = 0; i < 5; i++) {
      const kd = Math.max(1, knuckles[i].position.distance(wrist))
      const td = tips[i].position.distance(wrist)
      const ratio = td / kd
      const e = clamp01((ratio - this.fingerCurlRatio) / (this.fingerExtendRatio - this.fingerCurlRatio))
      ext.push(e)
      pose.fingertips[i] = tips[i].position
      if (i > 0) opennessSum += e // thumb excluded: it barely changes the tip/wrist ratio
    }
    const openness = opennessSum / 4
    pose.openRate = dt > 0 ? (openness - rt.prevOpenness) / dt : 0
    rt.prevOpenness = openness
    pose.openness = openness
    pose.pointing = ext[1] > 0.75 && ext[2] < 0.35 && ext[3] < 0.35 && ext[4] < 0.35
    pose.palmCenter = palm
    pose.palmNormal = normal
    pose.fingerDir = fingerDir
    pose.wrist = wrist
    pose.indexTip = hand.indexTip.position
    pose.thumbTip = hand.thumbTip.position
    this.updateVelocity(rt, dt)
    return true
  }

  private updateVelocity(rt: HandRuntime, dt: number): void {
    const pose = rt.pose
    if (rt.prevPalm && dt > 0) {
      const raw = pose.palmCenter.sub(rt.prevPalm).uniformScale(1 / dt)
      pose.velocity = approachVec(pose.velocity, raw, this.velocitySmoothing, dt)
    }
    rt.prevPalm = pose.palmCenter
    pose.pushSpeed = pose.velocity.dot(pose.palmNormal)
  }

  // ── Editor mock → raw pose ──────────────────────────────────────────────────

  /**
   * Mock timeline (one cycle): both palms facing (0–30 %), right fist charge (30–45 %), fast open +
   * push (45–60 %), right pointing (60–75 %), both open + right push (75–100 %).
   * Left hand palm-up is toggled with setMockPalmUp (keyboard U in MagicPowersMain).
   */
  private updateMockHand(rt: HandRuntime, dt: number, now: number): void {
    const cam = this.cameraTransform
    if (!cam) return
    const pose = rt.pose
    const phase = (this.mockTime % this.mockCycleSec) / this.mockCycleSec
    const camPos = cam.getWorldPosition()
    const right = cam.right
    const up = cam.up
    const look = cam.back
    const sideSign = pose.side === "left" ? -1 : 1
    const breathe = Math.sin(this.mockTime * 1.7)
    // palms facing each other, distance oscillating 15–25 cm (keeps both hands inside the preview frame)
    let separation = 20 + 5 * breathe
    let openness = 1
    let pointing = false
    let normal = right.uniformScale(-sideSign) // facing the other hand
    let fingerDir = up
    let pushVel = vec3.zero()
    const isRight = pose.side === "right"

    if (phase >= 0.3 && phase < 0.45) {
      if (isRight) openness = 0.05 // charging fist
    } else if (phase >= 0.45 && phase < 0.6) {
      if (isRight) {
        openness = 1
        normal = look // palm faces forward for the throw
        const t = (phase - 0.45) / 0.15
        if (t < 0.25) pushVel = look.uniformScale(220)
      }
    } else if (phase >= 0.6 && phase < 0.75) {
      if (isRight) {
        pointing = true
        openness = 0.35
        fingerDir = look
        normal = up.uniformScale(-1)
      }
    } else if (phase >= 0.75) {
      separation = 18
      const t = (phase - 0.75) / 0.25
      if (isRight && t > 0.5 && t < 0.62) pushVel = look.uniformScale(200)
      if (isRight && t > 0.5) normal = look
    }
    // The last 12 % of every cycle turns the left palm up so the spell selector can be previewed.
    if (pose.side === "left" && (this.mockPalmUp || phase >= 0.88)) {
      normal = up
      openness = 1
      fingerDir = look
      separation = 3 // bring the upturned hand to the centre so the selector is framed in the preview
    }

    const base = camPos.add(look.uniformScale(this.mockDistanceCm)).add(up.uniformScale(-8))
    const center = base.add(right.uniformScale(sideSign * separation * 0.5)).add(up.uniformScale(1.5 * Math.sin(this.mockTime * 1.1 + sideSign)))
    pose.tracked = true
    pose.palmCenter = center
    pose.palmNormal = normal
    pose.fingerDir = fingerDir
    pose.wrist = center.sub(fingerDir.uniformScale(7))
    const tipDir = fingerDir
    const spread = right.uniformScale(sideSign)
    for (let i = 0; i < 5; i++) {
      const lateral = (i - 2) * 1.6
      const reach = (i === 0 ? 5 : 8) * (0.4 + 0.6 * openness)
      pose.fingertips[i] = center.add(tipDir.uniformScale(reach)).add(spread.uniformScale(lateral))
    }
    if (pointing) {
      // The mock index finger traces a 7 cm circle in the view plane (~1.6 turns per pointing phase)
      // so the Portal's circle-trace detector can be previewed without a headset.
      const turn = ((phase - 0.6) / 0.15) * Math.PI * 2 * 1.6
      const circle = right.uniformScale(Math.cos(turn) * 7).add(up.uniformScale(Math.sin(turn) * 7))
      pose.fingertips[1] = center.add(fingerDir.uniformScale(9)).add(circle)
    }
    pose.indexTip = pose.fingertips[1]
    pose.thumbTip = pose.fingertips[0]
    pose.openRate = dt > 0 ? (openness - rt.prevOpenness) / dt : 0
    rt.prevOpenness = openness
    pose.openness = openness
    pose.pointing = pointing
    this.updateVelocity(rt, dt)
    if (pushVel.length > 0) {
      pose.velocity = pushVel
      pose.pushSpeed = pushVel.dot(normal)
    }
  }

  // ── Tracking confidence ─────────────────────────────────────────────────────

  private updateTracking(rt: HandRuntime, dt: number, now: number): void {
    const pose = rt.pose
    if (pose.tracked) {
      if (pose.confidence <= 0 && rt.lostAt > 0) {
        this.emit(GestureType.TrackingAcquired, pose.side, pose.palmCenter, pose.palmNormal, 1)
      }
      const rate = this.trackingFadeInSec > 0 ? dt / this.trackingFadeInSec : 1
      pose.confidence = Math.min(1, pose.confidence + rate)
      rt.lostAt = 0
    } else {
      if (pose.confidence > 0 && rt.lostAt === 0) {
        rt.lostAt = now
        this.emit(GestureType.TrackingLost, pose.side, pose.palmCenter, pose.palmNormal, 0)
      }
      const rate = this.trackingFadeOutSec > 0 ? dt / this.trackingFadeOutSec : 1
      pose.confidence = Math.max(0, pose.confidence - rate)
      pose.velocity = approachVec(pose.velocity, vec3.zero(), 10, dt)
      pose.pushSpeed = 0
      rt.prevPalm = null
      if (pose.confidence <= 0) {
        // Drop sticky states so nothing re-fires on re-acquire without a fresh gesture.
        pose.isOpen = false
        pose.isFist = false
        pose.isPalmUp = false
        pose.pointing = false
        rt.openSince = -1
        rt.fistSince = -1
        rt.pointSince = -1
        rt.trace.length = 0
      }
    }
  }

  // ── Gesture state machine ───────────────────────────────────────────────────

  private deriveGestures(rt: HandRuntime, dt: number, now: number): void {
    const pose = rt.pose
    if (!pose.tracked) {
      if (rt.palmUpWas) {
        rt.palmUpWas = false
        this.emit(GestureType.PalmUpEnd, pose.side, pose.palmCenter, pose.palmNormal, 0)
      }
      return
    }
    const o = pose.openness

    // Open palm (with hysteresis + hold time)
    if (!pose.isOpen) {
      if (o >= this.openThreshold) {
        if (rt.openSince < 0) rt.openSince = now
        if (now - rt.openSince >= this.minHoldSec) {
          pose.isOpen = true
          pose.isFist = false
          this.emit(GestureType.OpenPalm, pose.side, pose.palmCenter, pose.palmNormal, Math.max(0, pose.openRate))
        }
      } else rt.openSince = -1
    } else if (o < this.openThreshold - this.hysteresis) {
      pose.isOpen = false
      rt.openSince = -1
    }

    // Fist
    if (!pose.isFist) {
      if (o <= this.fistThreshold) {
        if (rt.fistSince < 0) rt.fistSince = now
        if (now - rt.fistSince >= this.minHoldSec) {
          pose.isFist = true
          pose.isOpen = false
          this.emit(GestureType.Fist, pose.side, pose.palmCenter, pose.palmNormal, 1)
        }
      } else rt.fistSince = -1
    } else if (o > this.fistThreshold + this.hysteresis) {
      pose.isFist = false
      rt.fistSince = -1
    }

    // Push: sustained speed along the normal, cooldown gated
    if (pose.pushSpeed > this.pushSpeedCmPerSec) rt.pushFrames++
    else rt.pushFrames = 0
    if (rt.pushFrames >= 2 && now - rt.lastPush > this.pushCooldownSec) {
      rt.lastPush = now
      rt.pushFrames = 0
      const dir = pose.velocity.normalize()
      this.emit(GestureType.Push, pose.side, pose.palmCenter, dir, pose.pushSpeed)
    }

    // Palm up
    const palmUp = pose.isOpen && pose.palmNormal.dot(vec3.up()) > this.palmUpDot
    pose.isPalmUp = palmUp
    if (palmUp && !rt.palmUpWas) {
      rt.palmUpWas = true
      this.emit(GestureType.PalmUp, pose.side, pose.palmCenter, pose.palmNormal, 1)
    } else if (!palmUp && rt.palmUpWas) {
      rt.palmUpWas = false
      this.emit(GestureType.PalmUpEnd, pose.side, pose.palmCenter, pose.palmNormal, 0)
    }

    // Point (index extended, others curled) with hold + cooldown
    if (pose.pointing) {
      if (rt.pointSince < 0) rt.pointSince = now
      else if (rt.pointSince > 0 && now - rt.pointSince >= this.minHoldSec && now - rt.lastPoint > this.pointCooldownSec) {
        rt.lastPoint = now
        rt.pointSince = 0 // 0 = fired for this hold
        this.emit(GestureType.Point, pose.side, pose.indexTip, pose.fingerDir, 1)
      }
    } else if (rt.pointSince !== -1) {
      if (rt.pointSince === 0) this.emit(GestureType.PointEnd, pose.side, pose.indexTip, pose.fingerDir, 0)
      rt.pointSince = -1
    }

    this.traceCircle(rt, now)
  }

  // ── Circle trace (index fingertip draws a closed loop) ──────────────────────

  /**
   * Keeps a short trail of the index fingertip while the hand is pointing and fires CircleTrace once
   * the trail closes a loop: radius inside [min, max], low radius variance, and ≥ 0.92 turns of
   * consistently-signed sweep around the best-fit axis (sum of consecutive radial cross products).
   */
  private traceCircle(rt: HandRuntime, now: number): void {
    const pose = rt.pose
    if (!pose.pointing || pose.confidence < 0.5) {
      // A short pointing dropout keeps the trail; a longer one discards it.
      if (rt.traceIdleSince < 0) rt.traceIdleSince = now
      else if (now - rt.traceIdleSince > 0.35) rt.trace.length = 0
      return
    }
    rt.traceIdleSince = -1
    const trail = rt.trace
    trail.push({ p: pose.indexTip, t: now })
    while (trail.length > 0 && now - trail[0].t > this.circleWindowSec) trail.shift()
    if (trail.length < 14 || now - rt.lastCircle < this.circleCooldownSec) return
    if (now - trail[0].t < 0.25) return

    let cx = 0
    let cy = 0
    let cz = 0
    for (const s of trail) {
      cx += s.p.x
      cy += s.p.y
      cz += s.p.z
    }
    const n = trail.length
    const centre = new vec3(cx / n, cy / n, cz / n)
    let radiusSum = 0
    const radial: vec3[] = new Array(n)
    for (let i = 0; i < n; i++) {
      radial[i] = trail[i].p.sub(centre)
      radiusSum += radial[i].length
    }
    const radius = radiusSum / n
    if (radius < this.circleMinRadiusCm || radius > this.circleMaxRadiusCm) return
    let dev = 0
    for (let i = 0; i < n; i++) {
      const d = radial[i].length - radius
      dev += d * d
    }
    if (Math.sqrt(dev / n) / radius > 0.32) return

    let axis = vec3.zero()
    for (let i = 0; i + 1 < n; i++) axis = axis.add(radial[i].cross(radial[i + 1]))
    if (axis.length < 1e-3) return
    axis = axis.normalize()
    let total = 0
    let absTotal = 0
    for (let i = 0; i + 1 < n; i++) {
      const a = radial[i]
      const b = radial[i + 1]
      const ang = Math.atan2(a.cross(b).dot(axis), a.dot(b))
      total += ang
      absTotal += Math.abs(ang)
    }
    if (Math.abs(total) < Math.PI * 2 * 0.92 || absTotal > Math.abs(total) * 1.35) return

    // Normal faces the user so a power can orient a portal towards them.
    const cam = this.cameraTransform
    if (cam && axis.dot(cam.getWorldPosition().sub(centre)) < 0) axis = axis.uniformScale(-1)
    rt.lastCircle = now
    trail.length = 0
    this.emit(GestureType.CircleTrace, pose.side, centre, axis, radius)
  }

  private updateTwoHands(dt: number, now: number): void {
    const l = this.hands.left.pose
    const r = this.hands.right.pose
    const two = this.twoState
    two.bothTracked = l.tracked && r.tracked
    if (!two.bothTracked) {
      two.spreadRate = approach(two.spreadRate, 0, 10, dt)
      this.prevDistance = null
      if (this.palmsFacingWas) {
        this.palmsFacingWas = false
        two.palmsFacing = false
        this.emit(GestureType.PalmsFacingEnd, "both", two.midpoint, two.axis, 0)
      }
      return
    }
    const delta = r.palmCenter.sub(l.palmCenter)
    const dist = delta.length
    two.distance = dist
    two.midpoint = l.palmCenter.add(delta.uniformScale(0.5))
    two.axis = dist > 1e-3 ? delta.uniformScale(1 / dist) : vec3.right()
    if (this.prevDistance !== null && dt > 0) {
      two.spreadRate = approach(two.spreadRate, (dist - this.prevDistance) / dt, this.velocitySmoothing, dt)
    }
    this.prevDistance = dist

    const facingDot = l.palmNormal.dot(r.palmNormal)
    const lToward = l.palmNormal.dot(two.axis) // left normal should point towards the right hand
    const rToward = r.palmNormal.dot(two.axis.uniformScale(-1))
    const facing = facingDot < this.palmsFacingDot && lToward > 0.3 && rToward > 0.3 && dist < this.palmsFacingMaxDistCm
    two.palmsFacing = facing
    if (facing && !this.palmsFacingWas) {
      this.palmsFacingWas = true
      this.emit(GestureType.PalmsFacingStart, "both", two.midpoint, two.axis, dist)
    } else if (!facing && this.palmsFacingWas) {
      this.palmsFacingWas = false
      this.emit(GestureType.PalmsFacingEnd, "both", two.midpoint, two.axis, dist)
    }

    if (now - this.lastSpreadEvent > 0.35) {
      if (two.spreadRate > this.spreadRateCmPerSec) {
        this.lastSpreadEvent = now
        this.emit(GestureType.HandsSpread, "both", two.midpoint, two.axis, two.spreadRate)
      } else if (two.spreadRate < -this.spreadRateCmPerSec) {
        this.lastSpreadEvent = now
        this.emit(GestureType.HandsTogether, "both", two.midpoint, two.axis, -two.spreadRate)
      }
    }
  }

  private emit(type: GestureType, hand: HandSide | "both", position: vec3, direction: vec3, strength: number): void {
    const e: GestureEvent = { type, hand, position, direction, strength }
    if (this.logGestures) console.log(`[Gesture] ${GestureType[type]} ${hand} strength=${strength.toFixed(2)}`)
    this.gestureEvent.invoke(e)
  }
}
