import type { Notify, OpencodeEvent, RpcMethod, RelayToClient } from "@opencode-mobile/protocol"

import type { Credentials } from "./credentials"
import { websocketUrl } from "./credentials"

export type RelayStatus = {
  machineName: string
  agentOnline: boolean
  phonesConnected: number
  pushDevices: number
  lastSeenAt: number
}

const RPC_TIMEOUT_MS = 40_000

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? `request failed (${response.status})`
  } catch {
    return `request failed (${response.status})`
  }
}

export class RelayApi {
  constructor(private credentials: Credentials) {}

  get relayUrl() {
    return this.credentials.relayUrl
  }

  get machineId() {
    return this.credentials.machineId
  }

  private authHeaders() {
    return { authorization: `Bearer ${this.credentials.deviceSecret}`, "content-type": "application/json" }
  }

  async pair(input: { relayUrl: string; machineId: string; code: string; deviceId: string; deviceSecret: string; deviceName: string }) {
    const response = await fetch(`${input.relayUrl.replace(/\/+$/, "")}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine: input.machineId,
        code: input.code,
        deviceId: input.deviceId,
        deviceSecret: input.deviceSecret,
        deviceName: input.deviceName,
        platform: "android",
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    return (await response.json()) as { ok: boolean; machineName: string; agentOnline: boolean }
  }

  async rpc<T>(method: RpcMethod, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.relayUrl}/v1/rpc`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ machine: this.machineId, method, params }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as { result?: T; error?: string }
      if (body.error) throw new Error(body.error)
      return body.result as T
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new Error("the bridge did not answer in time")
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async status() {
    const response = await fetch(`${this.relayUrl}/v1/status?machine=${encodeURIComponent(this.machineId)}`, {
      headers: this.authHeaders(),
    })
    if (!response.ok) throw new Error(await readError(response))
    return (await response.json()) as RelayStatus
  }

  async inbox() {
    const response = await fetch(`${this.relayUrl}/v1/inbox?machine=${encodeURIComponent(this.machineId)}`, {
      headers: this.authHeaders(),
    })
    if (!response.ok) throw new Error(await readError(response))
    const body = (await response.json()) as { notifications: Notify[] }
    return body.notifications
  }

  async registerPushToken(pushToken: string | null) {
    const response = await fetch(`${this.relayUrl}/v1/push`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ machine: this.machineId, pushToken }),
    })
    if (!response.ok) throw new Error(await readError(response))
    return response.json()
  }

  async unpair() {
    const response = await fetch(`${this.relayUrl}/v1/unpair`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ machine: this.machineId }),
    })
    if (!response.ok) throw new Error(await readError(response))
    return response.json()
  }

  /** Live channel for opencode events and notifications, with automatic reconnects. */
  openStream(handlers: {
    onEvent?: (event: OpencodeEvent) => void
    onNotify?: (notify: Notify) => void
    onOpen?: () => void
    onClose?: () => void
  }) {
    let socket: WebSocket | null = null
    let closed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      // React Native's WebSocket accepts an options argument with headers, which the
      // DOM typings do not describe.
      const NativeWebSocket = WebSocket as unknown as {
        new (url: string, protocols: string[] | null, options: { headers: Record<string, string> }): WebSocket
      }
      socket = new NativeWebSocket(websocketUrl(this.relayUrl, this.machineId), null, {
        headers: { authorization: `Bearer ${this.credentials.deviceSecret}` },
      })

      socket.onopen = () => {
        attempt = 0
        handlers.onOpen?.()
      }
      socket.onmessage = (message) => {
        let parsed: RelayToClient
        try {
          parsed = JSON.parse(String(message.data)) as RelayToClient
        } catch {
          return
        }
        if (parsed.kind === "event") handlers.onEvent?.(parsed.event)
        else if (parsed.kind === "notify") handlers.onNotify?.(parsed.notify)
      }
      socket.onclose = () => {
        handlers.onClose?.()
        if (closed) return
        attempt += 1
        const delay = Math.min(20_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 300
        timer = setTimeout(connect, delay)
      }
      socket.onerror = () => socket?.close()
    }

    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
      socket = null
    }
  }
}