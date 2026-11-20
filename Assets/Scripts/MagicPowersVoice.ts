/**
 * MagicPowersVoice — spoken commands: say an element's name to switch to it, say "multiplayer" to
 * open a shared session.
 *
 * Owns: choosing a speech backend, keeping it listening, and turning short utterances into commands.
 * Expects: start() once after the lens has started; onCommand set by the orchestrator.
 * Must not: act on a command itself — it reports, the orchestrator decides.
 *
 * Two backends, picked by where the lens is running (not by what can be constructed):
 *   on Spectacles  → AsrModule. It is wearable-only: in the Lens Studio preview it builds and starts
 *                    without complaint and then never delivers a transcript.
 *   in Lens Studio → VoiceMLModule, which can hear the desktop microphone. It is deprecated and its
 *                    service is not always up; when it errors, voice is simply off in the preview
 *                    and the editor keys (1-6, M) stand in.
 * If AsrModule fails to START on device, VoiceML is tried instead. The chosen backend is printed at
 * start-up, and `isListening` only turns true once a backend has actually started.
 *
 * On device the transcriber follows the Spectacles system language (AsrModule has no language
 * setting), so these English command words need the glasses set to English.
 *
 * Only short utterances count. The microphone is open the whole time and people talk while they
 * play; a command word inside a longer sentence ("that fire looks nice") is ignored.
 */

import { PowerId } from "./MagicPowersTypes"

export type VoiceCommand = { kind: "element"; element: PowerId } | { kind: "multiplayer" } | { kind: "dispel" }

const ELEMENT_WORDS: Array<[PowerId, string[]]> = [
  [PowerId.Fireball, ["fire", "flame", "fireball"]],
  [PowerId.Lightning, ["lightning", "thunder"]],
  [PowerId.EnergySphere, ["energy"]],
  [PowerId.Ice, ["ice", "frost", "freeze"]],
  [PowerId.Telekinesis, ["gravity", "telekinesis"]],
  [PowerId.Portal, ["portal", "gateway"]],
]
const MULTIPLAYER_WORDS = ["multiplayer", "together", "join", "invite"]
const DISPEL_WORDS = ["dispel", "vanish"]
/** Longer utterances are conversation, not commands. */
const MAX_COMMAND_WORDS = 4
const REPEAT_GUARD_SEC = 1.6

export class MagicVoice {
  /** A command was heard. `heard` is the transcript it came from. */
  onCommand: ((command: VoiceCommand, heard: string) => void) | null = null

  private backend: "asr" | "voiceml" | "none" = "none"
  private live = false
  private lastKey = ""
  private lastAt = -10
  private asr: AsrModule | null = null
  private voiceMl: VoiceMLModule | null = null
  private torn = false
  private voiceMlFailed = false

  constructor(private log: boolean) {}

  /** True once a backend has really started listening. */
  get isListening(): boolean {
    return this.live
  }

  get backendName(): string {
    return this.backend
  }

  start(): void {
    let onDevice = true
    try {
      onDevice = !global.deviceInfoSystem.isEditor()
    } catch (e) {
      onDevice = true // no device info: assume hardware
    }
    if (onDevice && this.startAsr()) this.backend = "asr"
    else if (this.startVoiceMl()) this.backend = "voiceml"
    else this.backend = "none"
    print(`[MagicPowersVoice] speech backend: ${this.backend}`)
  }

  stop(): void {
    this.torn = true
    this.live = false
    try {
      if (this.asr) this.asr.stopTranscribing()
      if (this.voiceMl) this.voiceMl.stopListening()
    } catch (e) {
      // shutting down — nothing to recover
    }
  }

  private startAsr(): boolean {
    try {
      const asr = require("LensStudio:AsrModule") as AsrModule
      // The module can be require-able and still have no startTranscribing: check before committing.
      if (!asr || typeof asr.startTranscribing !== "function") return false
      const options = AsrModule.AsrTranscriptionOptions.create()
      options.mode = AsrModule.AsrMode.HighSpeed
      options.silenceUntilTerminationMs = 700
      options.onTranscriptionUpdateEvent.add((e) => this.onTranscript(e.text, e.isFinal))
      options.onTranscriptionErrorEvent.add((code) => {
        this.live = false
        print(`[MagicPowersVoice] ASR error ${code} — voice commands are off`)
      })
      asr.startTranscribing(options)
      this.asr = asr
      this.live = true
      return true
    } catch (e) {
      print(`[MagicPowersVoice] ASR could not start (${e}) — trying VoiceML`)
      return false
    }
  }

  private startVoiceMl(): boolean {
    try {
      const voiceMl = require("LensStudio:VoiceMLModule") as VoiceMLModule
      if (!voiceMl) return false
      const options = VoiceML.ListeningOptions.create()
      options.shouldReturnAsrTranscription = true
      options.shouldReturnInterimAsrTranscription = true
      options.languageCode = "en_US"
      const phrases: string[] = MULTIPLAYER_WORDS.concat(DISPEL_WORDS)
      for (const entry of ELEMENT_WORDS) for (const w of entry[1]) phrases.push(w)
      try {
        options.addSpeechContext(phrases, 5)
      } catch (e) {
        // boosting is a nicety
      }
      voiceMl.onListeningEnabled.add(() => {
        if (this.torn || this.voiceMlFailed) return
        voiceMl.startListening(options)
        this.live = true
      })
      voiceMl.onListeningDisabled.add(() => {
        this.live = false
        voiceMl.stopListening()
      })
      voiceMl.onListeningError.add((e) => {
        // The service answering with an error means nothing is being heard: say so once and stop,
        // rather than leaving `isListening` true and retrying every few seconds.
        if (this.torn || this.voiceMlFailed) return
        this.voiceMlFailed = true
        this.live = false
        print(`[MagicPowersVoice] VoiceML is not available (${e.error} ${e.description}) — voice commands are off. In Lens Studio use keys 1-6 and M instead.`)
        try {
          voiceMl.stopListening()
        } catch (err) {
          // already stopped
        }
      })
      voiceMl.onListeningUpdate.add((e) => {
        if (e.transcription) this.onTranscript(e.transcription, e.isFinalTranscription)
      })
      this.voiceMl = voiceMl
      return true
    } catch (e) {
      print(`[MagicPowersVoice] VoiceML could not start (${e})`)
      return false
    }
  }

  private onTranscript(text: string, isFinal: boolean): void {
    if (this.torn || !text) return
    const command = this.parse(text)
    if (this.log && isFinal) print(`[MagicPowersVoice] heard "${text}" → ${command ? JSON.stringify(command) : "no command"}`)
    if (!command) return
    // Interim and final results repeat the same words; act once.
    const key = command.kind === "element" ? `element:${command.element}` : command.kind
    const now = getTime()
    if (key === this.lastKey && now - this.lastAt < REPEAT_GUARD_SEC) return
    this.lastKey = key
    this.lastAt = now
    if (this.onCommand) this.onCommand(command, text)
  }

  /** Whole words only ("nice" is not "ice"), and only in a short utterance. */
  parse(text: string): VoiceCommand | null {
    const words = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0)
    if (words.length === 0 || words.length > MAX_COMMAND_WORDS) return null
    const has = (list: string[]): boolean => {
      for (const w of words) if (list.indexOf(w) >= 0) return true
      return false
    }
    if (has(MULTIPLAYER_WORDS) || (has(["multi"]) && has(["player"]))) return { kind: "multiplayer" }
    for (const entry of ELEMENT_WORDS) if (has(entry[1])) return { kind: "element", element: entry[0] }
    if (has(DISPEL_WORDS)) return { kind: "dispel" }
    return null
  }
}
