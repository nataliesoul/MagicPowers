/**
 * MagicPowersBodyTarget — lets magic be cast on people.
 *
 * Owns: the tracked Body Mesh of a person in view — the joint attachment points used to aim at them
 *       and to hang effects on them, and the additive "aura" material that tints their whole body
 *       with the element they have been hit with.
 * Expects: to sit on the Body Mesh object (a RenderMeshVisual using the Full Body Mesh) whose parent
 *       carries the ObjectTracking3D component, under the Camera.
 * Must not: decide which element a person wears or draw particles — MagicPowersWorldMagic owns that
 *       and talks to this component through the BodyAnchor interface.
 *
 * The mesh is hidden until it has something to show: a faint tint while the wearer aims at the
 * person, a full glow while they are enchanted.
 */

import { BodyAnchor } from "./MagicPowersTypes"

interface Joint {
  obj: SceneObject
  /** Rough radius (cm) of the body around this joint, for aiming. */
  radius: number
  /** Effects hang off this joint. */
  fx: boolean
}

/** name, radius (cm), carries effects */
const JOINTS: Array<[string, number, boolean]> = [
  ["Head", 13, true],
  ["Neck", 9, false],
  ["Spine2", 19, true],
  ["Spine", 18, false],
  ["Hips", 18, true],
  ["LeftArm", 9, true],
  ["RightArm", 9, true],
  ["LeftForeArm", 7, true],
  ["RightForeArm", 7, true],
  ["LeftUpLeg", 11, false],
  ["RightUpLeg", 11, false],
  ["LeftLeg", 9, true],
  ["RightLeg", 9, true],
]

@component
export class MagicPowersBodyTarget extends BaseScriptComponent implements BodyAnchor {
  @ui.label('<span style="color: #60A5FA;">MagicPowersBodyTarget – cast magic on a tracked person</span>')
  @ui.separator
  @input
  @hint("Multiplier on the aiming volume around each joint; raise it to make people easier to hit")
  @widget(new SliderWidget(0.5, 2, 0.05))
  aimSizeScale: number = 1.15

  @input
  @hint("Debug: keep the body mesh faintly visible whenever a person is tracked")
  alwaysShowBody: boolean = false

  /** The one body target in the scene (null when the Body Mesh object is missing or disabled). */
  static instance: MagicPowersBodyTarget | null = null

  private tracker: ObjectTracking3D | null = null
  private visual: RenderMeshVisual | null = null
  private aura: Material | null = null
  private joints: Joint[] = []
  private auraOn = false

  onAwake(): void {
    MagicPowersBodyTarget.instance = this
    this.createEvent("OnDestroyEvent").bind(() => {
      if (MagicPowersBodyTarget.instance === this) MagicPowersBodyTarget.instance = null
    })

    this.visual = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    let holder: SceneObject | null = this.sceneObject
    while (holder && !this.tracker) {
      this.tracker = holder.getComponent("Component.ObjectTracking3D") as ObjectTracking3D
      holder = holder.getParent()
    }
    if (!this.visual || !this.tracker) {
      print("[MagicPowersBodyTarget] Needs a RenderMeshVisual here and an ObjectTracking3D on this object or a parent. Casting on people is off.")
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

    for (const [name, radius, fx] of JOINTS) {
      try {
        const obj = this.tracker.createAttachmentPoint(name)
        if (obj) this.joints.push({ obj, radius, fx })
      } catch (e) {
        // an attachment point this tracking asset does not offer — skip it
      }
    }
  }

  isTracking(): boolean {
    return this.tracker !== null && this.joints.length > 0 && this.tracker.isTracking()
  }

  jointPositions(): vec3[] {
    const out: vec3[] = []
    if (!this.isTracking()) return out
    for (const j of this.joints) if (j.fx) out.push(j.obj.getTransform().getWorldPosition())
    return out
  }

  setAura(r: number, g: number, b: number): void {
    if (!this.visual || !this.aura) return
    let on = r + g + b > 0.004
    if (!on && this.alwaysShowBody && this.isTracking()) {
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
    if (!this.isTracking()) return null
    let best = -1
    for (const j of this.joints) {
      const v = j.obj.getTransform().getWorldPosition().sub(origin)
      const along = v.dot(dir)
      if (along < 25 || along > maxDist) continue
      const r = j.radius * this.aimSizeScale
      const off2 = v.dot(v) - along * along
      if (off2 > r * r) continue
      const d = along - Math.sqrt(r * r - off2)
      if (best < 0 || d < best) best = d
    }
    if (best < 0) return null
    return { position: origin.add(dir.uniformScale(best)), normal: dir.uniformScale(-1), distance: best }
  }
}
