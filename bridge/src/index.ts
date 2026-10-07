import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomInt, randomUUID } from "node:crypto"
import { once } from "node:events"

import type {
  ChatMessage,
  FileDiff,
  MachineInfo,
  Notify,
  OpencodeEvent,
  Permission,
  RpcMethod,
  SessionDetail,
  SessionSummary,
} from "@opencode-mobile/protocol"
import { loadConfig, requireConfig, saveConfig, type BridgeConfig } from "./config.js"
import { EventProcessor } from "./events.js"
import { OpencodeClient, OpencodeError } from "./opencode.js"
import { RelayClient } from "./relay.js"
import { Store } from "./store.js"

const BRIDGE_VERSION = "0.1.0"
const PAIRING_TTL_MS = 30 * 60 * 1000
const PAIRING_ROTATE_MS = 15 * 60 * 1000
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** A code lives for half an hour and is replaced every quarter of one. */
function pairingDeadline() {
  return Date.now() + Math.min(PAIRING_TTL_MS, PAIRING_ROTATE_MS)
}

function timestamp() {
  return new Date().toISOString().slice(11, 19)
}

function log(message: string) {
  console.log(`[${timestamp()}] ${message}`)
}

function generatePairingCode() {
  const block = () =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")
  return `${block()}-${block()}`
}

class Bridge {
  private store = new Store()
  private processor: EventProcessor
  private relay: RelayClient
  private client: OpencodeClient
  private server: ChildProcess | null = null
  private eventAbort: AbortController | null = null
private pairingCode = generatePairingCode()
  private pairingExpires = pairingDeadline()
  private online = false
  private startedAt = Date.now()
  private stopping = false
  /**
   * Every directory this opencode instance can serve. `/project` only answers for a
   * directory you name, so we keep our own set: the configured working directory plus
   * whatever the event stream tells us about.
   */
  private knownDirectories = new Map<string, string>()

private constructor(private cfg: BridgeConfig) {
    this.processor = new EventProcessor(this.store)
    this.client = this.makeClient(cfg.opencodeUrl ?? `http://127.0.0.1:${cfg.opencodePort}`)
    this.relay = new RelayClient({
      url: cfg.relayUrl,
      machineId: cfg.machineId,
      machineSecret: cfg.machineSecret,
      log: (message) => log(`relay: ${message}`),
      onStatus: (connected) => {
        const changed = this.online !== connected
        this.online = connected
        if (changed) log(connected ? "relay: connected" : "relay: offline")
        if (connected) void this.publishPairingCode()
      },
      onEvent: (event) => this.onEvent(event),
      onNotify: (notify) => log(`notify: ${notify.kind} - ${notify.title}`),
      onRpc: (method, params) => this.handleRpc(method, params),
    })
  }

  private makeClient(url: string) {
    const auth = this.cfg.opencodePassword
      ? { username: this.cfg.opencodeUsername ?? "opencode", password: this.cfg.opencodePassword }
      : undefined
    return new OpencodeClient(url, auth)
  }

  static async start() {
    const config = requireConfig(loadConfig())
    const bridge = new Bridge(config)
    await bridge.boot()
    return bridge
  }

private async boot() {
    this.store.load()
    saveConfig(this.cfg)
    log(`machine ${this.cfg.machineName} (${this.cfg.machineId.slice(0, 8)}…)`)
    if (this.cfg.opencodeDir) this.rememberDirectory(this.cfg.opencodeDir)

    await this.ensureOpencode()
    await this.seedSessionState()

    this.eventAbort = new AbortController()
    void this.watchEvents()

    this.relay.start()
    setInterval(() => this.rotatePairingIfNeeded(), 60_000).unref?.()

    this.printBanner()
  }

  private async ensureOpencode() {
    if (this.cfg.opencodeUrl) {
      await this.waitForHealth(this.cfg.opencodeUrl, 30_000, `existing opencode server at ${this.cfg.opencodeUrl}`)
      this.client = this.makeClient(this.cfg.opencodeUrl)
      log(`attached to opencode at ${this.cfg.opencodeUrl}`)
      return
    }

    const url = `http://127.0.0.1:${this.cfg.opencodePort}`
    if (await this.isHealthy(url)) {
      this.client = this.makeClient(url)
      log(`reusing opencode already serving on port ${this.cfg.opencodePort}`)
      return
    }

const opencodeBinary =
      process.env.OPENCODE_BIN ?? (process.platform === "win32" ? "opencode.cmd" : "opencode")
    log(`starting opencode server on port ${this.cfg.opencodePort} in ${this.cfg.opencodeDir}`)
    this.server = spawn(
      opencodeBinary,
      ["serve", "--port", String(this.cfg.opencodePort), "--hostname", "127.0.0.1"],
      {
        cwd: this.cfg.opencodeDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
        // On Windows the CLI is a .cmd shim around opencode.exe, which Node refuses to
        // spawn without a shell.
        shell: process.platform === "win32",
      },
    )
    this.server.stdout?.on("data", (chunk: Buffer) => log(`opencode: ${chunk.toString().trim()}`))
    this.server.stderr?.on("data", (chunk: Buffer) => log(`opencode: ${chunk.toString().trim()}`))
    this.server.on("exit", (code) => {
      if (this.stopping) return
      log(`opencode server exited with code ${code}`)
    })

    try {
      await this.waitForHealth(url, 60_000, "opencode server")
    } catch (error) {
      throw new Error(`${(error as Error).message}\nIs the opencode CLI installed and on PATH?`)
    }
    this.client = this.makeClient(url)
  }

  private async isHealthy(url: string) {
    try {
      const health = await this.makeClient(url).health()
      return Boolean(health.healthy)
    } catch {
      return false
    }
  }

  private async waitForHealth(url: string, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs
    let lastError = ""
    while (Date.now() < deadline) {
      try {
        const health = await this.makeClient(url).health()
        if (health.healthy) return health
      } catch (error) {
        lastError = (error as Error).message
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out waiting for ${label} at ${url}${lastError ? `: ${lastError}` : ""}`)
  }

/** Prime the busy/idle view so a bridge restart does not silence "task finished". */
  private async seedSessionState() {
    try {
      for (const directory of await this.discoverDirectories()) {
        const statuses = await this.client.status(directory).catch(() => ({}))
        for (const [sessionID, status] of Object.entries(statuses ?? {})) {
          this.store.setStatus(directory, sessionID, status)
          if (status.type === "busy") this.processor.seedBusy(directory, sessionID)
        }
      }
      const pending = this.store.approvals()
      if (pending.length) {
        log(`restored ${pending.length} pending approval(s) from disk`)
        for (const approval of pending) this.rememberDirectory(approval.directory)
      }
    } catch (error) {
      log(`could not seed session state: ${(error as Error).message}`)
    }
  }

  /**
   * Asks opencode which projects it knows about, one directory at a time, and unions the
   * result with the directories we already know.
   */
  private rememberDirectory(directory: string) {
    const normalized = normalizeDirectory(directory)
    if (normalized) this.knownDirectories.set(directoryKey(normalized), normalized)
  }

private async discoverDirectories(): Promise<string[]> {
    for (const directory of [...this.knownDirectories.values()]) {
      try {
        const projects = await this.client.projects(directory)
        for (const project of projects) this.rememberDirectory(project.worktree)
      } catch {
        /* a directory that opencode does not serve is simply skipped */
      }
    }

    // Listing sessions without a directory returns every project this server has ever
    // served, and each one carries its directory. That is how a bridge started in one
    // folder still learns about the rest of your work.
    try {
      for (const session of await this.client.sessions()) {
        if (session.directory) this.rememberDirectory(session.directory)
      }
    } catch (error) {
      log(`could not discover project directories: ${(error as Error).message}`)
    }

    return [...this.knownDirectories.values()]
  }

  private async watchEvents() {
    while (!this.stopping && this.eventAbort) {
      try {
        for await (const event of this.client.events(this.eventAbort.signal)) {
          this.onEvent(event)
        }
        log("event stream ended, restarting")
      } catch (error) {
        if (this.stopping) return
        log(`event stream error: ${(error as Error).message}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

private onEvent(event: OpencodeEvent) {
    if (typeof event.directory === "string" && event.directory) this.rememberDirectory(event.directory)

    let notify: Notify | undefined
    try {
      const result = this.processor.process(event)
      notify = result.notify
    } catch (error) {
      log(`event handling failed for ${event.type}: ${(error as Error).message}`)
    }

    this.relay.send({ kind: "event", event })
    if (notify) {
      this.store.flush()
      this.relay.notify(notify)
    }
  }

  private async publishPairingCode() {
    try {
      await this.relay.callRpc("pairing.set", {
        code: this.pairingCode,
        expiresAt: this.pairingExpires,
        machineName: this.cfg.machineName,
      })
    } catch (error) {
      log(`could not publish pairing code: ${(error as Error).message}`)
    }
  }

  private rotatePairingIfNeeded() {
    if (Date.now() < this.pairingExpires) return
    this.pairingCode = generatePairingCode()
    this.pairingExpires = pairingDeadline()
    log("pairing code rotated")
    this.printPairingCode()
    void this.publishPairingCode()
  }

  private printPairingCode() {
    const minutes = Math.round((this.pairingExpires - Date.now()) / 60_000)
    console.log("")
    console.log("  ┌─────────────────────────────────────────────┐")
    console.log(`  │  Pair this phone in the app:  ${this.pairingCode.padEnd(15)}│`)
    console.log(`  │  valid for ${String(minutes).padStart(2)} min${minutes === 1 ? " " : " "}                │`)
    console.log("  └─────────────────────────────────────────────┘")
    console.log("")
  }

  private printBanner() {
    const attachCommand = this.cfg.opencodeUrl ?? `http://127.0.0.1:${this.cfg.opencodePort}`
    console.log("")
    console.log("  opencode mobile bridge is running")
    console.log(`  opencode server : ${attachCommand}`)
    console.log(`  working dir     : ${this.cfg.opencodeDir}`)
    console.log(`  relay           : ${this.cfg.relayUrl}`)
    console.log("")
    console.log("  Use the TUI on this same server so the phone can see your sessions:")
    console.log(`    opencode attach ${attachCommand}`)
    console.log("")
    this.printPairingCode()
    console.log("  Press Ctrl+C to stop.")
    console.log("")
  }

  async stop() {
    this.stopping = true
    this.eventAbort?.abort()
    this.relay.stop()
    this.store.flush()
if (this.server && !this.server.killed) {
      // With a shell in the middle on Windows, killing the shell leaves opencode.exe
      // holding the port, so take down the whole tree.
      if (process.platform === "win32" && this.server.pid) {
        spawnSync("taskkill", ["/pid", String(this.server.pid), "/T", "/F"], { windowsHide: true })
      } else {
        this.server.kill()
      }
      await Promise.race([once(this.server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))])
    }
  }

  // ---------------------------------------------------------------- rpc handlers

  private async handleRpc(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "machine.info":
        return this.machineInfo()

      case "projects.list":
        return this.client.projects()

      case "sessions.list":
        return this.sessionsList(params)

      case "session.get":
        return this.sessionGet(params)

      case "session.diff":
        return this.client.diff(requiredString(params, "directory"), requiredString(params, "id"))

      case "session.prompt": {
        const directory = requiredString(params, "directory")
        const id = requiredString(params, "id")
        const text = requiredString(params, "text")
        const messageID = newMessageId()
        await this.client.prompt(directory, id, text, {
          messageID,
          agent: optionalString(params, "agent"),
          model: optionalString(params, "model"),
        })
        return { messageID }
      }

      case "session.create": {
        const directory = requiredString(params, "directory")
        const text = requiredString(params, "text")
        const session = await this.client.createSession(directory, optionalString(params, "title") ?? firstLine(text))
        const messageID = newMessageId()
        await this.client.prompt(directory, session.id, text, {
          messageID,
          agent: optionalString(params, "agent"),
          model: optionalString(params, "model"),
        })
        return { sessionID: session.id }
      }

      case "session.abort":
        return this.client.abort(requiredString(params, "directory"), requiredString(params, "id"))

      case "session.rename":
        return this.client.rename(
          requiredString(params, "directory"),
          requiredString(params, "id"),
          requiredString(params, "title"),
        )

      case "approvals":
        return this.store.approvalsFor(optionalString(params, "directory"))

      case "approvals.resolve": {
        const directory = requiredString(params, "directory")
        const sessionID = requiredString(params, "sessionID")
        const permissionID = requiredString(params, "permissionID")
        const response = requiredString(params, "response")
        if (response !== "once" && response !== "always" && response !== "reject") {
          throw new Error(`invalid permission response: ${response}`)
        }
        const result = await this.client.respondPermission(directory, sessionID, permissionID, response)
        this.store.removeApproval(directory, sessionID, permissionID)
        return result
      }

      case "agents.list":
        return this.client.agents()

      case "models.list":
        return this.client.models()

      default:
        throw new Error(`unknown method: ${String(method)}`)
    }
  }

private async machineInfo(): Promise<MachineInfo> {
    let opencodeHealthy = false
    let opencodeVersion: string | undefined
    let directories: string[] = []
    try {
      const health = await this.client.health()
      opencodeHealthy = Boolean(health.healthy)
      opencodeVersion = health.version
      directories = await this.discoverDirectories()
    } catch (error) {
      log(`machine.info health check failed: ${(error as Error).message}`)
    }

    return {
      machineId: this.cfg.machineId,
      name: this.cfg.machineName,
      opencodeHealthy,
      opencodeVersion,
      bridgeVersion: BRIDGE_VERSION,
      bridgeStartedAt: this.startedAt,
      directories,
    }
  }

  private async sessionsList(params: Record<string, unknown>): Promise<SessionSummary[]> {
    const requested = optionalString(params, "directory")
    const limit = Number(params.limit ?? 50)
    const directories = new Set<string>()
    if (requested) directories.add(normalizeDirectory(requested))
    for (const directory of await this.discoverDirectories()) directories.add(directory)
    for (const approval of this.store.approvals()) directories.add(approval.directory)

    const byId = new Map<string, SessionSummary>()
    for (const directory of directories) {
      let sessions: { id: string; title: string; directory: string; projectID: string; parentID?: string; time: { created: number; updated: number }; summary?: { additions: number; deletions: number; files: number } }[]
      let statuses: Record<string, { type: string }> = {}
      try {
        sessions = await this.client.sessions(directory)
        statuses = await this.client.status(directory)
      } catch (error) {
        if (error instanceof OpencodeError && error.status === 404) continue
        throw error
      }

      for (const session of sessions) {
        if (byId.has(session.id)) continue
        const memory = this.store.sessionMemory(session.directory, session.id)
        const status = (statuses[session.id] ?? memory?.status ?? { type: "idle" }) as SessionSummary["status"]
        byId.set(session.id, {
          id: session.id,
          title: session.title || "Untitled session",
          directory: session.directory,
          projectID: session.projectID,
          parentID: session.parentID,
          time: session.time,
          status,
          approvalCount: this.store.approvalCount(session.directory, session.id),
          changeCount: session.summary?.files ?? 0,
          additions: session.summary?.additions ?? 0,
          deletions: session.summary?.deletions ?? 0,
          lastText: memory?.lastText ?? "",
          error: memory?.error,
        })
      }
    }

    return [...byId.values()]
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50)
  }

  private async sessionGet(params: Record<string, unknown>): Promise<SessionDetail> {
    const id = requiredString(params, "id")
    const directory = requiredString(params, "directory")
    const [sessions, statuses, rawMessages, todos, diffs] = await Promise.all([
      this.client.sessions(directory),
      this.client.status(directory),
      this.client.messages(directory, id, 100),
      this.client.todos(directory, id).catch(() => []),
      this.client.diff(directory, id).catch(() => [] as FileDiff[]),
    ])

    const session = sessions.find((candidate) => candidate.id === id)
    if (!session) throw new Error(`session ${id} not found in ${directory}`)

    const messages: ChatMessage[] = rawMessages.map((entry) => ({
      ...(entry.info as ChatMessage),
      parts: entry.parts as ChatMessage["parts"],
    }))

    const cost = messages.reduce((total, message) => total + (message.cost ?? 0), 0)
    const tokens = messages.reduce(
      (total, message) => ({
        input: total.input + (message.tokens?.input ?? 0),
        output: total.output + (message.tokens?.output ?? 0),
        reasoning: total.reasoning + (message.tokens?.reasoning ?? 0),
        cacheRead: total.cacheRead + (message.tokens?.cache?.read ?? 0),
        cacheWrite: total.cacheWrite + (message.tokens?.cache?.write ?? 0),
      }),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    )

    const memory = this.store.sessionMemory(directory, id)
    const lastError = [...messages].reverse().find((message) => message.error)?.error

    return {
      session,
      messages,
      todos,
approvals: this.store
        .approvals()
        .filter((approval) => approval.sessionID === id && approval.directory === directory),
      diffs,
      status: (statuses[id] ?? memory?.status ?? { type: "idle" }) as SessionDetail["status"],
      cost,
      tokens,
      error: memory?.error ?? lastError?.data?.message ?? lastError?.name,
    }
  }
}

/** opencode requires client-supplied message ids to be prefixed with "msg". */
function newMessageId() {
  return `msg_${randomUUID().replace(/-/g, "")}`
}

function requiredString(params: Record<string, unknown>, key: string) {
  const value = params[key]
  if (typeof value !== "string" || !value.length) throw new Error(`missing required parameter: ${key}`)
  return value
}

function optionalString(params: Record<string, unknown>, key: string) {
  const value = params[key]
  return typeof value === "string" && value.length ? value : undefined
}

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim().length)?.trim().slice(0, 80) ?? text.slice(0, 80)
}

/** Paths must match across opencode, the store and the phone, so normalise separators. */
function normalizeDirectory(directory: string) {
  const trimmed = directory.replace(/[\\/]+$/, "")
  return process.platform === "win32" ? trimmed.replace(/\//g, "\\") : trimmed
}

/** Case insensitive key, because Windows paths are, while the original string is kept for display. */
function directoryKey(directory: string) {
  return normalizeDirectory(directory).toLowerCase()
}

const bridge = await Bridge.start()

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("")
    log("shutting down")
    void bridge.stop().then(() => process.exit(0))
  })
}