import { Machine, type Env } from "./machine"

export { Machine }

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

type PairBody = {
  machine?: string
  code?: string
  deviceId?: string
  deviceSecret?: string
  deviceName?: string
  platform?: string
}

type RpcBody = { machine?: string; method?: string; params?: unknown }

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function bearer(request: Request) {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    try {
      return await route(request, env, url)
    } catch (error) {
      const message = error instanceof Error ? error.message : "unexpected error"
      const clientError =
        /unauthorised|unauthorized|invalid machine secret|pairing|device token|too many|offline|did not answer/i.test(message)
      // Client mistakes are expected traffic, not incidents: only log real faults.
      if (!clientError) console.error("relay request failed", url.pathname, message)
      return json({ error: clientError ? message : "relay error" }, clientError ? 401 : 500)
    }
  },
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/" || url.pathname === "/health") {
    return json({
      service: "opencode-mobile-relay",
      ok: true,
      endpoints: ["/v1/pair", "/v1/rpc", "/v1/push", "/v1/unpair", "/v1/stream", "/v1/link", "/v1/status", "/v1/inbox"],
    })
  }

  const queryMachine = url.searchParams.get("machine")

  // WebSocket upgrades: the machine id travels in the query string.
  if (url.pathname === "/v1/link" || url.pathname === "/v1/stream") {
    if (!queryMachine || !MACHINE_ID_PATTERN.test(queryMachine)) return json({ error: "invalid machine id" }, 400)
    const machine = env.MACHINES.getByName(queryMachine)
    const internal = new Request(`https://relay.internal${url.pathname === "/v1/link" ? "/link" : "/stream"}`, request)
    return machine.fetch(internal)
  }

  if (request.method !== "POST") {
    if (url.pathname === "/v1/status") {
      if (!queryMachine || !MACHINE_ID_PATTERN.test(queryMachine)) return json({ error: "invalid machine id" }, 400)
      return json(await env.MACHINES.getByName(queryMachine).status(bearer(request)))
    }
    if (url.pathname === "/v1/inbox") {
      if (!queryMachine || !MACHINE_ID_PATTERN.test(queryMachine)) return json({ error: "invalid machine id" }, 400)
      return json({ notifications: await env.MACHINES.getByName(queryMachine).inbox(bearer(request)) })
    }
    return json({ error: "method not allowed" }, 405)
  }

  const body = await readJson<PairBody & RpcBody & { pushToken?: string | null }>(request)
  if (!body) return json({ error: "invalid json body" }, 400)

  const machineId = queryMachine ?? body.machine
  if (!machineId || !MACHINE_ID_PATTERN.test(machineId)) return json({ error: "invalid machine id" }, 400)
  const machine = env.MACHINES.getByName(machineId)

  switch (url.pathname) {
    case "/v1/pair": {
      if (!body.deviceId || !body.deviceSecret) {
        return json({ error: "pair requires deviceId and deviceSecret" }, 400)
      }
      return json(await machine.pair(body))
    }

    case "/v1/rpc": {
      const secret = bearer(request)
      if (!secret) return json({ error: "missing device token" }, 401)
      if (!body.method) return json({ error: "missing method" }, 400)
      const result = await machine.callAgent(secret, body.method, body.params ?? {})
      return json({ result })
    }

    case "/v1/push":
      return json(await machine.registerPush(bearer(request), body.pushToken ?? null))

    case "/v1/unpair":
      return json(await machine.revokeDevice(bearer(request)))

    default:
      return json({ error: "not found" }, 404)
  }
}