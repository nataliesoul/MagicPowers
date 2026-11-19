/**
 * MagicPowersSpellSelectorUI — the minimal floating spell selector (SpectaclesUIKit).
 *
 * Owns: a dark BackPlate with a caption (active power name) above a row of six icon buttons —
 *       Fire, Lightning, Energy, Ice, Telekinesis, Portal — that billboards towards the user. All six
 *       are live powers; setPowerAvailable() only dims a symbol if a power is unwired.
 *       Passive view: it renders what it is told (setActivePower / setPowerAvailable) and reports
 *       intent through onPowerSelected. Visibility is driven by show()/hide() from MagicPowersMain
 *       (which positions it above the upturned palm).
 * Expects: icon PNGs in Assets/Icons (imported via IconSelector).
 * Must not: hold spell state or decide which power is active.
 */

import { FlexLayout } from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout"
import { FlexItem } from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem"
import { FlexAlign, FlexAlignSelf, FlexDirection, FlexJustify } from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import { BackPlate } from "SpectaclesUIKit.lspkg/Scripts/BackPlate"
import { Button } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button"
import { ElementContent } from "SpectaclesUIKit.lspkg/Scripts/Components/Content/ElementContent"
import { Billboard } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Billboard/Billboard"
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { POWER_COUNT, POWER_NAMES, PowerId } from "./MagicPowersTypes"

// Icons — index matches PowerId (Fireball, Lightning, Energy Sphere, Ice, Telekinesis, Portal)
const ICON_FIRE = requireAsset("../Icons/local_fire_department.png") as Texture
const ICON_LIGHTNING = requireAsset("../Icons/bolt.png") as Texture
const ICON_ENERGY = requireAsset("../Icons/stars.png") as Texture
const ICON_ICE = requireAsset("../Icons/ac_unit.png") as Texture
const ICON_TELEKINESIS = requireAsset("../Icons/back_hand.png") as Texture
const ICON_PORTAL = requireAsset("../Icons/all_out.png") as Texture
const ICONS: Texture[] = [ICON_FIRE, ICON_LIGHTNING, ICON_ENERGY, ICON_ICE, ICON_TELEKINESIS, ICON_PORTAL]

// ── Typography: the single source of truth for text size + weight (Snap Specs type scale @110cm)
const FONT_SIZE_SCALE = 1.0
type TextRole = "Title1" | "Title2" | "HeadlineXL" | "Headline1" | "Headline2" | "Subheadline" | "Button" | "Callout" | "Body" | "Caption"
const TYPE_SCALE: Record<TextRole, { size: number; weight: number }> = {
  Title1: { size: 105, weight: 700 },
  Title2: { size: 93, weight: 700 },
  HeadlineXL: { size: 62, weight: 700 },
  Headline1: { size: 54, weight: 700 },
  Headline2: { size: 48, weight: 700 },
  Subheadline: { size: 41, weight: 700 },
  Button: { size: 39, weight: 500 },
  Callout: { size: 39, weight: 700 },
  Body: { size: 39, weight: 500 },
  Caption: { size: 38, weight: 500 },
}
function roleSize(role: TextRole, distanceCm: number = 110): number {
  return TYPE_SCALE[role].size * FONT_SIZE_SCALE * (distanceCm / 110)
}
function applyTextRole(t: Text, role: TextRole, distanceCm: number = 110): void {
  t.size = roleSize(role, distanceCm)
  ;(t as Text & { weight?: number }).weight = TYPE_SCALE[role].weight
}

const LAYOUT_Z_LIFT = 0.02
const CONTENT_Z = 0.6
/** The selector floats ~55 cm from the eyes (above a hand), so text is scaled for that distance. */
const SELECTOR_DISTANCE_CM = 55

@component
export class MagicPowersSpellSelectorUI extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">MagicPowersSpellSelectorUI – palm-up spell selector</span>')
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Settings</span>')
  @ui.group_start("Settings")
  @input
  @hint("Size (cm) of each elemental symbol button")
  @widget(new SliderWidget(2.5, 8, 0.1))
  buttonSizeCm: number = 3.0

  @input
  @hint("Gap (cm) between the symbol buttons")
  @widget(new SliderWidget(0, 3, 0.1))
  gapCm: number = 0.5

  @input
  @hint("Panel padding (cm) around the content")
  @widget(new SliderWidget(0, 3, 0.1))
  paddingCm: number = 0.7

  @input("vec4", "{1.0, 0.9, 0.6, 1.0}")
  @hint("Caption colour for the active power name")
  @widget(new ColorWidget())
  captionColor: vec4

  @input
  @hint("Opacity of symbols whose power is not available yet (greyed out)")
  @widget(new SliderWidget(0.1, 1, 0.05))
  dimmedOpacity: number = 0.35

  @input
  @hint("Show the active power name above the symbols")
  showCaption: boolean = true
  @ui.group_end

  private buttons: Button[] = []
  private contents: ElementContent[] = []
  /** All six powers ship enabled (Ice, Telekinesis and Portal are no longer placeholders). */
  private available: boolean[] = [true, true, true, true, true, true]
  private caption: Text | null = null
  private wantVisible = false
  private firstLayoutDone = false
  private activeId: PowerId = PowerId.Fireball
  private powerSelectedEvent = new Event<PowerId>()

  /** Fires with the PowerId the user pinched. */
  get onPowerSelected(): PublicApi<PowerId> {
    return this.powerSelectedEvent.publicApi()
  }

  get isVisible(): boolean {
    return this.wantVisible
  }

  onAwake(): void {
    this.sceneObject.createComponent("Component.Canvas")
    // BackPlate FIRST so the Canvas hierarchy sort paints it behind the content.
    const backPlate = this.sceneObject.createComponent(BackPlate.getTypeName()) as BackPlate
    backPlate.style = "dark"
    this.sceneObject.createComponent(Billboard.getTypeName())

    const content = this.obj(this.sceneObject, "Content", new vec3(0, 0, CONTENT_Z))
    const column = content.createComponent(FlexLayout.getTypeName()) as FlexLayout
    // Items are registered explicitly via addItems() before init, so auto-discovery must be off.
    column.autoDiscoverItemsOnStart = false
    column.width = -1
    column.height = -1
    column.direction = FlexDirection.Column
    column.justifyContent = FlexJustify.Center
    column.alignItems = FlexAlign.Center
    column.rowGap = 0.5
    column.paddingTop = this.paddingCm
    column.paddingBottom = this.paddingCm
    column.paddingLeft = this.paddingCm
    column.paddingRight = this.paddingCm

    column.onLayoutComplete.add((r) => {
      backPlate.size = new vec2(r.containerWidth, r.containerHeight)
      if (!this.firstLayoutDone) {
        this.firstLayoutDone = true
        // Start hidden only AFTER the buttons initialised and the first layout ran (UIKit init-order rule).
        this.sceneObject.enabled = this.wantVisible
      }
    })

    if (this.showCaption) this.caption = this.addCaption(content, column)
    this.addSymbolRow(content, column)
  }

  // ── Public API (called by MagicPowersMain) ──────────────────────────────────

  show(worldPosition: vec3): void {
    this.wantVisible = true
    this.sceneObject.getTransform().setWorldPosition(worldPosition)
    this.sceneObject.enabled = true
  }

  hide(): void {
    this.wantVisible = false
    if (this.firstLayoutDone) this.sceneObject.enabled = false
  }

  setWorldPosition(worldPosition: vec3): void {
    this.sceneObject.getTransform().setWorldPosition(worldPosition)
  }

  setActivePower(id: PowerId): void {
    this.activeId = id
    if (this.caption) this.caption.text = POWER_NAMES[id]
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i]
      if (b.isOn !== (i === id)) b.isOn = i === id
    }
  }

  setPowerAvailable(id: PowerId, isAvailable: boolean): void {
    this.available[id] = isAvailable
    const b = this.buttons[id]
    if (b) b.opacity = isAvailable ? 1 : this.dimmedOpacity
    const ec = this.contents[id]
    if (ec) ec.opacity = isAvailable ? 1 : this.dimmedOpacity
  }

  // ── Composition ─────────────────────────────────────────────────────────────

  private obj(parent: SceneObject, name: string, position?: vec3): SceneObject {
    const so = global.scene.createSceneObject(name)
    so.setParent(parent)
    if (position) so.getTransform().setLocalPosition(position)
    return so
  }

  private addCaption(parent: SceneObject, column: FlexLayout): Text {
    const so = this.obj(parent, "Caption", new vec3(0, 0, LAYOUT_Z_LIFT))
    const t = so.createComponent("Component.Text") as Text
    t.text = POWER_NAMES[this.activeId]
    t.depthTest = true
    applyTextRole(t, "Body", SELECTOR_DISTANCE_CM)
    t.textFill.color = this.captionColor
    t.horizontalAlignment = HorizontalAlignment.Center
    t.verticalAlignment = VerticalAlignment.Center
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    // Column parent: 1x1 placeholder rect + Stretch so the text cell spans the row and centres properly.
    t.layoutRect = Rect.create(-0.5, 0.5, -0.5, 0.5)
    const item = so.createComponent(FlexItem.getTypeName()) as FlexItem
    item.alignSelf = FlexAlignSelf.Stretch
    item.overrideHeight = 1.6
    column.addItems([item])
    return t
  }

  private addSymbolRow(parent: SceneObject, column: FlexLayout): void {
    const rowObj = this.obj(parent, "Symbols", new vec3(0, 0, LAYOUT_Z_LIFT))
    const row = rowObj.createComponent(FlexLayout.getTypeName()) as FlexLayout
    row.autoDiscoverItemsOnStart = false
    const size = this.buttonSizeCm
    const width = POWER_COUNT * size + (POWER_COUNT - 1) * this.gapCm
    row.width = width
    row.height = size
    row.direction = FlexDirection.Row
    row.justifyContent = FlexJustify.Center
    row.alignItems = FlexAlign.Center
    row.columnGap = this.gapCm
    const rowItem = rowObj.createComponent(FlexItem.getTypeName()) as FlexItem
    rowItem.overrideWidth = width
    rowItem.overrideHeight = size
    column.addItems([rowItem])

    const items: FlexItem[] = []
    for (let i = 0; i < POWER_COUNT; i++) {
      const so = this.obj(rowObj, `Symbol_${POWER_NAMES[i]}`, new vec3(0, 0, LAYOUT_Z_LIFT))
      const btn = so.createComponent(Button.getTypeName()) as Button
      btn.size = new vec3(size, size, 1)
      btn.setIsToggleable(true)
      btn.isOn = i === this.activeId
      const id = i as PowerId
      btn.onInitialized.add(() => {
        btn.opacity = this.available[i] ? 1 : this.dimmedOpacity
        if (this.contents[i]) this.contents[i].opacity = this.available[i] ? 1 : this.dimmedOpacity
      })
      btn.onTriggerUp.add(() => this.select(id))

      // ElementContent companion mode centres the icon on the button face (sole child → no R1 collapse).
      const ec = so.createComponent(ElementContent.getTypeName()) as ElementContent
      ec.leadingIcon = ICONS[i]
      ec.leadingIconSize = size * 0.62
      ec.iconLayout = "left"
      this.contents.push(ec)

      const item = so.createComponent(FlexItem.getTypeName()) as FlexItem
      item.overrideWidth = size
      item.overrideHeight = size
      items.push(item)
      this.buttons.push(btn)
    }
    row.addItems(items)
  }

  private select(id: PowerId): void {
    // Reflect the exclusive selection locally; the owner decides whether the switch is accepted.
    for (let i = 0; i < this.buttons.length; i++) this.buttons[i].isOn = i === id
    this.powerSelectedEvent.invoke(id)
  }
}
