export type PermissionResponse = "once" | "always" | "reject"

export type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }

export type Permission = {
  id: string
  type: string
  pattern?: string | string[]
  sessionID: string
  messageID: string
  callID?: string
  title: string
  metadata: Record<string, unknown>
  time: { created: number }
}

export type PendingApproval = Permission & { directory: string }

export type Todo = {
  id: string
  content: string
  status: string
  priority: string
}

export type FileDiff = {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
}

export type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw?: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; time: { start: number } }
  | { status: "completed"; input: Record<string, unknown>; title?: string; output: string; time: { start: number; end: number } }
  | { status: "error"; input: Record<string, unknown>; title?: string; error: string; time: { start: number; end: number } }

export type MessagePart =
  | { id: string; type: "text"; text: string; time?: { start: number; end?: number } }
  | { id: string; type: "reasoning"; text: string; time?: { start: number; end?: number } }
  | {
      id: string
      type: "tool"
      callID: string
      tool: string
      state: ToolState
    }
  | { id: string; type: "step-start"; snapshot?: string }
  | { id: string; type: "step-finish" }
  | { id: string; type: "subtask"; prompt: string; description: string; agent: string }
  | { id: string; type: "file"; mime: string; filename?: string; url: string }
  | { id: string; type: "patch"; files: string[] }
  | { id: string; type: "agent"; name: string }
  | { id: string; type: "retry"; attempt: number }
  | { id: string; type: "compaction" }

export type ChatMessage = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  error?: { name: string; data?: { message?: string } }
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
  parts: MessagePart[]
}

export type Session = {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number }
  summary?: { additions: number; deletions: number; files: number }
}

export type SessionSummary = {
  id: string
  title: string
  directory: string
  projectID: string
  parentID?: string
  time: { created: number; updated: number }
  status: SessionStatus
  approvalCount: number
  changeCount: number
  additions: number
  deletions: number
  lastText: string
  error?: string
}

export type MachineInfo = {
  machineId: string
  name: string
  opencodeHealthy: boolean
  opencodeVersion?: string
  bridgeVersion: string
  bridgeStartedAt: number
  directories: string[]
}

export type SessionDetail = {
  session: Session
  messages: ChatMessage[]
  todos: Todo[]
  approvals: PendingApproval[]
  diffs: FileDiff[]
  status: SessionStatus
  cost: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  error?: string
}

export type RpcParams = {
  "machine.info": Record<string, never>
  "projects.list": Record<string, never>
  "sessions.list": { directory?: string; limit?: number }
  "session.get": { id: string; directory: string }
  "session.prompt": { id: string; directory: string; text: string; agent?: string; model?: string }
  "session.create": { directory: string; text: string; title?: string; agent?: string; model?: string }
  "session.abort": { id: string; directory: string }
  "session.rename": { id: string; directory: string; title: string }
  "session.diff": { id: string; directory: string }
  approvals: { directory?: string }
  "approvals.resolve": { sessionID: string; permissionID: string; directory: string; response: PermissionResponse }
  "agents.list": Record<string, never>
  "models.list": Record<string, never>
}

export type RpcMethod = keyof RpcParams

export type RpcResultMap = {
  "machine.info": MachineInfo
  "projects.list": { id: string; worktree: string }[]
  "sessions.list": SessionSummary[]
  "session.get": SessionDetail
  "session.prompt": { messageID: string }
  "session.create": { sessionID: string }
  "session.abort": boolean
  "session.rename": boolean
  "session.diff": FileDiff[]
  approvals: PendingApproval[]
  "approvals.resolve": boolean
  "agents.list": { name: string; description?: string; mode?: string }[]
  "models.list": { providerID: string; modelID: string }[]
}

export type RpcRequest = {
  kind: "rpc"
  id: string
  method: RpcMethod
  params: unknown
}

export type RpcResponse = {
  kind: "rpc.result" | "rpc.error"
  id: string
  result?: unknown
  error?: { message: string; code?: string }
}

export type NotifyKind = "approval" | "idle" | "error" | "info"

export type Notify = {
  kind: NotifyKind
  title: string
  body: string
  sessionID?: string
  permissionID?: string
  directory?: string
  at: number
}

export type BridgeMessage =
  | RpcRequest
  | RpcResponse
  | { kind: "notify"; notify: Notify }
  | { kind: "event"; event: OpencodeEvent }
  | { kind: "hello"; machineId: string; machineSecret: string; agent: string }
  | { kind: "ping" }
  | { kind: "pong" }

export type OpencodeEvent = { type: string; properties: Record<string, unknown> } & { directory?: string }

export type RelayToClient =
  | RpcResponse
  | { kind: "event"; event: OpencodeEvent }
  | { kind: "notify"; notify: Notify }
  | { kind: "paired"; deviceId: string }
  | { kind: "hello" }
  | { kind: "pong" }