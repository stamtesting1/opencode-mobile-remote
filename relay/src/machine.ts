import { DurableObject } from "cloudflare:workers"

import type { Notify, OpencodeEvent } from "@opencode-mobile/protocol"
import { normalizeCode, randomHex, safeEqual, sha256 } from "./crypto"
import { fetchPushReceipts, sendExpoPush, type ExpoPushMessage } from "./push"

export type Env = {
  MACHINES: DurableObjectNamespace<Machine>
}

type AgentAttachment = { role: "agent" }
type DeviceAttachment = { role: "device"; deviceId: string }
type Attachment = AgentAttachment | DeviceAttachment

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: number
}

const CALL_TIMEOUT_MS = 30_000
const RECEIPT_CHECK_DELAY_MS = 20 * 60 * 1000
const PAIRING_ATTEMPT_LIMIT = 8
const PAIRING_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const INBOX_LIMIT = 60

/**
 * One Durable Object per machine (the laptop).
 *
 * It owns three things: the outbound socket from the bridge, the sockets from paired
 * phones, and the small amount of state needed to make an untrusted phone safe
 * (device secrets, pairing codes, push tokens).
 */
export class Machine extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingCall>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          push_token TEXT,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          notify TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_tickets (
          ticket_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
      const existing = this.firstRow<{ salt: string }>("SELECT value as salt FROM meta WHERE key = 'salt'")
      if (!existing) {
        this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('salt', ?)", randomHex(16))
      }
    })
  }

  // ------------------------------------------------------------------ storage helpers

  private get salt() {
    return this.firstRow<{ value: string }>("SELECT value FROM meta WHERE key = 'salt'")?.value ?? ""
  }

  /**
   * `SqlStorage.exec(...).one()` throws when a query matches nothing, which makes
   * "row may be absent" cases awkward. Every lookup in this class goes through here.
   */
  private firstRow<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...params: (string | number | null)[]
  ): T | null {
    return this.ctx.storage.sql.exec<T>(query, ...params).toArray()[0] ?? null
  }

  private meta(key: string): string | null {
    return this.firstRow<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    )
  }

  private deleteMeta(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", key)
  }

  private async hashSecret(secret: string) {
    return sha256(secret, this.salt)
  }

  private agentSockets() {
    return this.ctx.getWebSockets().filter((socket) => this.attachment(socket)?.role === "agent")
  }

  private deviceSockets() {
    return this.ctx
      .getWebSockets()
      .filter((socket) => this.attachment(socket)?.role === "device")
  }

  /**
   * Sockets only carry an attachment once we set one, and reading a missing
   * attachment throws, so every socket in this class is tagged on accept.
   */
  private attachment(socket: WebSocket): Attachment | null {
    try {
      return socket.deserializeAttachment() as Attachment | null
    } catch {
      return null
    }
  }

  private async authorizeDevice(deviceSecret: string | null): Promise<{ deviceId: string } | null> {
    if (!deviceSecret) return null
    const hash = await this.hashSecret(deviceSecret)
    const row = this.firstRow<{ device_id: string }>("SELECT device_id FROM devices WHERE secret_hash = ?", hash)
    return row ? { deviceId: row.device_id } : null
  }

  // ------------------------------------------------------------------ http entry points

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const auth = bearer(request)

    if (url.pathname === "/link") return this.handleAgentLink(request, auth)
    if (url.pathname === "/stream") return this.handleDeviceStream(request, auth)
    return new Response("not found", { status: 404 })
  }

  private async handleAgentLink(request: Request, auth: string | null) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 })
    }
    if (!auth) return new Response("missing machine secret", { status: 401 })

    const providedHash = await this.hashSecret(auth)
    const storedHash = this.meta("machine_secret_hash")
    if (!storedHash) {
      // First ever connection claims this machine id.
      this.setMeta("machine_secret_hash", providedHash)
    } else if (!safeEqual(storedHash, providedHash)) {
      return new Response("invalid machine secret", { status: 401 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, ["agent"])
    server.serializeAttachment({ role: "agent" } satisfies AgentAttachment)

    this.setMeta("last_seen_at", String(Date.now()))
    server.send(JSON.stringify({ kind: "hello", machineId: this.ctx.id.toString() }))
    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleDeviceStream(request: Request, auth: string | null) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 })
    }
    const device = await this.authorizeDevice(auth)
    if (!device) return new Response("unauthorised", { status: 401 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, ["device"])
    server.serializeAttachment({ role: "device", deviceId: device.deviceId } satisfies DeviceAttachment)
    this.touchDevice(device.deviceId)
    server.send(JSON.stringify({ kind: "hello" }))
    return new Response(null, { status: 101, webSocket: client })
  }

  private touchDevice(deviceId: string) {
    this.ctx.storage.sql.exec("UPDATE devices SET last_seen_at = ? WHERE device_id = ?", Date.now(), deviceId)
  }

  // ------------------------------------------------------------------ hibernation handlers

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const attachment = this.attachment(socket)
    if (attachment?.role === "device") return this.onDeviceMessage(socket, parsed)

    const kind = parsed.kind
    if (kind === "hello") {
      if (typeof parsed.machineId === "string") this.setMeta("machine_id", parsed.machineId)
      if (typeof parsed.agent === "string") this.setMeta("agent", parsed.agent)
      this.setMeta("last_seen_at", String(Date.now()))
      return
    }
    if (kind === "ping") {
      socket.send(JSON.stringify({ kind: "pong" }))
      return
    }
    if (kind === "rpc") {
      await this.onAgentRpc(socket, parsed)
      return
    }
    if (kind === "rpc.result" || kind === "rpc.error") {
      const id = typeof parsed.id === "string" ? parsed.id : ""
      const ok = kind === "rpc.result"
      const message = (parsed.error as { message?: string } | undefined)?.message
      this.resolveAgentCall(id, ok, parsed.result, message)
      return
    }
    if (kind === "event") {
      this.broadcastToDevices({ kind: "event", event: parsed.event as OpencodeEvent })
      return
    }
    if (kind === "notify") {
      await this.onNotify(parsed.notify as Notify)
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const attachment = this.attachment(socket)
    if (attachment?.role === "device") {
      this.touchDevice(attachment.deviceId)
    }
    void code
    void reason
  }

  async webSocketError(socket: WebSocket, error: unknown) {
    console.warn("relay socket error", error)
    void socket
  }

  private async onDeviceMessage(socket: WebSocket, parsed: Record<string, unknown>) {
    if (parsed.kind === "ping") socket.send(JSON.stringify({ kind: "pong" }))
  }

  /** `pairing.set` and friends: methods the bridge calls on the relay itself. */
  private async onAgentRpc(socket: WebSocket, parsed: Record<string, unknown>) {
    const id = typeof parsed.id === "string" ? parsed.id : ""
    const method = typeof parsed.method === "string" ? parsed.method : ""
    const params = (parsed.params ?? {}) as Record<string, unknown>
    try {
      let result: unknown = true
      if (method === "pairing.set") {
        const code = normalizeCode(String(params.code ?? ""))
        if (!code) throw new Error("pairing.set requires a code")
        this.setMeta("pairing_code", code)
        this.setMeta("pairing_expires_at", String(Number(params.expiresAt ?? Date.now() + 30 * 60 * 1000)))
        if (typeof params.machineName === "string") this.setMeta("machine_name", params.machineName)
        this.clearPairingFailures()
      } else if (method === "pairing.clear") {
        this.deleteMeta("pairing_code")
        this.deleteMeta("pairing_expires_at")
      } else {
        throw new Error(`relay does not implement ${method}`)
      }
      socket.send(JSON.stringify({ kind: "rpc.result", id, result }))
    } catch (error) {
      socket.send(JSON.stringify({ kind: "rpc.error", id, error: { message: (error as Error).message } }))
    }
  }

  // ------------------------------------------------------------------ pairing

  async pair(params: {
    code?: string
    deviceId?: string
    deviceSecret?: string
    deviceName?: string
    platform?: string
  }) {
    const code = normalizeCode(params.code ?? "")
    const deviceId = params.deviceId
    const deviceSecret = params.deviceSecret
    if (!deviceId || !deviceSecret) {
      throw new Error("pair requires deviceId and deviceSecret")
    }

    this.assertNotRateLimited()

    const expectedCode = this.meta("pairing_code")
    const expiresAt = Number(this.meta("pairing_expires_at") ?? 0)
    const knownDevice = this.firstRow<{ device_id: string }>("SELECT device_id FROM devices WHERE device_id = ?", deviceId)

    if (!knownDevice) {
      if (!code) {
        this.recordPairingFailure()
        throw new Error("invalid or expired pairing code")
      }
      if (!expectedCode || Date.now() > expiresAt || !safeEqual(expectedCode, code)) {
        this.recordPairingFailure()
        throw new Error("invalid or expired pairing code")
      }
      const now = Date.now()
      this.ctx.storage.sql.exec(
        `INSERT INTO devices (device_id, secret_hash, name, platform, push_token, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        deviceId,
        await this.hashSecret(deviceSecret),
        params.deviceName?.slice(0, 64) ?? "phone",
        params.platform?.slice(0, 16) ?? "android",
        now,
        now,
      )
      // A successful pairing retires the code.
      this.deleteMeta("pairing_code")
      this.deleteMeta("pairing_expires_at")
      this.clearPairingFailures()
    } else {
      this.touchDevice(deviceId)
    }

    return {
      ok: true,
      machineName: this.meta("machine_name") ?? "machine",
      agentOnline: this.agentSockets().length > 0,
    }
  }

  private assertNotRateLimited() {
    const failures = Number(this.meta("pair_failures") ?? 0)
    const firstAt = Number(this.meta("pair_failures_at") ?? 0)
    if (failures >= PAIRING_ATTEMPT_LIMIT && Date.now() - firstAt < PAIRING_ATTEMPT_WINDOW_MS) {
      throw new Error("too many pairing attempts, try again later")
    }
  }

  private recordPairingFailure() {
    const failures = Number(this.meta("pair_failures") ?? 0)
    const firstAt = Number(this.meta("pair_failures_at") ?? 0)
    const stale = Date.now() - firstAt > PAIRING_ATTEMPT_WINDOW_MS
    this.setMeta("pair_failures", String(stale ? 1 : failures + 1))
    if (stale || !firstAt) this.setMeta("pair_failures_at", String(Date.now()))
  }

  private clearPairingFailures() {
    this.deleteMeta("pair_failures")
    this.deleteMeta("pair_failures_at")
  }

  // ------------------------------------------------------------------ devices

  async registerPush(deviceSecret: string | null, pushToken: string | null) {
    const device = await this.authorizeDevice(deviceSecret)
    if (!device) throw new Error("unauthorised")
    this.ctx.storage.sql.exec(
      "UPDATE devices SET push_token = ? WHERE device_id = ?",
      pushToken?.slice(0, 300) ?? null,
      device.deviceId,
    )
    return { ok: true }
  }

  async revokeDevice(deviceSecret: string | null) {
    const device = await this.authorizeDevice(deviceSecret)
    if (!device) throw new Error("unauthorised")
    this.ctx.storage.sql.exec("DELETE FROM devices WHERE device_id = ?", device.deviceId)
    for (const socket of this.deviceSockets()) socket.close(4001, "revoked")
    return { ok: true }
  }

  async status(deviceSecret: string | null) {
    const device = await this.authorizeDevice(deviceSecret)
    if (!device) throw new Error("unauthorised")
    const pushCount = this.firstRow<{ count: number }>("SELECT COUNT(*) as count FROM devices WHERE push_token IS NOT NULL")
    return {
      machineName: this.meta("machine_name") ?? "machine",
      agentOnline: this.agentSockets().length > 0,
      phonesConnected: this.deviceSockets().length,
      pushDevices: pushCount?.count ?? 0,
      lastSeenAt: Number(this.meta("last_seen_at") ?? 0),
    }
  }

  async inbox(deviceSecret: string | null) {
    const device = await this.authorizeDevice(deviceSecret)
    if (!device) throw new Error("unauthorised")
    const rows = this.ctx.storage.sql
      .exec<{ notify: string; created_at: number }>("SELECT notify, created_at FROM inbox ORDER BY id DESC LIMIT 40")
      .toArray()
    return rows.map((row) => JSON.parse(row.notify) as Notify)
  }

  // ------------------------------------------------------------------ calls into the bridge

  async callAgent(deviceSecret: string | null, method: string, params: unknown) {
    const device = await this.authorizeDevice(deviceSecret)
    if (!device) throw new Error("unauthorised")

    const agents = this.agentSockets()
    if (!agents.length) throw new Error("the bridge is offline, start it on your machine")

    const id = randomHex(12)
    const socket = agents[0]!
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("the bridge did not answer in time"))
      }, CALL_TIMEOUT_MS) as unknown as number
      this.pending.set(id, { resolve, reject, timer })
    })

    socket.send(JSON.stringify({ kind: "rpc", id, method, params }))
    return response
  }

  /** Called when a bridge answers a call we forwarded. */
  resolveAgentCall(id: string, ok: boolean, payload: unknown, errorMessage?: string) {
    const pending = this.pending.get(id)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new Error(errorMessage ?? "bridge error"))
    return true
  }

  // ------------------------------------------------------------------ notifications

  private broadcastToDevices(message: unknown) {
    const payload = JSON.stringify(message)
    for (const socket of this.deviceSockets()) {
      try {
        socket.send(payload)
      } catch {
        /* the close handler will clean this socket up */
      }
    }
  }

  private async onNotify(notify: Notify) {
    this.ctx.storage.sql.exec("INSERT INTO inbox (notify, created_at) VALUES (?, ?)", JSON.stringify(notify), notify.at)
    this.ctx.storage.sql.exec(
      `DELETE FROM inbox WHERE id NOT IN (SELECT id FROM inbox ORDER BY id DESC LIMIT ${INBOX_LIMIT})`,
    )

    this.broadcastToDevices({ kind: "notify", notify })

    const devices = this.ctx.storage.sql
      .exec<{ device_id: string; push_token: string }>("SELECT device_id, push_token FROM devices WHERE push_token IS NOT NULL")
      .toArray()

    const messages: ExpoPushMessage[] = devices.map((device) => ({
      to: device.push_token,
      title: notify.title,
      body: notify.body,
      sound: "default",
      priority: notify.kind === "approval" ? "high" : "default",
      channelId: notify.kind === "approval" ? "approvals" : "updates",
      badge: notify.kind === "approval" ? 1 : 0,
      data: {
        kind: notify.kind,
        sessionID: notify.sessionID ?? null,
        permissionID: notify.permissionID ?? null,
        directory: notify.directory ?? null,
        at: notify.at,
      },
    }))

    if (!messages.length) return

    try {
      const tickets = await sendExpoPush(messages)
      const now = Date.now()
      for (const ticket of tickets) {
        if (!ticket.id) {
          if (this.isFatalTokenError(ticket.message ?? "")) {
            this.deletePushToken(ticket.token)
          }
          continue
        }
        const device = devices.find((candidate) => candidate.push_token === ticket.token)
        if (!device) continue
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO push_tickets (ticket_id, device_id, created_at) VALUES (?, ?, ?)",
          ticket.id,
          device.device_id,
          now,
        )
      }
      await this.ctx.storage.setAlarm(Date.now() + RECEIPT_CHECK_DELAY_MS)
    } catch (error) {
      console.error("push send failed", (error as Error).message)
    }
  }

  private isFatalTokenError(message: string) {
    const fatal = ["DeviceNotRegistered", "NotRegistered", "invalid credentials", "MismatchSenderId"]
    return fatal.some((needle) => message.includes(needle))
  }

  private deletePushToken(token: string) {
    this.ctx.storage.sql.exec("UPDATE devices SET push_token = NULL WHERE push_token = ?", token)
  }

  async alarm() {
    const rows = this.ctx.storage.sql
      .exec<{ ticket_id: string; device_id: string }>("SELECT ticket_id, device_id FROM push_tickets WHERE created_at < ?", Date.now() - RECEIPT_CHECK_DELAY_MS)
      .toArray()
    this.ctx.storage.sql.exec("DELETE FROM push_tickets")
    if (!rows.length) return

    try {
      const receipts = await fetchPushReceipts(rows.map((row) => row.ticket_id))
      for (const [ticketId, receipt] of receipts) {
        if (receipt.ok) continue
        const ticket = rows.find((row) => row.ticket_id === ticketId)
        if (!ticket) continue
        const device = this.firstRow<{ push_token: string | null }>(
          "SELECT push_token FROM devices WHERE device_id = ?",
          ticket.device_id,
        )
        if (device?.push_token && this.isFatalTokenError(receipt.message ?? "")) {
          this.deletePushToken(device.push_token)
        }
      }
    } catch (error) {
      console.error("receipt check failed", (error as Error).message)
    }
  }

  agentOnline() {
    return this.agentSockets().length > 0
  }
}

export function bearer(request: Request) {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}