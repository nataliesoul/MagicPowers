/**
 * MagicPowersTypes — shared contracts for the Magic Powers experience.
 *
 * Owns: PowerId + display names, HandPose / TwoHandState data shapes, GestureEvent,
 *       the EffectsContext handed to every power, and the MagicPower base class that
 *       every elemental power implements (the extension point for Ice / Telekinesis / Portal).
 * Expects: nothing — pure types and a base class.
 * Must not: touch the scene graph, create objects, or hold global runtime state.
 */

export enum PowerId {
  Fireball = 0,
  Lightning = 1,
  EnergySphere = 2,
  Ice = 3,
  Telekinesis = 4,
  Portal = 5,
}

export const POWER_COUNT = 6

export const POWER_NAMES: string[] = ["Fireball", "Lightning", "Energy Sphere", "Ice", "Telekinesis", "Portal"]

/** Short element names used in captions and on the element wheel (index = PowerId). */
export const ELEMENT_NAMES: string[] = ["Fire", "Lightning", "Energy", "Ice", "Gravity", "Portal"]

/** Colours an element uses for its two-hand orb, its flight and the mark it leaves on the world. */
export interface ElementPalette {
  core: vec4
  main: vec4
  accent: vec4
}

/** index = PowerId */
export const ELEMENT_PALETTES: ElementPalette[] = [
  { core: new vec4(1.0, 0.95, 0.65, 1), main: new vec4(1.0, 0.45, 0.08, 1), accent: new vec4(1.0, 0.25, 0.04, 1) },
  { core: new vec4(1.0, 1.0, 1.0, 1), main: new vec4(0.4, 0.85, 1.0, 1), accent: new vec4(0.25, 0.5, 1.0, 1) },
  { core: new vec4(1.0, 0.85, 1.0, 1), main: new vec4(0.62, 0.25, 1.0, 1), accent: new vec4(0.95, 0.45, 1.0, 1) },
  { core: new vec4(1.0, 1.0, 1.0, 1), main: new vec4(0.62, 0.86, 1.0, 1), accent: new vec4(0.32, 0.58, 1.0, 1) },
  { core: new vec4(0.8, 1.0, 0.9, 1), main: new vec4(0.35, 1.0, 0.65, 1), accent: new vec4(0.15, 0.7, 0.5, 1) },
  { core: new vec4(1.0, 0.97, 0.85, 1), main: new vec4(1.0, 0.82, 0.35, 1), accent: new vec4(0.85, 0.25, 1.0, 1) },
]

/** What a real surface is, judged from its normal — world effects adapt to it. */
export type SurfaceKind = "floor" | "wall" | "ceiling" | "person"

/** A two-hand cast that reached something real. */
export interface CastImpact {
  element: PowerId
  position: vec3
  normal: vec3
  /** 0..1 charge the orb was released with. */
  power: number
  surface: SurfaceKind
}

/** Everything the spellbook tracks: six imprints, four reactions (index = bit in the saved mask). */
export type SpellId = "ignite" | "storm" | "sigil" | "frost" | "gravity" | "gateway" | "steam" | "shatter" | "firestorm" | "amplify"
export const SPELL_ORDER: SpellId[] = ["ignite", "storm", "sigil", "frost", "gravity", "gateway", "steam", "shatter", "firestorm", "amplify"]

/** The lasting-magic system, as powers see it. */
export interface WorldMagicApi {
  /** Leave a lasting elemental effect on a real surface (or react with one already there). */
  imprint(element: PowerId, position: vec3, normal: vec3, power: number): void
  /** Nearest live effect of an element within range (cm), or null. */
  nearest(element: PowerId, from: vec3, rangeCm: number): { position: vec3; normal: vec3; radius: number } | null
}

/** A person magic can be cast on (implemented by MagicPowersBodyTarget on the Body Mesh object). */
export interface BodyAnchor {
  /** True while a person is tracked (or the editor's stand-in is standing in). */
  isTracking(): boolean
  /** True when the "person" is the editor's stand-in rather than a tracked body. */
  readonly isMock: boolean
  /** World positions spread over the body this frame: joints plus points along the limbs (empty when nobody is tracked). */
  bodyPoints(): vec3[]
  /** The limbs, as index pairs into bodyPoints() laid end to end: [a0, b0, a1, b1, …]. */
  bodyBones(): number[]
  /** Additive tint for the body mesh; rgb already scaled by intensity. Zero hides the mesh. */
  setAura(r: number, g: number, b: number): void
  /** Ray against the body. Null when the ray misses or nobody is tracked. */
  raycast(origin: vec3, dir: vec3, maxDist: number): { position: vec3; normal: vec3; distance: number } | null
}

/** Live state of the orb held between the hands (owned by the caster, read by powers). */
export interface OrbState {
  presence: number
  charge: number
  centre: vec3
  radius: number
}

export type HandSide = "left" | "right"

export enum GestureType {
  OpenPalm, // hand opened (strength = opening rate, 1/s)
  Fist, // hand closed into a fist
  Pinch, // thumb-index pinch started
  PinchEnd, // pinch released
  Push, // fast movement along the palm normal (strength = cm/s, direction = push dir)
  PalmUp, // open palm turned to face the sky
  PalmUpEnd, // palm no longer facing up
  Point, // index finger extended, others curled (direction = finger dir)
  PointEnd,
  PalmsFacingStart, // both palms facing each other within range
  PalmsFacingEnd,
  HandsSpread, // inter-palm distance growing quickly (strength = cm/s)
  HandsTogether, // inter-palm distance shrinking quickly
  TrackingLost, // hand lost (effects should fade, state is kept)
  TrackingAcquired, // hand re-acquired
  CircleTrace, // index fingertip traced a closed circle (position = centre, direction = circle normal facing the user, strength = radius cm)
  Wave, // an open raised hand swung side to side for a moment — "hello" (strength = swings counted)
}

export interface GestureEvent {
  type: GestureType
  hand: HandSide | "both"
  /** World-space position the gesture happened at (palm center / midpoint). */
  position: vec3
  /** Primary direction of the gesture (palm normal, push direction, finger direction). */
  direction: vec3
  /** Gesture-specific magnitude (see GestureType comments). */
  strength: number
}

/** Per-hand pose, refreshed every frame by MagicPowersGestureRecognizer. */
export class HandPose {
  side: HandSide
  /** True while the tracker reports the hand. */
  tracked = false
  /** 1 while tracked, fades to 0 over the tracking-loss window — effects scale by this. */
  confidence = 0
  palmCenter: vec3 = vec3.zero()
  /** Unit vector pointing out of the palm. */
  palmNormal: vec3 = new vec3(0, 0, 1)
  /** Unit vector from wrist towards the middle knuckle. */
  fingerDir: vec3 = vec3.up()
  wrist: vec3 = vec3.zero()
  indexTip: vec3 = vec3.zero()
  thumbTip: vec3 = vec3.zero()
  /** thumb, index, middle, ring, pinky. */
  fingertips: vec3[] = [vec3.zero(), vec3.zero(), vec3.zero(), vec3.zero(), vec3.zero()]
  /** 0 = fist, 1 = fully open. */
  openness = 0
  /** Rate of change of openness (1/s), positive when opening. */
  openRate = 0
  /** Index extended while the other fingers are curled. */
  pointing = false
  isOpen = false
  isFist = false
  isPinching = false
  isPalmUp = false
  /** Smoothed palm velocity (cm/s). */
  velocity: vec3 = vec3.zero()
  /** Velocity component along the palm normal (cm/s). */
  pushSpeed = 0
  /** 0..1 progress of a wave: an open raised hand swinging side to side. */
  wave = 0

  constructor(side: HandSide) {
    this.side = side
  }
}

/** Relationship between the two hands, refreshed every frame. */
export class TwoHandState {
  bothTracked = false
  /** Palms face each other and are within range. */
  palmsFacing = false
  /** Distance between palm centers (cm). */
  distance = 0
  /** Rate of change of distance (cm/s, positive = spreading). */
  spreadRate = 0
  midpoint: vec3 = vec3.zero()
  /** Unit vector from the left palm to the right palm. */
  axis: vec3 = vec3.right()
}

/** Everything a power needs to render: materials, meshes, textures, camera and a parent for runtime objects. */
export interface EffectsContext {
  /** UberUnlit additive material with vertex colour enabled (billboards, ribbons). Cloned per batch. */
  glowMaterial: Material
  /** Unlit additive material (untextured spheres). Cloned per sphere. */
  solidMaterial: Material
  sphereMesh: RenderMesh
  textures: { glow: Texture; flame: Texture; spark: Texture; ring: Texture; beam: Texture; snowflake: Texture; crystal: Texture; star: Texture }
  /** The world camera transform (SIK WorldCameraFinderProvider). */
  camera: Transform
  /** Parent for every runtime-created effect object. */
  effectsRoot: SceneObject
  /** Lasting magic left on real surfaces. */
  world: WorldMagicApi
  /** The orb currently held between the hands. */
  orb: OrbState
}

/**
 * Base class every elemental power extends. The SpellManager routes gesture events and the
 * per-frame tick to whichever power is active; inactive powers receive nothing.
 *
 * To add a new power: subclass, declare `readonly powerId`, implement the four hooks, attach the
 * @component to an authored SceneObject and wire it into MagicPowersMain's References.
 */
export abstract class MagicPower extends BaseScriptComponent {
  abstract readonly powerId: PowerId

  protected ctx: EffectsContext | null = null
  private active = false

  /** Powers build lazily in onActivate; a concrete onAwake keeps the component lifecycle valid. */
  onAwake(): void {}

  get isActive(): boolean {
    return this.active
  }

  setContext(ctx: EffectsContext): void {
    this.ctx = ctx
  }

  activate(): void {
    if (this.active) return
    this.active = true
    this.onActivate()
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.onDeactivate()
  }

  /**
   * A two-hand cast of this element landed. Return true when the power answers it itself
   * (Portal opens on the surface); false leaves the standard lasting world effect.
   */
  onCastImpact(hit: CastImpact): boolean {
    return false
  }

  /** True while the power is using both hands itself, so the two-hand orb must not form. */
  get claimsTwoHands(): boolean {
    return false
  }

  /** Called when this power becomes the active spell. Build/enable visuals here. */
  protected abstract onActivate(): void
  /** Called when another power takes over. Fade and disable visuals here. */
  protected abstract onDeactivate(): void
  /** Discrete gesture events from the recognizer (only while active). */
  abstract onGesture(e: GestureEvent): void
  /** Per-frame update with the latest poses (only while active). */
  abstract tick(dt: number, left: HandPose, right: HandPose, two: TwoHandState): void
}
