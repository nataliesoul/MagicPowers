/**
 * MagicPowersNetwork — the shared session: everyone in the room casts into the same world.
 *
 * Owns: starting a Spectacles Sync Kit session on request (the kit runs in "Off" start mode, so it
 *       never shows its own button menu), the session's state, who is in it, and the handful of
 *       networked events that keep players in step — a released orb, a mark left on a surface, a
 *       cast that landed on a person, and the orb someone is holding right now.
 * Expects: the SpectaclesSyncKit prefab in the scene with Start Mode = Off and Is Colocated on.
 *       Without it join() simply times out and the lens stays solo.
 * Must not: draw anything or decide what an event means — it delivers, the orchestrator applies.
 *
 * Positions travel in the colocated frame (the kit's Located At object), which every player's
 * glasses agree on; each device converts to and from its own world space at the edge.
 *
 * Nothing is sent before the session is live. The kit queues events sent early and replays them on
 * connect, which would fire every cast from the solo warm-up at the first friend to join.
 */

import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController"
import { SyncEntity } from "SpectaclesSyncKit.lspkg/Core/SyncEntity"
import { NetworkMessage } from "SpectaclesSyncKit.lspkg/Core/NetworkMessage"
import { StartModeController } from "SpectaclesSyncKit.lspkg/StartMenu/Scripts/StartModeController"
import { PowerId } from "./MagicPowersTypes"

export type NetState = "solo" | "joining" | "live" | "failed"

type Triple = [number, number, number]
interface CastMsg {
  e: number
  f: Triple
  t: Triple
  n: Triple
  p: number
}
interface MarkMsg {
  e: number
  a: Triple
  n: Triple
  p: number
}
interface OrbMsg {
  e: number
  c: Triple
  r: number
  h: number
}

const JOIN_TIMEOUT_SEC = 40
const ORB_SEND_INTERVAL_SEC = 0.12

export class MagicNetwork {
  /** The session state changed (solo → joining → live, or → failed). */
  onStateChanged: ((state: NetState) => void) | null = null
  onPlayerJoined: ((name: string) => void) | null = null
  onPlayerLeft: ((name: string) => void) | null = null
  /** Another player released an orb: draw it flying (its landing arrives as its own event). */
  onRemoteCast: ((element: PowerId, from: vec3, to: vec3, normal: vec3, power: number) => void) | null = null
  /** Another player's magic marked a surface. */
  onRemoteImprint: ((element: PowerId, position: vec3, normal: vec3, power: number) => void) | null = null
  /** Another player's cast landed on a person standing at `position`. */
  onRemoteEnchant: ((element: PowerId, position: vec3, power: number) => void) | null = null
  /** Another player is holding an orb (sent a few times a second; `radius` 0 = they let go). */
  onRemoteOrb: ((playerId: string, element: PowerId, centre: vec3, radius: number, charge: number) => void) | null = null

  private current: NetState = "solo"
  private entity: SyncEntity | null = null
  private joinStartedAt = -1
  private lastOrbAt = -1
  private orbOpen = false

  constructor(host: ScriptComponent, private log: boolean) {
    try {
      const session = SessionController.getInstance()
      this.entity = new SyncEntity(host)
      const e = this.entity
      e.onRemoteEventReceived.add("cast", (m: NetworkMessage<unknown>) => {
        const d = m.data as CastMsg
        if (this.log) print(`[MagicPowersNetwork] remote cast: element ${d.e}`)
        if (this.onRemoteCast) this.onRemoteCast(d.e as PowerId, this.pointIn(d.f), this.pointIn(d.t), this.dirIn(d.n), d.p)
      })
      e.onRemoteEventReceived.add("mark", (m: NetworkMessage<unknown>) => {
        const d = m.data as MarkMsg
        if (this.log) print(`[MagicPowersNetwork] remote mark: element ${d.e}`)
        if (this.onRemoteImprint) this.onRemoteImprint(d.e as PowerId, this.pointIn(d.a), this.dirIn(d.n), d.p)
      })
      e.onRemoteEventReceived.add("enchant", (m: NetworkMessage<unknown>) => {
        const d = m.data as MarkMsg
        if (this.log) print(`[MagicPowersNetwork] remote enchant: element ${d.e}`)
        if (this.onRemoteEnchant) this.onRemoteEnchant(d.e as PowerId, this.pointIn(d.a), d.p)
      })
      e.onRemoteEventReceived.add("orb", (m: NetworkMessage<unknown>) => {
        const d = m.data as OrbMsg
        if (this.onRemoteOrb) this.onRemoteOrb(m.senderConnectionId, d.e as PowerId, this.pointIn(d.c), d.r, d.h)
      })
      session.notifyOnReady(() => this.setState("live"))
      session.onConnectionFailed.add((code: string, description: string) => {
        if (this.log) print(`[MagicPowersNetwork] connection failed (${code}): ${description}`)
        if (this.current === "joining") this.setState("failed")
      })
      session.onDisconnected.add(() => {
        if (this.current === "live") this.setState("failed")
      })
      session.onUserJoinedSession.add((_s, user) => {
        if (this.current === "live" && this.onPlayerJoined && !session.isLocalUserConnection(user)) this.onPlayerJoined(user.displayName || "A mage")
      })
      session.onUserLeftSession.add((_s, user) => {
        if (this.current === "live" && this.onPlayerLeft) this.onPlayerLeft(user.displayName || "A mage")
      })
    } catch (e) {
      print(`[MagicPowersNetwork] Sync Kit is not available (${e}) — multiplayer is off.`)
      this.entity = null
    }
  }

  get state(): NetState {
    return this.current
  }

  get isLive(): boolean {
    return this.current === "live"
  }

  /** True when the Sync Kit is present, so a session can be opened at all. */
  get isAvailable(): boolean {
    return this.entity !== null
  }

  get playerCount(): number {
    if (!this.isLive) return 1
    try {
      return Math.max(1, SessionController.getInstance().getUsers().length)
    } catch (e) {
      return 1
    }
  }

  /** Open (or join) the shared session. Safe to call again after a failure. */
  join(): void {
    if (!this.entity || this.current === "joining" || this.current === "live") return
    this.setState("joining")
    this.joinStartedAt = getTime()
    try {
      // In Off start mode this makes a single attempt and reports failure through onConnectionFailed.
      StartModeController.getInstance().startMultiplayer()
      SessionController.getInstance().init() // no-op if the line above already started it
    } catch (e) {
      print(`[MagicPowersNetwork] could not start the session: ${e}`)
      this.setState("failed")
    }
  }

  /** Call once per frame: gives up on a join that never answers. */
  update(): void {
    if (this.current === "joining" && getTime() - this.joinStartedAt > JOIN_TIMEOUT_SEC) this.setState("failed")
  }

  private setState(next: NetState): void {
    if (next === this.current) return
    this.current = next
    if (this.log) print(`[MagicPowersNetwork] ${next}`)
    if (this.onStateChanged) this.onStateChanged(next)
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  sendCast(element: PowerId, from: vec3, to: vec3, normal: vec3, power: number): void {
    if (!this.isLive || !this.entity) return
    const msg: CastMsg = { e: element, f: this.pointOut(from), t: this.pointOut(to), n: this.dirOut(normal), p: power }
    this.entity.sendEvent("cast", msg, true)
  }

  sendImprint(element: PowerId, position: vec3, normal: vec3, power: number): void {
    if (!this.isLive || !this.entity) return
    const msg: MarkMsg = { e: element, a: this.pointOut(position), n: this.dirOut(normal), p: power }
    this.entity.sendEvent("mark", msg, true)
  }

  sendEnchant(element: PowerId, position: vec3, power: number): void {
    if (!this.isLive || !this.entity) return
    const msg: MarkMsg = { e: element, a: this.pointOut(position), n: [0, 1, 0], p: power }
    this.entity.sendEvent("enchant", msg, true)
  }

  /** The orb in this player's hands, sent a few times a second while it exists and once when it ends. */
  sendOrb(element: PowerId, centre: vec3, radius: number, charge: number, held: boolean): void {
    if (!this.isLive || !this.entity) return
    const now = getTime()
    if (held) {
      if (now - this.lastOrbAt < ORB_SEND_INTERVAL_SEC) return
      this.lastOrbAt = now
      this.orbOpen = true
      const msg: OrbMsg = { e: element, c: this.pointOut(centre), r: radius, h: charge }
      this.entity.sendEvent("orb", msg, true)
    } else if (this.orbOpen) {
      this.orbOpen = false
      const msg: OrbMsg = { e: element, c: this.pointOut(centre), r: 0, h: 0 }
      this.entity.sendEvent("orb", msg, true)
    }
  }

  // ── The shared frame ────────────────────────────────────────────────────────

  private frame(): Transform | null {
    try {
      const located = SessionController.getInstance().getLocatedAtComponent()
      return located ? located.getSceneObject().getTransform() : null
    } catch (e) {
      return null
    }
  }

  private pointOut(p: vec3): Triple {
    const f = this.frame()
    const q = f ? f.getInvertedWorldTransform().multiplyPoint(p) : p
    return [q.x, q.y, q.z]
  }

  private pointIn(a: Triple): vec3 {
    const p = new vec3(a[0], a[1], a[2])
    const f = this.frame()
    return f ? f.getWorldTransform().multiplyPoint(p) : p
  }

  private dirOut(d: vec3): Triple {
    const f = this.frame()
    const q = f ? f.getInvertedWorldTransform().multiplyDirection(d) : d
    return [q.x, q.y, q.z]
  }

  private dirIn(a: Triple): vec3 {
    const d = new vec3(a[0], a[1], a[2])
    const f = this.frame()
    const q = f ? f.getWorldTransform().multiplyDirection(d) : d
    return q.length > 1e-4 ? q.normalize() : vec3.up()
  }
}
