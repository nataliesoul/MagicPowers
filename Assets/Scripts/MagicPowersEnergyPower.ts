/**
 * MagicPowersEnergyPower — Energy magic: violet energy in the palms and a shield you can raise.
 *
 * Owns: the palm glow that shows Energy is the live element, and the open-palm energy shield.
 * Expects: setContext() from MagicPowersMain before activate(); gesture events + tick from SpellManager.
 * Must not: read SIK directly or decide which power is active.
 *
 * The energy sphere itself is now the shared two-hand orb (MagicPowersCaster): palms facing summons
 * it, a two-hand push casts it, and where it lands it inscribes an arcane sigil
 * (MagicPowersWorldMagic) that amplifies any other spell cast onto it.
 *
 * Gesture map:  both palms facing → the shared orb, in Energy's colours
 *               single open palm facing away → energy shield
 */

import { GestureEvent, HandPose, HandSide, MagicPower, PowerId, TwoHandState } from "./MagicPowersTypes"
import { CamBasis, QuadBatch, approach, cameraBasis, cloneGlowMaterial, perpendicularBasis, tint } from "./MagicPowersEffectsLib"

@component
export class MagicPowersEnergyPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersEnergyPower – energy in the palms and a raised shield</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Shield</span>')
  @ui.group_start("Shield")
  @input
  @hint("Show an energy shield in front of a single open palm facing away from you")
  shieldEnabled: boolean = true

  @input
  @hint("Shield radius (cm)")
  @widget(new SliderWidget(5, 40, 0.5))
  shieldRadiusCm: number = 14
  @ui.group_end

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Look</span>')
  @ui.group_start("Look")
  @input("vec4", "{1.0, 0.85, 1.0, 1.0}")
  @hint("Bright core colour")
  @widget(new ColorWidget())
  colorCore: vec4

  @input("vec4", "{0.62, 0.25, 1.0, 1.0}")
  @hint("Shield body colour")
  @widget(new ColorWidget())
  colorBody: vec4

  @input("vec4", "{0.95, 0.45, 1.0, 1.0}")
  @hint("Palm glow / shield rim colour")
  @widget(new ColorWidget())
  colorShell: vec4
  @ui.group_end

  readonly powerId = PowerId.EnergySphere

  private vfxRoot: SceneObject | null = null
  private shell: QuadBatch | null = null
  private glows: QuadBatch | null = null
  private rings: QuadBatch | null = null
  private shieldAmt: Record<HandSide, number> = { left: 0, right: 0 }
  private palmGlow: Record<HandSide, number> = { left: 0, right: 0 }
  private time = 0
  private built = false

  private ensureBuilt(): void {
    if (this.built || !this.ctx) return
    const ctx = this.ctx
    this.vfxRoot = global.scene.createSceneObject("EnergyVFX")
    this.vfxRoot.setParent(ctx.effectsRoot)
    const tex = ctx.textures
    const white = new vec4(1, 1, 1, 1)
    this.shell = new QuadBatch(this.vfxRoot, "Shell", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 24)
    this.glows = new QuadBatch(this.vfxRoot, "Glows", cloneGlowMaterial(ctx.glowMaterial, tex.glow, white), 8)
    this.rings = new QuadBatch(this.vfxRoot, "Rings", cloneGlowMaterial(ctx.glowMaterial, tex.ring, white), 8)
    this.built = true
  }

  protected onActivate(): void {
    this.ensureBuilt()
    if (this.vfxRoot) this.vfxRoot.enabled = true
  }

  protected onDeactivate(): void {
    this.shieldAmt.left = 0
    this.shieldAmt.right = 0
    if (this.vfxRoot) this.vfxRoot.enabled = false
  }

  onGesture(e: GestureEvent): void {
    // Energy has no discrete gestures of its own: summoning and casting belong to the shared orb.
  }

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.built || !this.ctx) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    this.shell!.begin()
    this.glows!.begin()
    this.rings!.begin()
    this.updatePalm(left, cam, dt)
    this.updatePalm(right, cam, dt)
    this.shell!.end()
    this.glows!.end()
    this.rings!.end()
  }

  private updatePalm(pose: HandPose, cam: CamBasis, dt: number): void {
    const side = pose.side
    const orb = this.ctx!.orb.presence
    const live = pose.tracked && pose.confidence > 0
    // Palm glow: immediate feedback that a tracked hand holds energy (the orb brings its own glow).
    this.palmGlow[side] = approach(this.palmGlow[side], live ? pose.confidence : 0, 8, dt)
    const g = this.palmGlow[side] * (1 - orb)
    if (g > 0.02) {
      const p = pose.palmCenter.add(pose.palmNormal.uniformScale(1.5))
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 4 + (side === "left" ? 0 : 1.5))
      this.glows!.quad(p, cam.right, cam.up, 4 * g * pulse, 4 * g * pulse, tint(this.colorShell, 1, 0.45 * g))
    }
    // Shield: an open palm facing away from the wearer, while no orb is being held.
    const facingAway = pose.palmNormal.dot(cam.look) > 0.55
    const wantShield = this.shieldEnabled && live && pose.isOpen && facingAway && orb < 0.3
    this.shieldAmt[side] = approach(this.shieldAmt[side], wantShield ? pose.confidence : 0, wantShield ? 8 : 5, dt)
    const s = this.shieldAmt[side]
    if (s <= 0.02) return
    const centre = pose.palmCenter.add(pose.palmNormal.uniformScale(7))
    const basis = perpendicularBasis(pose.palmNormal)
    const r = this.shieldRadiusCm * (0.5 + 0.5 * s)
    const wobble = 1 + 0.03 * Math.sin(this.time * 7)
    this.rings!.quad(centre, basis.n1, basis.n2, r * wobble, r * wobble, tint(this.colorShell, 1, 0.8 * s))
    this.rings!.quad(centre, basis.n1, basis.n2, r * 0.72, r * 0.72, tint(this.colorBody, 1, 0.5 * s))
    this.glows!.quad(centre, basis.n1, basis.n2, r * 0.9, r * 0.9, tint(this.colorBody, 1, 0.3 * s))
    for (let i = 0; i < 10; i++) {
      const a = this.time * 1.5 + i * 0.628
      const pos = centre.add(basis.n1.uniformScale(Math.cos(a) * r * 0.9)).add(basis.n2.uniformScale(Math.sin(a) * r * 0.9))
      this.shell!.quad(pos, cam.right, cam.up, 0.9 * s, 0.9 * s, tint(this.colorCore, 1, 0.7 * s))
    }
  }
}
