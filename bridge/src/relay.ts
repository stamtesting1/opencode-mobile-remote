import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import WebSocket from "ws"

import type { BridgeMessage, Notify, OpencodeEvent, RpcMethod } from "@opencode-mobile/protocol"

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type RelayClientOptions = {
  url: string
  machineId: string
  machineSecret: string
  log?: (message: string) => void
  onRpc: (method: RpcMethod, params: Record<string, unknown>, requestId: string) => Promise<unknown>
  onEvent: (event: OpencodeEvent) => void
  onNotify: (notify: Notify) => void
  onStatus?: (connected: boolean) => void
}

/**
 * Outbound websocket to the Cloudflare relay. The bridge never accepts inbound
 * connections, so it works from behind home routers, VPNs and firewalls.
 */
export class RelayClient extends EventEmitter {
  private socket: WebSocket | null = null
  private closed = false
  private attempt = 0
  private heartbeat: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private pending = new Map<string, Pending>()

  constructor(private options: RelayClientOptions) {
    super()
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  start() {
    this.closed = false
    this.connect()
  }

  stop() {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error("relay connection closed"))
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = null
  }

  private log(message: string) {
    this.options.log?.(message)
  }

  private connect() {
    if (this.closed) return
    const url = new URL(this.options.url)
    if (url.protocol === "https:") url.protocol = "wss:"
    if (url.protocol === "http:") url.protocol = "ws:"
    // The relay URL is the worker base (the phone uses the same base for /v1/pair etc).
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/link`
    url.searchParams.set("machine", this.options.machineId)

    const socket = new WebSocket(url.toString(), {
      headers: {
        authorization: `Bearer ${this.options.machineSecret}`,
        "user-agent": "opencode-bridge",
      },
      handshakeTimeout: 15_000,
    })
    this.socket = socket

    socket.on("open", () => {
      this.attempt = 0
      this.log("relay connected")
      this.options.onStatus?.(true)
      this.send({
        kind: "hello",
        machineId: this.options.machineId,
        machineSecret: this.options.machineSecret,
        agent: "opencode-bridge",
      })
      this.startHeartbeat()
    })

    socket.on("message", (raw) => {
      void this.handleMessage(raw.toString())
    })

    socket.on("close", () => {
      this.options.onStatus?.(false)
      this.startHeartbeatCleanup()
      if (!this.closed) this.scheduleReconnect("relay closed")
    })

    socket.on("error", (error) => {
      this.log(`relay socket error: ${error.message}`)
    })
  }

  private startHeartbeat() {
    this.startHeartbeatCleanup()
    this.heartbeat = setInterval(() => {
      if (this.connected) this.send({ kind: "ping" })
    }, 25_000)
    this.heartbeat.unref?.()
  }

  private startHeartbeatCleanup() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.closed || this.reconnectTimer) return
    this.attempt += 1
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6)) + Math.random() * 400
    this.log(`${reason}, reconnecting in ${Math.round(delay)}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  send(message: BridgeMessage) {
    if (!this.connected) return false
    this.socket?.send(JSON.stringify(message))
    return true
  }

  notify(notify: Notify) {
    this.send({ kind: "notify", notify })
  }

  private async handleMessage(raw: string) {
    let message: BridgeMessage
    try {
      message = JSON.parse(raw) as BridgeMessage
    } catch {
      return
    }

    switch (message.kind) {
      case "ping":
        this.send({ kind: "pong" })
        return
      case "pong":
        return
      case "hello":
        this.options.onStatus?.(true)
        return
      case "rpc.result":
      case "rpc.error": {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.kind === "rpc.result") pending.resolve(message.result)
        else pending.reject(new Error(message.error?.message ?? "relay error"))
        return
      }
      case "event":
        this.options.onEvent(message.event)
        return
      case "notify":
        this.options.onNotify(message.notify)
        return
      case "rpc": {
        try {
          const result = await this.options.onRpc(message.method, (message.params ?? {}) as Record<string, unknown>, message.id)
          this.send({ kind: "rpc.result", id: message.id, result })
        } catch (error) {
          this.send({
            kind: "rpc.error",
            id: message.id,
            error: { message: (error as Error).message },
          })
        }
        return
      }
      default:
        return
    }
  }

  /** Calls a method implemented by the relay itself (for example publishing a pairing code). */
  async callRpc<T>(method: RpcMethod | "pairing.set" | "pairing.clear", params: unknown = {}, timeoutMs = 20_000): Promise<T> {
    return this.call<T>({ kind: "rpc", id: randomUUID(), method: method as RpcMethod, params }, timeoutMs)
  }

  private call<T>(message: { kind: "rpc"; id: string; method: RpcMethod; params: unknown }, timeoutMs = 20_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error(`relay request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(message.id, { resolve: resolve as (value: unknown) => void, reject, timer })
      if (!this.send(message)) {
        clearTimeout(timer)
        this.pending.delete(message.id)
        reject(new Error("relay not connected"))
      }
    })
  }
}