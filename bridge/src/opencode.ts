import type {
  ChatMessage,
  FileDiff,
  MessagePart,
  OpencodeEvent,
  Permission,
  PermissionResponse,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-mobile/protocol"

type Query = Record<string, string | number | undefined>

export class OpencodeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = "OpencodeError"
  }
}

export class OpencodeClient {
  private authHeader: string | null = null

  constructor(
    private baseUrl: string,
    auth?: { username: string; password: string },
  ) {
    if (auth) this.authHeader = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  get url() {
    return this.baseUrl
  }

  private buildUrl(path: string, query?: Query) {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  async request<T>(path: string, options: { method?: string; query?: Query; body?: unknown; signal?: AbortSignal } = {}) {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.authHeader) headers.authorization = this.authHeader
    let body: string | undefined
    if (options.body !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(options.body)
    }

    const response = await fetch(this.buildUrl(path, options.query), {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: options.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new OpencodeError(
        `opencode ${options.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 400)}`,
        response.status,
        text,
      )
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  health() {
    return this.request<{ healthy: boolean; version?: string }>("/global/health")
  }

  projects(directory?: string) {
    return this.request<{ id: string; worktree: string }[]>("/project", { query: { directory } })
  }

  agents() {
    return this.request<{ name: string; description?: string; mode?: string }[]>("/agent")
  }

  async models() {
    const result = await this.request<{ providers: { id: string; models: Record<string, unknown> }[] }>(
      "/config/providers",
    )
    const out: { providerID: string; modelID: string }[] = []
    for (const provider of result.providers ?? []) {
      for (const modelID of Object.keys(provider.models ?? {})) {
        out.push({ providerID: provider.id, modelID })
      }
    }
    return out
  }

  sessions(directory?: string) {
    return this.request<Session[]>("/session", { query: { directory } })
  }

  status(directory?: string) {
    return this.request<Record<string, SessionStatus>>("/session/status", { query: { directory } })
  }

  messages(directory: string, sessionID: string, limit?: number) {
    return this.request<{ info: ChatMessage; parts: MessagePart[] }[]>("/session/" + encodeURIComponent(sessionID) + "/message", {
      query: { directory, limit },
    })
  }

  todos(directory: string, sessionID: string) {
    return this.request<Todo[]>("/session/" + encodeURIComponent(sessionID) + "/todo", { query: { directory } })
  }

  diff(directory: string, sessionID: string) {
    return this.request<FileDiff[]>("/session/" + encodeURIComponent(sessionID) + "/diff", { query: { directory } })
  }

  createSession(directory: string, title?: string) {
    return this.request<Session>("/session", { method: "POST", query: { directory }, body: { title } })
  }

  async prompt(
    directory: string,
    sessionID: string,
    text: string,
    options: { messageID: string; agent?: string; model?: string },
  ) {
    const body: Record<string, unknown> = {
      messageID: options.messageID,
      parts: [{ type: "text", text }],
    }
    if (options.agent) body.agent = options.agent
    if (options.model) {
      const [providerID, ...rest] = options.model.split("/")
      if (providerID && rest.length) body.model = { providerID, modelID: rest.join("/") }
    }
    await this.request<void>("/session/" + encodeURIComponent(sessionID) + "/prompt_async", {
      method: "POST",
      query: { directory },
      body,
    })
  }

  abort(directory: string, sessionID: string) {
    return this.request<boolean>("/session/" + encodeURIComponent(sessionID) + "/abort", {
      method: "POST",
      query: { directory },
    })
  }

  rename(directory: string, sessionID: string, title: string) {
    // opencode answers with the updated session; the caller only cares that it worked.
    return this.request<unknown>("/session/" + encodeURIComponent(sessionID), {
      method: "PATCH",
      query: { directory },
      body: { title },
    }).then((result) => Boolean(result))
  }

  respondPermission(directory: string, sessionID: string, permissionID: string, response: PermissionResponse) {
    return this.request<boolean>(
      "/session/" + encodeURIComponent(sessionID) + "/permissions/" + encodeURIComponent(permissionID),
      { method: "POST", query: { directory }, body: { response } },
    )
  }

  /**
   * Subscribes to the global event stream (every directory served by this instance).
   * Yields normalised events with the originating `directory` attached.
   */
  async *events(signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
    const response = await fetch(this.buildUrl("/global/event"), {
      headers: this.authHeader ? { authorization: this.authHeader, accept: "text/event-stream" } : { accept: "text/event-stream" },
      signal,
    })
    if (!response.ok || !response.body) {
      throw new OpencodeError(`opencode event stream failed (${response.status})`, response.status, "")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseChunk(chunk)
          if (parsed) yield parsed
          boundary = buffer.indexOf("\n\n")
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }
}

function parseSseChunk(chunk: string): OpencodeEvent | null {
  const dataLines: string[] = []
  for (const line of chunk.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  const raw = dataLines.join("\n")
  if (!raw || raw === "[DONE]") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null

  const record = parsed as { type?: string; properties?: unknown; directory?: string; payload?: unknown }
  if (record.payload && typeof record.payload === "object") {
    const inner = record.payload as { type?: string; properties?: unknown }
    if (typeof inner.type === "string") {
      return { type: inner.type, properties: (inner.properties ?? {}) as Record<string, unknown>, directory: record.directory }
    }
  }
  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: (record.properties ?? {}) as Record<string, unknown>,
      directory: record.directory,
    }
  }
  return null
}