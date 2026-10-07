import type { Notify, OpencodeEvent, Permission, SessionStatus } from "@opencode-mobile/protocol"
import type { Store } from "./store.js"

export type EventResult = {
  /** true when approval state changed and clients should refresh their approval list */
  approvalsChanged: boolean
  /** a notification worth pushing to the phone, if any */
  notify?: Notify
}

const IDLE_NOTIFY_COOLDOWN_MS = 45_000

/**
 * Folds an opencode event into the store and decides whether the user deserves a
 * push notification. Only three things interrupt: an approval, a finished session
 * and an error.
 */
export class EventProcessor {
  private notifiedPermissions = new Map<string, number>()
  private busy = new Map<string, boolean>()

  constructor(private store: Store) {}

  /** Lets the bridge restore "was working" knowledge after a restart. */
  seedBusy(directory: string, sessionID: string) {
    this.busy.set(`${directory}::${sessionID}`, true)
  }

  process(event: OpencodeEvent): EventResult {
    const properties = (event.properties ?? {}) as Record<string, unknown>
    const directory = typeof event.directory === "string" ? event.directory : ""

    switch (event.type) {
      case "permission.updated":
        return this.onPermissionAsked(properties as unknown as Permission, directory)

      case "permission.replied":
        return this.onPermissionReplied(properties as unknown as { sessionID?: string; permissionID?: string })

      case "session.status":
        return this.onSessionStatus(properties, directory)

      case "session.idle":
        return this.onSessionIdle(properties, directory)

      case "session.error":
        return this.onSessionError(properties, directory)

      case "message.updated":
        return this.onMessageUpdated(properties, directory)

      case "message.part.updated":
        return this.onPartUpdated(properties, directory)

      case "session.deleted":
        return this.onSessionDeleted(properties)

      default:
        return { approvalsChanged: false }
    }
  }

  private onPermissionAsked(permission: Permission, directory: string): EventResult {
    if (!permission?.id || !permission?.sessionID) return { approvalsChanged: false }
    const alreadyKnown = this.store
      .approvals()
      .some((a) => a.id === permission.id && a.sessionID === permission.sessionID)
    if (alreadyKnown) return { approvalsChanged: false }

    this.store.addApproval({ ...permission, directory })
    return { approvalsChanged: true, notify: this.approvalNotify(permission, directory) }
  }

  private onPermissionReplied(replied: { sessionID?: string; permissionID?: string }): EventResult {
    if (!replied.sessionID || !replied.permissionID) return { approvalsChanged: false }
    const matches = this.store
      .approvals()
      .filter((a) => a.sessionID === replied.sessionID && a.id === replied.permissionID)
    for (const match of matches) this.store.removeApproval(match.directory, match.sessionID, match.id)
    return { approvalsChanged: matches.length > 0 }
  }

  private onSessionStatus(properties: Record<string, unknown>, directory: string): EventResult {
    const flat = properties as { sessionID?: string; status?: SessionStatus }
    const nested = (properties as { info?: { sessionID?: string; status?: SessionStatus } }).info
    const sessionID = nested?.sessionID ?? flat.sessionID
    const status = nested?.status ?? flat.status
    if (!sessionID || !status?.type || !directory) return { approvalsChanged: false }

    this.store.setStatus(directory, sessionID, status)
    this.busy.set(`${directory}::${sessionID}`, status.type === "busy")
    return { approvalsChanged: false }
  }

  private onSessionIdle(properties: Record<string, unknown>, directory: string): EventResult {
    const nested = (properties as { info?: { sessionID?: string } }).info
    const sessionID = nested?.sessionID ?? (properties as { sessionID?: string }).sessionID
    if (!sessionID) return { approvalsChanged: false }

    const busyKey = `${directory}::${sessionID}`
    const wasBusy = this.busy.get(busyKey) === true
    if (directory) {
      this.store.setStatus(directory, sessionID, { type: "idle" })
      this.busy.set(busyKey, false)
    }
    if (!directory || !wasBusy) return { approvalsChanged: false }

    const memory = this.store.sessionMemory(directory, sessionID)
    const cooledDown = Date.now() - (memory?.idleNotifiedAt ?? 0) > IDLE_NOTIFY_COOLDOWN_MS
    if (!cooledDown) return { approvalsChanged: false }
    // Something still needs the user, so this is not "done" yet.
    if (this.store.approvalCount(directory, sessionID) > 0) return { approvalsChanged: false }

    this.store.markIdleNotified(directory, sessionID)
    const summary = memory?.lastText ? firstLine(memory.lastText) : "Session is idle"
    return {
      approvalsChanged: false,
      notify: {
        kind: "idle",
        title: "Task finished",
        body: truncate(summary, 180),
        sessionID,
        directory,
        at: Date.now(),
      },
    }
  }

  private onSessionError(properties: Record<string, unknown>, directory: string): EventResult {
    const nested = (properties as { info?: { sessionID?: string; error?: { name?: string; data?: { message?: string } } } })
      .info
    const sessionID = nested?.sessionID ?? (properties as { sessionID?: string }).sessionID
    if (!sessionID) return { approvalsChanged: false }
    const message = nested?.error?.data?.message ?? nested?.error?.name ?? "unknown error"
    if (directory) this.store.setError(directory, sessionID, message)
    return {
      approvalsChanged: false,
      notify: {
        kind: "error",
        title: "opencode hit an error",
        body: truncate(message, 180),
        sessionID,
        directory,
        at: Date.now(),
      },
    }
  }

  private onMessageUpdated(properties: Record<string, unknown>, directory: string): EventResult {
    const info = (properties as { info?: { sessionID?: string; error?: unknown } }).info ??
      (properties as { sessionID?: string; error?: unknown })
    const sessionID = info?.sessionID
    if (!sessionID || !directory) return { approvalsChanged: false }
    if (info.error === undefined && this.store.sessionMemory(directory, sessionID)?.error) {
      this.store.setError(directory, sessionID, undefined)
    }
    return { approvalsChanged: false }
  }

  private onPartUpdated(properties: Record<string, unknown>, directory: string): EventResult {
    const part = (properties as { part?: Record<string, unknown> }).part
    const sessionID = (part?.sessionID as string | undefined) ??
      (properties as { sessionID?: string }).sessionID
    if (!sessionID || !directory) return { approvalsChanged: false }

    if (part?.type === "text") {
      const text = typeof part.text === "string" ? part.text.trim() : ""
      if (text) this.store.setText(directory, sessionID, text)
    } else if (part?.type === "tool" && typeof part.tool === "string") {
      const state = part.state as { status?: string; title?: string } | undefined
      this.store.setTool(directory, sessionID, part.tool, state?.title, state?.status ?? "running")
    }
    return { approvalsChanged: false }
  }

  private onSessionDeleted(properties: Record<string, unknown>): EventResult {
    const info = (properties as { info?: { id?: string } }).info
    const sessionID = info?.id ?? (properties as { sessionID?: string }).sessionID
    if (!sessionID) return { approvalsChanged: false }
for (const approval of this.store.approvals().filter((a) => a.sessionID === sessionID)) {
      this.store.removeApproval(approval.directory, approval.sessionID, approval.id)
      this.busy.delete(`${approval.directory}::${sessionID}`)
    }
    return { approvalsChanged: true }
  }

  private approvalNotify(permission: Permission, directory: string): Notify | undefined {
    const id = `${directory}::${permission.sessionID}::${permission.id}`
    const last = this.notifiedPermissions.get(id) ?? 0
    if (Date.now() - last < 30_000) return undefined
    this.notifiedPermissions.set(id, Date.now())

    return {
      kind: "approval",
      title: "Approval needed",
      body: truncate(approvalDetail(permission), 180),
      sessionID: permission.sessionID,
      permissionID: permission.id,
      directory,
      at: Date.now(),
    }
  }
}

export function approvalDetail(permission: Permission): string {
  const metadata = permission.metadata ?? {}
  const fromMetadata = ["command", "filePath", "path", "url", "query", "description", "pattern"]
    .map((field) => metadata[field])
    .find((value): value is string => typeof value === "string" && value.length > 0)

  return `${permission.type}: ${fromMetadata ?? permission.title ?? "action required"}`
}

function firstLine(text: string) {
  const line = text.split("\n").find((candidate) => candidate.trim().length) ?? text
  return line.trim()
}

function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…"
}