/**
 * MagicPowersAudioLib — spatial SFX helper.
 *
 * Owns: SfxEmitter, a thin wrapper over AudioComponent that lives on an effect object so the
 *       sound is positioned where the magic is (spatial audio), plus one-shot helpers.
 * Expects: an AudioTrackAsset from MagicPowersAssetManifest and a host SceneObject.
 * Must not: decide WHEN to play — powers own that.
 *
 * Interactive cues use Audio.PlaybackMode.LowLatency (Specs defaults to LowPower, which adds
 * audible lag on gesture-triggered sounds). Loops/beds use LowPower.
 */

export class SfxEmitter {
  private audio: AudioComponent
  private baseVolume: number
  private targetVolume: number
  private currentVolume: number

  constructor(host: SceneObject, track: AudioTrackAsset, volume = 1, lowLatency = true) {
    this.audio = host.createComponent("Component.AudioComponent") as AudioComponent
    this.audio.audioTrack = track
    this.audio.playbackMode = lowLatency ? Audio.PlaybackMode.LowLatency : Audio.PlaybackMode.LowPower
    this.baseVolume = volume
    this.targetVolume = volume
    this.currentVolume = volume
    this.audio.volume = volume
    try {
      this.audio.spatialAudio.enabled = true
    } catch (e) {
      // Spatial audio is unavailable in some preview configurations — non-fatal.
    }
  }

  /** Play once (loops = 1) or forever (loops = -1). */
  play(loops = 1): void {
    if (isNull(this.audio)) return
    this.audio.volume = this.currentVolume
    this.audio.play(loops)
  }

  playIfSilent(loops = -1): void {
    if (isNull(this.audio)) return
    if (!this.audio.isPlaying()) this.play(loops)
  }

  stop(fade = true): void {
    if (isNull(this.audio)) return
    if (this.audio.isPlaying()) this.audio.stop(fade)
  }

  get isPlaying(): boolean {
    return !isNull(this.audio) && this.audio.isPlaying()
  }

  /** Target volume as a multiplier of the base volume (0..1+); smoothed in update(). */
  setLevel(level: number): void {
    this.targetVolume = Math.max(0, this.baseVolume * level)
  }

  /** Smooth the volume towards the target. Call once per frame for loops that scale with intensity. */
  update(dt: number, rate = 10): void {
    if (isNull(this.audio)) return
    const k = 1 - Math.exp(-rate * dt)
    this.currentVolume += (this.targetVolume - this.currentVolume) * k
    this.audio.volume = this.currentVolume
  }

  destroy(): void {
    if (!isNull(this.audio)) {
      this.audio.stop(false)
      this.audio.destroy()
    }
  }
}

interface OneShot {
  host: SceneObject
  audio: AudioComponent
  startedAt: number
}

const liveOneShots: OneShot[] = []
const MAX_LIVE_ONE_SHOTS = 24

/**
 * Fire-and-forget one-shot at a world position. The host object is reclaimed by updateOneShots()
 * once the clip has finished (setOnFinish is not reliable for spatial clips in every preview mode).
 */
export function playOneShotAt(parent: SceneObject, track: AudioTrackAsset, position: vec3, volume = 1): void {
  if (liveOneShots.length >= MAX_LIVE_ONE_SHOTS) {
    const oldest = liveOneShots.shift()!
    if (!isNull(oldest.host)) oldest.host.destroy()
  }
  const host = global.scene.createSceneObject("OneShotSfx")
  host.setParent(parent)
  host.getTransform().setWorldPosition(position)
  const audio = host.createComponent("Component.AudioComponent") as AudioComponent
  audio.audioTrack = track
  audio.playbackMode = Audio.PlaybackMode.LowLatency
  audio.volume = volume
  try {
    audio.spatialAudio.enabled = true
  } catch (e) {
    // non-fatal
  }
  audio.play(1)
  liveOneShots.push({ host, audio, startedAt: getTime() })
}

/** Reclaim finished one-shot hosts. Call once per frame from the orchestrator. */
export function updateOneShots(): void {
  const now = getTime()
  for (let i = liveOneShots.length - 1; i >= 0; i--) {
    const s = liveOneShots[i]
    const finished = isNull(s.host) || isNull(s.audio) || (now - s.startedAt > 0.3 && !s.audio.isPlaying()) || now - s.startedAt > 8
    if (finished) {
      if (!isNull(s.host)) s.host.destroy()
      liveOneShots.splice(i, 1)
    }
  }
}
