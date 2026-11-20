/**
 * MagicPowersAudioLib — spatial SFX helper.
 *
 * Owns: SfxEmitter (a thin wrapper over AudioComponent that lives on an effect object so the sound
 *       is positioned where the magic is), pooled one-shots and pooled loops for world effects.
 * Expects: an AudioTrackAsset from MagicPowersAssetManifest and a host SceneObject; tickAudio() once
 *       per frame from the orchestrator.
 * Must not: decide WHEN to play — powers own that.
 *
 * Two rules shape everything here, both about the cost of assigning `audioTrack` (the engine opens
 * and decodes the file on the main thread when it is assigned):
 *
 * 1. A voice's track is assigned once, ever. One-shots play on a small pool of voices per track
 *    instead of a new AudioComponent per sound, so a sound that plays fifty times opens its file
 *    once or twice, not fifty times.
 *
 * 2. At most ONE file is opened per frame, and never inside a start-up call. The Lens Studio preview
 *    on Windows can take seconds to open a single file; several in one script call trip the script
 *    watchdog ("Javascript execution has timed out") and the lens dies. So an emitter only records
 *    its track; the open happens on first play if this frame's budget is free, otherwise the sound
 *    is skipped that once and the voice is opened on a following frame (a requested loop then
 *    starts by itself). On device, where opening is cheap, every voice is also warmed in the
 *    background shortly after start so the first cast is never the one that pays.
 *
 * Interactive cues use Audio.PlaybackMode.LowLatency (Specs defaults to LowPower, which adds
 * audible lag on gesture-triggered sounds). Loops/beds use LowPower.
 */

const IN_EDITOR = global.deviceInfoSystem.isEditor()
const WARM_INTERVAL_SEC = 0.35
/** A track starts with one voice; a second is added only if the first is still sounding when needed again. */
const MAX_VOICES_PER_TRACK = 2

// ─── One file open per frame ─────────────────────────────────────────────────

let budgetFrame = -1
let opensThisFrame = 0

/** Claim this frame's single file open. getTime() is the frame's start time, so it identifies the frame. */
function claimOpen(): boolean {
  const frame = getTime()
  if (frame !== budgetFrame) {
    budgetFrame = frame
    opensThisFrame = 0
  }
  if (opensThisFrame >= 1) return false
  opensThisFrame++
  return true
}

// ─── Emitters ────────────────────────────────────────────────────────────────

/** Emitters still waiting for their file to be opened. */
const coldEmitters: SfxEmitter[] = []

export class SfxEmitter {
  private audio: AudioComponent
  private coldTrack: AudioTrackAsset | null
  private queued = false
  /** A loop asked for while cold: start it as soon as the file is open. */
  private loopWanted = false
  private baseVolume: number
  private targetVolume: number
  private currentVolume: number

  constructor(host: SceneObject, track: AudioTrackAsset, volume = 1, lowLatency = true) {
    this.audio = host.createComponent("Component.AudioComponent") as AudioComponent
    this.coldTrack = track
    this.audio.playbackMode = lowLatency ? Audio.PlaybackMode.LowLatency : Audio.PlaybackMode.LowPower
    this.baseVolume = volume
    this.targetVolume = volume
    this.currentVolume = volume
    this.audio.volume = volume
    if (!IN_EDITOR) this.enqueue() // on device: opened in the background before it is needed
  }

  private enqueue(): void {
    if (this.queued || this.coldTrack === null) return
    this.queued = true
    coldEmitters.push(this)
  }

  get isCold(): boolean {
    return this.coldTrack !== null
  }

  /** Open the file (the expensive part). Called with the frame's open budget already claimed. */
  open(): void {
    if (this.coldTrack === null || isNull(this.audio)) return
    this.audio.audioTrack = this.coldTrack
    this.coldTrack = null
    try {
      this.audio.spatialAudio.enabled = true
    } catch (e) {
      // Spatial audio is unavailable in some preview configurations — non-fatal.
    }
    if (this.loopWanted) {
      this.loopWanted = false
      this.audio.volume = this.currentVolume
      this.audio.play(-1)
    }
  }

  /** Play once (loops = 1) or forever (loops = -1). */
  play(loops = 1): void {
    if (isNull(this.audio)) return
    if (this.coldTrack !== null) {
      if (claimOpen()) this.open()
      else {
        // This frame has already opened a file: skip this play, open soon, and honour a loop then.
        this.loopWanted = loops === -1
        this.enqueue()
        return
      }
    }
    this.audio.volume = this.currentVolume
    this.audio.play(loops)
  }

  playIfSilent(loops = -1): void {
    if (isNull(this.audio)) return
    if (this.coldTrack !== null) {
      if (!this.loopWanted) this.play(loops)
      return
    }
    if (!this.audio.isPlaying()) this.play(loops)
  }

  stop(fade = true): void {
    this.loopWanted = false
    if (isNull(this.audio) || this.coldTrack !== null) return
    if (this.audio.isPlaying()) this.audio.stop(fade)
  }

  get isPlaying(): boolean {
    if (isNull(this.audio)) return false
    return this.coldTrack !== null ? this.loopWanted : this.audio.isPlaying()
  }

  /** Target volume as a multiplier of the base volume (0..1+); smoothed in update(). */
  setLevel(level: number): void {
    this.targetVolume = Math.max(0, this.baseVolume * level)
  }

  /** Jump straight to a level (used to start a pooled loop from silence). */
  snapLevel(level: number): void {
    this.targetVolume = Math.max(0, this.baseVolume * level)
    this.currentVolume = this.targetVolume
    if (!isNull(this.audio)) this.audio.volume = this.currentVolume
  }

  setBaseVolume(volume: number): void {
    this.baseVolume = volume
  }

  /** Smooth the volume towards the target. Call once per frame for loops that scale with intensity. */
  update(dt: number, rate = 10): void {
    if (isNull(this.audio)) return
    const k = 1 - Math.exp(-rate * dt)
    const next = this.currentVolume + (this.targetVolume - this.currentVolume) * k
    if (Math.abs(next - this.currentVolume) < 0.0005) return
    this.currentVolume = next
    this.audio.volume = next
  }

  destroy(): void {
    this.loopWanted = false
    if (!isNull(this.audio)) {
      if (this.coldTrack === null) this.audio.stop(false)
      this.audio.destroy()
    }
  }
}

// ─── Pooled one-shots ────────────────────────────────────────────────────────

interface Voice {
  host: SceneObject
  audio: AudioComponent
}

interface VoicePool {
  track: AudioTrackAsset
  voices: Voice[]
  next: number
}

const voicePools: VoicePool[] = []
/** Tracks whose first voice still has to be built. */
const coldTracks: Array<{ parent: SceneObject; track: AudioTrackAsset }> = []

function makeVoice(parent: SceneObject, track: AudioTrackAsset): Voice {
  const host = global.scene.createSceneObject("SfxVoice")
  host.setParent(parent)
  const audio = host.createComponent("Component.AudioComponent") as AudioComponent
  audio.audioTrack = track // the one and only assignment for this voice
  audio.playbackMode = Audio.PlaybackMode.LowLatency
  try {
    audio.spatialAudio.enabled = true
  } catch (e) {
    // non-fatal
  }
  return { host, audio }
}

function findPool(track: AudioTrackAsset): VoicePool | null {
  for (const p of voicePools) if (p.track === track) return p
  return null
}

function queueTrack(parent: SceneObject, track: AudioTrackAsset): void {
  for (const c of coldTracks) if (c.track === track) return
  coldTracks.push({ parent, track })
}

/** Build a track's first voice. Called with the frame's open budget already claimed. */
function buildPool(parent: SceneObject, track: AudioTrackAsset): VoicePool {
  const pool: VoicePool = { track, voices: [makeVoice(parent, track)], next: 0 }
  voicePools.push(pool)
  return pool
}

/**
 * Fire-and-forget one-shot at a world position, played on a pooled voice for that track. If the
 * track has no voice yet and this frame has already opened a file, the sound is skipped this once.
 */
export function playOneShotAt(parent: SceneObject, track: AudioTrackAsset, position: vec3, volume = 1): void {
  if (isNull(parent)) return
  let pool = findPool(track)
  if (!pool) {
    if (!claimOpen()) {
      queueTrack(parent, track)
      return
    }
    pool = buildPool(parent, track)
  }
  let v: Voice | null = null
  for (let i = 0; i < pool.voices.length; i++) {
    const c = pool.voices[i]
    if (isNull(c.host) || isNull(c.audio)) continue
    if (!c.audio.isPlaying()) {
      v = c
      break
    }
  }
  if (!v) {
    // every voice is busy: add a second one if the budget allows, otherwise restart the oldest
    if (pool.voices.length < MAX_VOICES_PER_TRACK && claimOpen()) {
      v = makeVoice(parent, track)
      pool.voices.push(v)
    } else {
      v = pool.voices[pool.next]
      pool.next = (pool.next + 1) % pool.voices.length
      if (isNull(v.host) || isNull(v.audio)) return
    }
  }
  v.host.getTransform().setWorldPosition(position)
  v.audio.volume = volume
  v.audio.play(1)
}

/** Device only: queue tracks so their voices exist before the first cast needs them. */
export function prewarmSfx(parent: SceneObject, tracks: AudioTrackAsset[]): void {
  if (IN_EDITOR) return // the preview opens each file on first use instead (see the header note)
  for (const track of tracks) queueTrack(parent, track)
}

let lastWarmAt = -1

/** Call once per frame from the orchestrator: now and then opens one waiting file in the background. */
export function tickAudio(): void {
  if (coldEmitters.length === 0 && coldTracks.length === 0) return
  const now = getTime()
  if (lastWarmAt >= 0 && now - lastWarmAt < WARM_INTERVAL_SEC) return
  if (!claimOpen()) return
  lastWarmAt = now
  const emitter = coldEmitters.shift()
  if (emitter) {
    emitter.open()
    return
  }
  const next = coldTracks.shift()
  if (next && !isNull(next.parent) && !findPool(next.track)) buildPool(next.parent, next.track)
}

// ─── Pooled loops (world effects) ────────────────────────────────────────────

export interface LoopVoice {
  track: AudioTrackAsset
  host: SceneObject
  emitter: SfxEmitter
  busy: boolean
}

/** A capped set of reusable looping voices; a world effect borrows one for as long as it lives. */
export class LoopVoices {
  private voices: LoopVoice[] = []

  constructor(private parent: SceneObject, private cap = 6) {}

  acquire(track: AudioTrackAsset, position: vec3, volume: number): LoopVoice | null {
    let v: LoopVoice | null = null
    for (const c of this.voices) {
      if (!c.busy && c.track === track && !isNull(c.host)) {
        v = c
        break
      }
    }
    if (!v) {
      if (this.voices.length >= this.cap) return null
      const host = global.scene.createSceneObject("LoopVoice")
      host.setParent(this.parent)
      v = { track, host, emitter: new SfxEmitter(host, track, volume, false), busy: false }
      this.voices.push(v)
    }
    v.busy = true
    v.host.getTransform().setWorldPosition(position)
    v.emitter.setBaseVolume(volume)
    v.emitter.snapLevel(0)
    v.emitter.play(-1)
    return v
  }

  release(v: LoopVoice | null): void {
    if (!v) return
    v.emitter.stop(true)
    v.busy = false
  }
}
