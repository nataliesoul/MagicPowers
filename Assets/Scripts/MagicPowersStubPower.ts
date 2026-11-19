/**
 * MagicPowersStubPower — placeholder for the powers not yet implemented (Ice, Telekinesis, Portal).
 *
 * Owns: a tinted glow on each open palm so selecting the power still gives feedback, and a
 *       console note pointing at the extension point.
 * Expects: `powerIndex` set in the Inspector (one authored instance per stub power), setContext()
 *          from MagicPowersMain, tick from SpellManager.
 * Must not: implement real mechanics — replace this component with a full MagicPower subclass.
 */

import { GestureEvent, HandPose, HandSide, MagicPower, POWER_NAMES, PowerId, TwoHandState } from "./MagicPowersTypes"
import { QuadBatch, approach, cameraBasis, cloneGlowMaterial, tint } from "./MagicPowersEffectsLib"

@component
export class MagicPowersStubPower extends MagicPower {
  @ui.label('<span style="color: #60A5FA;">MagicPowersStubPower – placeholder power (extension point)</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Which power slot this placeholder represents")
  @widget(new ComboBoxWidget([new ComboBoxItem("Ice", 3), new ComboBoxItem("Telekinesis", 4), new ComboBoxItem("Portal", 5)]))
  powerIndex: number = 3

  @input("vec4", "{0.6, 0.85, 1.0, 1.0}")
  @hint("Placeholder glow colour shown on an open palm")
  @widget(new ColorWidget())
  color: vec4

  @input
  @hint("Glow radius (cm)")
  @widget(new SliderWidget(1, 12, 0.5))
  glowSizeCm: number = 4
  @ui.group_end
  private glows: QuadBatch | null = null
  private amount: Record<HandSide, number> = { left: 0, right: 0 }
  private time = 0

  get powerId(): PowerId {
    return this.powerIndex as PowerId
  }

  protected onActivate(): void {
    if (!this.ctx) return
    if (!this.glows) this.glows = new QuadBatch(this.ctx.effectsRoot, `StubGlow_${POWER_NAMES[this.powerId]}`, cloneGlowMaterial(this.ctx.glowMaterial, this.ctx.textures.glow, new vec4(1, 1, 1, 1)), 4)
    this.glows.setEnabled(true)
    console.log(`[MagicPowers] ${POWER_NAMES[this.powerId]} is a placeholder — implement a MagicPower subclass to add real mechanics.`)
  }

  protected onDeactivate(): void {
    if (this.glows) {
      this.glows.begin()
      this.glows.end()
    }
  }

  onGesture(e: GestureEvent): void {
    // Placeholder: no discrete reactions yet.
  }

  tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void {
    if (!this.glows || !this.ctx) return
    this.time += dt
    const cam = cameraBasis(this.ctx.camera)
    this.glows.begin()
    for (const pose of [left, right]) {
      const want = pose.tracked && pose.isOpen ? pose.confidence : 0
      this.amount[pose.side] = approach(this.amount[pose.side], want, 8, dt)
      const a = this.amount[pose.side]
      if (a > 0.02) {
        const pulse = 0.85 + 0.15 * Math.sin(this.time * 3)
        const p = pose.palmCenter.add(pose.palmNormal.uniformScale(1.5))
        this.glows.quad(p, cam.right, cam.up, this.glowSizeCm * a * pulse, this.glowSizeCm * a * pulse, tint(this.color, 1, 0.6 * a))
      }
    }
    this.glows.end()
  }
}
