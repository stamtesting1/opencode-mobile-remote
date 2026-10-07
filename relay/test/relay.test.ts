import { env, runInDurableObject, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import type { Env } from "../src/machine"

type Machine = ReturnType<Env["MACHINES"]["getByName"]>

type MachineInternals = {
  setMeta(key: string, value: string): void
  hashSecret(secret: string): Promise<string>
  onNotify(notify: {
    kind: string
    title: string
    body: string
    sessionID?: string
    permissionID?: string
    directory?: string
    at: number
  }): Promise<void>
}

async function inMachine<T>(stub: Machine, callback: (instance: MachineInternals) => Promise<T> | T) {
  return runInDurableObject(stub, (instance) => callback(instance as unknown as MachineInternals))
}

async function seedPairingCode(stub: Machine, code: string, ttlMs = 60_000) {
  await inMachine(stub, async (machine) => {
    machine.setMeta("pairing_code", code.replace(/-/g, "").toUpperCase())
    machine.setMeta("pairing_expires_at", String(Date.now() + ttlMs))
    machine.setMeta("machine_name", "test-laptop")
  })
}

const json = (data: unknown, init: RequestInit = {}) =>
  new Request("https://relay.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    ...init,
  })

async function pair(machine: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://relay.test/v1/pair?machine=${machine}`, json(body))
}

async function deviceFetch(machine: string, deviceSecret: string, path: string, body: unknown) {
  return SELF.fetch(
    `https://relay.test${path}?machine=${machine}`,
    json(body, { headers: { "content-type": "application/json", authorization: `Bearer ${deviceSecret}` } }),
  )
}

function getStub(machine: string): Machine {
  return env.MACHINES.getByName(machine)
}

describe("relay worker", () => {
  it("describes itself", async () => {
    const response = await SELF.fetch("https://relay.test/")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { service: string; ok: boolean }
    expect(body.service).toBe("opencode-mobile-relay")
    expect(body.ok).toBe(true)
  })

  it("rejects malformed machine ids", async () => {
    const response = await SELF.fetch("https://relay.test/v1/status?machine=../../etc/passwd")
    expect(response.status).toBe(400)
  })

  it("demands a websocket upgrade for the device stream", async () => {
    const response = await SELF.fetch("https://relay.test/v1/stream?machine=machine-stream")
    expect(response.status).toBe(426)
  })

  it("rejects an unauthenticated device stream", async () => {
    const stub = getStub("machine-stream-auth")
    const response = await stub.fetch(
      new Request("https://relay.internal/stream?machine=machine-stream-auth", {
        headers: { upgrade: "websocket" },
      }),
    )
    expect(response.status).toBe(401)
  })

  it("claims a machine on first connect, then refuses any other secret", async () => {
    const stub = getStub("machine-claim")
    await stub.fetch(
      new Request("https://relay.internal/link?machine=machine-claim", {
        headers: { upgrade: "websocket", authorization: "Bearer the-first-secret" },
      }),
    )

    const impostor = await stub.fetch(
      new Request("https://relay.internal/link?machine=machine-claim", {
        headers: { upgrade: "websocket", authorization: "Bearer a-different-secret" },
      }),
    )
    expect(impostor.status).toBe(401)
  })
})

describe("pairing", () => {
  it("requires the pairing fields", async () => {
    const response = await pair("machine-fields", { code: "ABCD-EFGH" })
    expect(response.status).toBe(400)
  })

  it("rejects a code that was never published", async () => {
    const response = await pair("machine-nocode", {
      code: "ABCD-EFGH",
      deviceId: "device-1",
      deviceSecret: "secret-1",
    })
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toMatch(/invalid or expired pairing code/i)
  })

  it("rejects an expired code", async () => {
    const stub = getStub("machine-expired")
    await seedPairingCode(stub, "OLDC0DE1", -1000)
    const response = await pair("machine-expired", {
      code: "OLDC0DE1",
      deviceId: "device-1",
      deviceSecret: "secret-1",
    })
    expect(response.status).toBe(401)
  })

  it("pairs a phone, then retires the code", async () => {
    const stub = getStub("machine-happy")
    await seedPairingCode(stub, "HAPPY-COD3")

    const paired = await pair("machine-happy", {
      code: "HAPPY-COD3",
      deviceId: "device-a",
      deviceSecret: "secret-a",
      deviceName: "pixel",
      platform: "android",
    })
    expect(paired.status).toBe(200)
    const body = (await paired.json()) as { ok: boolean; machineName: string }
    expect(body.ok).toBe(true)
    expect(body.machineName).toBe("test-laptop")

    // The code is single use.
    const replay = await pair("machine-happy", {
      code: "HAPPY-COD3",
      deviceId: "device-b",
      deviceSecret: "secret-b",
    })
    expect(replay.status).toBe(401)

    // The already paired device can refresh without a code.
    const again = await pair("machine-happy", { deviceId: "device-a", deviceSecret: "secret-a" })
    expect(again.status).toBe(200)
  })

  it("locks out after repeated wrong codes", async () => {
    const stub = getStub("machine-lockout")
    await seedPairingCode(stub, "GOOD-CODE")

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await pair("machine-lockout", {
        code: "BAD-CODE",
        deviceId: `device-${attempt}`,
        deviceSecret: `secret-${attempt}`,
      })
      expect(response.status).toBe(401)
    }

    const blocked = await pair("machine-lockout", {
      code: "GOOD-CODE",
      deviceId: "device-good",
      deviceSecret: "secret-good",
    })
    expect(blocked.status).toBe(401)
    expect(((await blocked.json()) as { error: string }).error).toMatch(/too many pairing attempts/i)
  })
})

describe("authorised device operations", () => {
  const machine = "machine-device"

  beforeEach(async () => {
    const stub = getStub(machine)
    await seedPairingCode(stub, "DEVICE-01")
    await pair(machine, { code: "DEVICE-01", deviceId: "device-a", deviceSecret: "secret-a" })
  })

  it("registers a push token and reports it in status", async () => {
    const response = await deviceFetch(machine, "secret-a", "/v1/push", { pushToken: "ExponentPushToken[abc]" })
    expect(response.status).toBe(200)

    const status = await SELF.fetch(`https://relay.test/v1/status?machine=${machine}`, {
      headers: { authorization: "Bearer secret-a" },
    })
    const body = (await status.json()) as { pushDevices: number; agentOnline: boolean; phonesConnected: number }
    expect(body.pushDevices).toBe(1)
    expect(body.agentOnline).toBe(false)
    expect(body.phonesConnected).toBe(0)
  })

  it("rejects a wrong device secret", async () => {
    const response = await SELF.fetch(`https://relay.test/v1/status?machine=${machine}`, {
      headers: { authorization: "Bearer not-the-secret" },
    })
    expect(response.status).toBe(401)
  })

  it("refuses to forward rpc calls while the bridge is offline", async () => {
    const response = await deviceFetch(machine, "secret-a", "/v1/rpc", { method: "sessions.list", params: {} })
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/bridge is offline/i)
  })

  it("keeps notifications for a phone that was offline and pushes them", async () => {
    const stub = getStub(machine)

    const pushBodies: Record<string, unknown>[] = []
    await inMachine(stub, async (machineInternals) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        pushBodies.push(body)
        return new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }), {
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch
      try {
        await machineInternals.onNotify({
          kind: "approval",
          title: "Approval needed",
          body: "bash: npm test",
          sessionID: "ses_1",
          permissionID: "per_1",
          directory: "C:/code/project",
          at: Date.now(),
        })
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    expect(pushBodies).toHaveLength(1)
    const [message] = pushBodies[0] as {
      to: string
      title: string
      body: string
      channelId: string
      data: Record<string, unknown>
    }[]
    expect(message?.to).toBe("ExponentPushToken[abc]")
    expect(message?.title).toBe("Approval needed")
    expect(message?.body).toBe("bash: npm test")
    expect(message?.channelId).toBe("approvals")
    expect(message?.data.kind).toBe("approval")
    expect(message?.data.sessionID).toBe("ses_1")

    const inbox = await SELF.fetch(`https://relay.test/v1/inbox?machine=${machine}`, {
      headers: { authorization: "Bearer secret-a" },
    })
    const notifications = ((await inbox.json()) as { notifications: { title: string }[] }).notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toBe("Approval needed")
  })

  it("drops push tokens that Expo reports as unregistered", async () => {
    const stub = getStub(machine)
    await inMachine(stub, async (machineInternals) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: [{ status: "error", message: "DeviceNotRegistered" }] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch
      try {
        await machineInternals.onNotify({ kind: "idle", title: "Task finished", body: "done", at: Date.now() })
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    const status = await SELF.fetch(`https://relay.test/v1/status?machine=${machine}`, {
      headers: { authorization: "Bearer secret-a" },
    })
    expect(((await status.json()) as { pushDevices: number }).pushDevices).toBe(0)
  })

  it("revokes the device on unpair", async () => {
    const response = await deviceFetch(machine, "secret-a", "/v1/unpair", {})
    expect(response.status).toBe(200)

    const afterwards = await SELF.fetch(`https://relay.test/v1/status?machine=${machine}`, {
      headers: { authorization: "Bearer secret-a" },
    })
    expect(afterwards.status).toBe(401)
  })
})