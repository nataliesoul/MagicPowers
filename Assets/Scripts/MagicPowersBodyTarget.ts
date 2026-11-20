/**
 * MagicPowersBodyTarget — lets magic be cast on people.
 *
 * Owns: the tracked body of a person in view — the joints (and points along the limbs between them)
 *       used to aim at the person and to hang effects on them, the additive "aura" material that
 *       tints the Body Mesh with the element they have been hit with, and an editor stand-in person
 *       so casting on people can be previewed without a headset.
 * Expects: to sit on the Body Mesh object (a RenderMeshVisual using the Full Body Mesh) under the
 *       ObjectTracking3D that drives the mesh, with a second ObjectTracking3D in ATTACHMENT mode
 *       beside it ("Body Joints") — it is found among the mesh tracker's siblings, or built at
 *       runtime if the scene has none.
 * Must not: decide which element a person wears or draw particles — MagicPowersWorldMagic owns that
 *       and talks to this component through the BodyAnchor interface.
 *
 * Why two trackers: the tracker that drives the Body Mesh runs in "Proportions and Pose" mode, which
 * only rotates and scales what is attached to it — attached objects never MOVE to the joints. Joint
 * positions are only delivered in Attachment mode. Reading joints off the mesh tracker returns the
 * camera origin for every joint, the aim ray never meets the person, and casts land on them as if
 * they were a wall.
 */

import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import { BodyAnchor } from "./MagicPowersTypes"

const JOINTS = ["Hips", "Spine", "Spine2", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot"]

/** A point on the body: joint `a`, or a spot along the bone from `a` towards `b` (t may run past 1). */
interface BodyPoint {
  a: string
  b: string
  t: number
  /** Rough radius (cm) of the body here, for aiming. */
  radius: number
}

function limb(side: "Left" | "Right"): BodyPoint[] {
  const j = (name: string) => side + name
  return [
    { a: j("Arm"), b: j("Arm"), t: 0, radius: 10 },
    { a: j("Arm"), b: j("ForeArm"), t: 0.5, radius: 8 },
    { a: j("ForeArm"), b: j("ForeArm"), t: 0, radius: 7 },
    { a: j("ForeArm"), b: j("Hand"), t: 0.5, radius: 6.5 },
    { a: j("Hand"), b: j("Hand"), t: 0, radius: 7 },
    { a: j("UpLeg"), b: j("UpLeg"), t: 0, radius: 12 },
    { a: j("UpLeg"), b: j("Leg"), t: 0.5, radius: 11 },
    { a: j("Leg"), b: j("Leg"), t: 0, radius: 9 },
    { a: j("Leg"), b: j("Foot"), t: 0.5, radius: 8 },
    { a: j("Foot"), b: j("Foot"), t: 0, radius: 8 },
  ]
}

/** 24 points that cover a person: head, three down the torso, five along each limb. */
const BODY_POINTS: BodyPoint[] = [
  { a: "Neck", b: "Head", t: 1.7, radius: 13 }, // the Head joint is the base of the skull; this is its centre
  { a: "Spine2", b: "Spine2", t: 0, radius: 19 },
  { a: "Spine", b: "Spine", t: 0, radius: 18 },
  { a: "Hips", b: "Hips", t: 0, radius: 18 },
  ...limb("Left"),
  ...limb("Right"),
]

/**
 * How the points join up into a body, as index pairs into BODY_POINTS: spine, then shoulder → hand
 * and hip → foot down each side.
 */
const BODY_BONES: number[] = [0, 1, 1, 2, 2, 3]
for (const first of [4, 14]) {
  BODY_BONES.push(1, first) // chest → shoulder
  for (let i = first; i < first + 4; i++) BODY_BONES.push(i, i + 1) // down the arm
  BODY_BONES.push(3, first + 5) // hips → thigh
  for (let i = first + 5; i < first + 9; i++) BODY_BONES.push(i, i + 1) // down the leg
}

/** Editor stand-in: [sideways, height above the floor] in cm for each joint of a standing person. */
const MOCK_POSE: { [joint: string]: [number, number] } = {
  Hips: [0, 95],
  Spine: [0, 110],
  Spine2: [0, 132],
  Neck: [0, 148],
  Head: [0, 155],
  LeftArm: [18, 144],
  LeftForeArm: [23, 116],
  LeftHand: [26, 90],
  RightArm: [-18, 144],
  RightForeArm: [-23, 116],
  RightHand: [-26, 90],
  LeftUpLeg: [9, 92],
  LeftLeg: [10, 50],
  LeftFoot: [10, 8],
  RightUpLeg: [-9, 92],
  RightLeg: [-10, 50],
  RightFoot: [-10, 8],
}

@component
export class MagicPowersBodyTarget extends BaseScriptComponent implements BodyAnchor {
  @ui.label('<span style="color: #60A5FA;">MagicPowersBodyTarget – cast magic on a tracked person</span>')
  @ui.separator
  @input
  @hint("Multiplier on the aiming volume around the body; raise it to make people easier to hit")
  @widget(new SliderWidget(0.5, 2.5, 0.05))
  aimSizeScale: number = 1.35

  @input
  @hint("In Lens Studio (no headset) stand a stand-in person a couple of metres ahead and to the right, so casting on people can be previewed")
  editorMockBody: boolean = true

  @input
  @hint("Debug: keep the body mesh faintly visible whenever a person is tracked")
  alwaysShowBody: boolean = false

  @input
  @hint("Print when a person starts / stops being tracked (shows in the Lens Studio logger from the device too)")
  logTracking: boolean = false

  /** The one body target in the scene (null when the Body Mesh object is missing or disabled). */
  static instance: MagicPowersBodyTarget | null = null

  private jointTracker: ObjectTracking3D | null = null
  private visual: RenderMeshVisual | null = null
  private aura: Material | null = null
  private jointObjs: { [joint: string]: SceneObject } = {}
  private auraOn = false
  private readonly inEditor = global.deviceInfoSystem.isEditor()

  // Refreshed at most once per frame, on demand.
  private frame = -1
  private tracked = false
  private mock = false
  private points: vec3[] = []
  private radii: number[] = []
  private bones: number[] = []
  private mockBase: vec3 | null = null
  private mockRight: vec3 = vec3.right()

  onAwake(): void {
    MagicPowersBodyTarget.instance = this
    this.createEvent("OnDestroyEvent").bind(() => {
      if (MagicPowersBodyTarget.instance === this) MagicPowersBodyTarget.instance = null
    })

    this.visual = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    let meshTracker: ObjectTracking3D | null = null
    let holder: SceneObject | null = this.sceneObject
    while (holder && !meshTracker) {
      meshTracker = holder.getComponent("Component.ObjectTracking3D") as ObjectTracking3D
      if (!meshTracker) holder = holder.getParent()
    }
    if (!this.visual || !meshTracker || !holder) {
      print("[MagicPowersBodyTarget] Needs a RenderMeshVisual here and an ObjectTracking3D on this object or a parent. Casting on real people is off.")
      return
    }
    // Additive glow over the real person: black is invisible on Specs, so only the tint shows.
    if (this.visual.mainMaterial) {
      this.aura = this.visual.mainMaterial.clone()
      const pass = this.aura.mainPass
      pass.blendMode = BlendMode.Add
      pass.depthWrite = false
      pass.baseColor = new vec4(0, 0, 0, 1)
      this.visual.mainMaterial = this.aura
    }
    this.visual.enabled = false

    this.jointTracker = this.findJointTracker(holder, meshTracker)
    let made = 0
    for (const name of JOINTS) {
      try {
        const obj = this.jointTracker.createAttachmentPoint(name)
        if (obj) {
          this.jointObjs[name] = obj
          made++
        }
      } catch (e) {
        // an attachment point this tracking asset does not offer — points that need it are skipped
      }
    }
    if (this.logTracking) {
      print(`[MagicPowersBodyTarget] Ready: ${made}/${JOINTS.length} joints on an Attachment-mode tracker.`)
      this.jointTracker.onTrackingStarted = () => print("[MagicPowersBodyTarget] Person tracked.")
      this.jointTracker.onTrackingLost = () => print("[MagicPowersBodyTarget] Person lost.")
    }
  }

  /**
   * The tracker that delivers joint POSITIONS: an ObjectTracking3D beside the mesh tracker that uses
   * the same tracking asset. If the scene has none, one is built here.
   */
  private findJointTracker(meshTrackerObj: SceneObject, meshTracker: ObjectTracking3D): ObjectTracking3D {
    const parent = meshTrackerObj.getParent()
    if (parent) {
      for (let i = 0; i < parent.getChildrenCount(); i++) {
        const child = parent.getChild(i)
        if (child === meshTrackerObj) continue
        const t = child.getComponent("Component.ObjectTracking3D") as ObjectTracking3D
        if (t) {
          t.trackingMode = ObjectTracking3D.TrackingMode.Attachment
          return t
        }
      }
    }
    const obj = global.scene.createSceneObject("Body Joints")
    if (parent) obj.setParent(parent)
    const t = obj.createComponent("Component.ObjectTracking3D") as ObjectTracking3D
    t.trackingAsset = meshTracker.trackingAsset
    t.trackingMode = ObjectTracking3D.TrackingMode.Attachment
    return t
  }

  // ── Once-per-frame snapshot of the body ─────────────────────────────────────

  private refresh(): void {
    const frame = getTime() // the frame's start time: constant within a frame
    if (frame === this.frame) return
    this.frame = frame
    const real = this.jointTracker !== null && this.jointTracker.isTracking()
    this.mock = !real && this.inEditor && this.editorMockBody
    this.tracked = real || this.mock
    this.points.length = 0
    this.radii.length = 0
    this.bones.length = 0
    if (!this.tracked) return
    const at: { [joint: string]: vec3 } = {}
    for (const name of JOINTS) {
      if (real) {
        const obj = this.jointObjs[name]
        if (obj) at[name] = obj.getTransform().getWorldPosition()
      } else at[name] = this.mockJoint(name)
    }
    // A joint the tracker did not supply drops its points; `slot` maps each defined point to where it landed.
    const slot: number[] = []
    for (const p of BODY_POINTS) {
      const a = at[p.a]
      const b = at[p.b]
      if (!a || !b) {
        slot.push(-1)
        continue
      }
      slot.push(this.points.length)
      this.points.push(p.t === 0 ? a : a.add(b.sub(a).uniformScale(p.t)))
      this.radii.push(p.radius)
    }
    for (let i = 0; i + 1 < BODY_BONES.length; i += 2) {
      const a = slot[BODY_BONES[i]]
      const b = slot[BODY_BONES[i + 1]]
      if (a >= 0 && b >= 0) this.bones.push(a, b)
    }
  }

  private mockJoint(name: string): vec3 {
    if (!this.mockBase) {
      // Stand the stand-in where the wearer was first looking: 2.3 m ahead and a little to the right.
      const cam = WorldCameraFinderProvider.getInstance().getTransform()
      const pos = cam.getWorldPosition()
      const look = cam.back
      let fwd = new vec3(look.x, 0, look.z)
      fwd = fwd.length > 1e-3 ? fwd.normalize() : new vec3(0, 0, -1)
      this.mockRight = fwd.cross(vec3.up()).normalize()
      const spot = pos.add(fwd.uniformScale(230)).add(this.mockRight.uniformScale(80))
      this.mockBase = new vec3(spot.x, pos.y - 150, spot.z)
    }
    const pose = MOCK_POSE[name]
    const sway = Math.sin(getTime() * 0.9) * 2 * (pose[1] / 160)
    return this.mockBase.add(this.mockRight.uniformScale(pose[0] + sway)).add(vec3.up().uniformScale(pose[1]))
  }

  // ── BodyAnchor ──────────────────────────────────────────────────────────────

  get isMock(): boolean {
    this.refresh()
    return this.mock
  }

  isTracking(): boolean {
    this.refresh()
    return this.tracked
  }

  bodyPoints(): vec3[] {
    this.refresh()
    return this.points
  }

  bodyBones(): number[] {
    this.refresh()
    return this.bones
  }

  setAura(r: number, g: number, b: number): void {
    if (!this.visual || !this.aura) return
    let on = r + g + b > 0.004
    if (!on && this.alwaysShowBody && this.jointTracker !== null && this.jointTracker.isTracking()) {
      r = 0.05
      g = 0.12
      b = 0.16
      on = true
    }
    if (on !== this.auraOn) {
      this.auraOn = on
      this.visual.enabled = on
    }
    if (on) this.aura.mainPass.baseColor = new vec4(r, g, b, 1)
  }

  raycast(origin: vec3, dir: vec3, maxDist: number): { position: vec3; normal: vec3; distance: number } | null {
    this.refresh()
    if (!this.tracked) return null
    let best = -1
    for (let i = 0; i < this.points.length; i++) {
      const v = this.points[i].sub(origin)
      const along = v.dot(dir)
      if (along < 25 || along > maxDist) continue
      const r = this.radii[i] * this.aimSizeScale
      const off2 = v.dot(v) - along * along
      if (off2 > r * r) continue
      const d = along - Math.sqrt(r * r - off2)
      if (best < 0 || d < best) best = d
    }
    if (best < 0) return null
    return { position: origin.add(dir.uniformScale(best)), normal: dir.uniformScale(-1), distance: best }
  }
}
