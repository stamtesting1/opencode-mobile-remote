import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { Permission, SessionStatus } from "@opencode-mobile/protocol"
import { STATE_PATH } from "./config.js"

export type ApprovalRecord = Permission & { directory: string; receivedAt: number }

export type SessionMemory = {
  lastText: string
  lastTextAt: number
  lastTool?: { tool: string; title?: string; status: string; at: number }
  status?: SessionStatus
  error?: string
  idleNotifiedAt?: number
  createdAt: number
  updatedAt: number
}

export type BridgeState = {
  version: number
  approvals: Record<string, ApprovalRecord>
  sessions: Record<string, SessionMemory>
}

export const key = (directory: string, sessionID: string) => `${directory}::${sessionID}`

const emptyState = (): BridgeState => ({ version: 1, approvals: {}, sessions: {} })

/**
 * Small persistent cache: pending approvals and per-session activity.
 *
 * Approvals exist only as server-sent events, so we mirror them to disk. That way a
 * bridge restart (or a reconnect after the laptop woke up) cannot lose an approval the
 * user still needs to answer.
 */
export class Store {
  private state: BridgeState = emptyState()
  private timer: NodeJS.Timeout | null = null

  load() {
    if (!existsSync(STATE_PATH)) {
      this.state = emptyState()
      return this.state
    }
    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as BridgeState
      this.state = {
        version: 1,
        approvals: parsed.approvals ?? {},
        sessions: parsed.sessions ?? {},
      }
    } catch {
      this.state = emptyState()
    }
    return this.state
  }

  private schedulePersist() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.persist()
    }, 1500)
    this.timer.unref?.()
  }

  persist() {
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true })
      const tmp = STATE_PATH + ".tmp"
      writeFileSync(tmp, JSON.stringify(this.state), "utf8")
      renameSync(tmp, STATE_PATH)
    } catch (error) {
      console.error("[bridge] failed to persist state:", (error as Error).message)
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.persist()
  }

  addApproval(permission: Permission & { directory: string }) {
    const id = `${permission.directory}::${permission.sessionID}::${permission.id}`
    this.state.approvals[id] = { ...permission, receivedAt: Date.now() }
    this.session(permission.directory, permission.sessionID).updatedAt = Date.now()
    this.schedulePersist()
  }

  removeApproval(directory: string, sessionID: string, permissionID: string) {
    delete this.state.approvals[`${directory}::${sessionID}::${permissionID}`]
    this.session(directory, sessionID).updatedAt = Date.now()
    this.schedulePersist()
  }

  approvals(): ApprovalRecord[] {
    return Object.values(this.state.approvals).sort((a, b) => a.receivedAt - b.receivedAt)
  }

  approvalsFor(directory?: string): ApprovalRecord[] {
    const all = this.approvals()
    return directory ? all.filter((approval) => approval.directory === directory) : all
  }

  approvalCount(directory: string, sessionID: string) {
    return this.approvals().filter((a) => a.directory === directory && a.sessionID === sessionID).length
  }

  session(directory: string, sessionID: string): SessionMemory {
    const id = key(directory, sessionID)
    let existing = this.state.sessions[id]
    if (!existing) {
      existing = { lastText: "", lastTextAt: 0, createdAt: Date.now(), updatedAt: Date.now() }
      this.state.sessions[id] = existing
    }
    return existing
  }

  sessionMemory(directory: string, sessionID: string): SessionMemory | undefined {
    return this.state.sessions[key(directory, sessionID)]
  }

  setStatus(directory: string, sessionID: string, status: SessionStatus) {
    const memory = this.session(directory, sessionID)
    memory.status = status
    memory.updatedAt = Date.now()
    this.schedulePersist()
  }

  setText(directory: string, sessionID: string, text: string) {
    const memory = this.session(directory, sessionID)
    memory.lastText = text
    memory.lastTextAt = Date.now()
    memory.updatedAt = Date.now()
    this.schedulePersist()
  }

  setTool(directory: string, sessionID: string, tool: string, title: string | undefined, status: string) {
    const memory = this.session(directory, sessionID)
    memory.lastTool = { tool, title, status, at: Date.now() }
    memory.updatedAt = Date.now()
    this.schedulePersist()
  }

  setError(directory: string, sessionID: string, error: string | undefined) {
    const memory = this.session(directory, sessionID)
    memory.error = error
    memory.updatedAt = Date.now()
    this.schedulePersist()
  }

  markIdleNotified(directory: string, sessionID: string) {
    this.session(directory, sessionID).idleNotifiedAt = Date.now()
    this.schedulePersist()
  }
}