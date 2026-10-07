/**
 * End to end smoke test: a real opencode server, the real bridge, the real relay
 * running under wrangler dev, and a script standing in for the phone.
 *
 *   node scripts/e2e.mjs
 *
 * Nothing here needs the cloud, an Expo account or a model provider.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { WebSocket } from "ws"

const root = path.resolve(import.meta.dirname, "..")

/** Picks a free port so the test never collides with your real opencode server. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const opencodePort = await freePort()
const relayPort = await freePort()

const home = mkdtempSync(path.join(tmpdir(), "ocm-e2e-home-"))
const project = path.join(home, "demo-project")
mkdirSync(project, { recursive: true })
writeFileSync(path.join(project, "README.md"), "# demo project\n")

const children = []
const outputs = []
let failures = 0

function start(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
  children.push(child)
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  const output = { name, stdout: "", stderr: "" }
  outputs.push(output)
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk
  })
  return { child, output }
}

function dumpOutputs() {
  for (const output of outputs) {
    const tail = (text) => text.trim().split("\n").slice(-12).join("\n")
    if (output.stdout.trim()) console.error(`\n--- ${output.name} stdout ---\n${tail(output.stdout)}`)
    if (output.stderr.trim()) console.error(`\n--- ${output.name} stderr ---\n${tail(output.stderr)}`)
  }
}

function cleanup() {
  for (const child of children.reverse()) {
    if (!child.killed) child.kill()
  }
}

async function waitFor(description, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`timed out waiting for ${description}`)
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`)
  }
}

async function main() {
  console.log("\nopencode mobile end to end test")
  console.log(`  workspace: ${home}\n`)

  // 1. a real opencode server
  const opencodeBin =
    process.env.OPENCODE_BIN ?? (process.platform === "win32" ? "opencode.cmd" : "opencode")
  const opencode = start("opencode", opencodeBin, ["serve", "--port", String(opencodePort), "--hostname", "127.0.0.1"], {
    cwd: project,
    shell: process.platform === "win32",
  })

  const opencodeUrl = `http://127.0.0.1:${opencodePort}`
  // opencode can be started with basic auth; mirror whatever this machine uses so the
  // bridge's credential handling is what gets tested.
  const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD
  const opencodeAuth = opencodePassword
    ? {
        authorization:
          "Basic " +
          Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${opencodePassword}`).toString("base64"),
      }
    : {}

  await waitFor("opencode to become healthy", async () => {
    try {
      const response = await fetch(`${opencodeUrl}/global/health`, { headers: opencodeAuth })
      return response.ok
    } catch {
      return false
    }
  })
  console.log(`  opencode server is healthy${opencodePassword ? " (with basic auth)" : ""}\n`)

  // 2. the relay, running locally through wrangler
  const relay = start("wrangler", process.execPath, [
    path.join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
    "dev",
    "--port",
    String(relayPort),
    "--ip",
    "127.0.0.1",
  ], {
    cwd: path.join(root, "relay"),
  })
  const relayUrl = `http://127.0.0.1:${relayPort}`

  await waitFor(
    "relay to start",
    async () => {
      try {
        const response = await fetch(`${relayUrl}/health`)
        return response.ok
      } catch {
        return false
      }
    },
    120_000,
  )
  console.log("  relay is up\n")

  // 3. the bridge, pointed at both
  const bridge = start("bridge", process.execPath, [path.join(root, "bridge", "dist", "index.js")], {
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      OPENCODE_BRIDGE_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
      OPENCODE_BRIDGE_URL: opencodeUrl,
      OPENCODE_BRIDGE_DIR: project,
      OPENCODE_BRIDGE_NAME: "e2e-laptop",
      OPENCODE_BRIDGE_PORT: String(opencodePort),
    },
  })

  const configPath = path.join(home, ".opencode-mobile", "config.json")
  await waitFor("bridge to write its config", () => existsSync(configPath))
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const machineId = config.machineId

  const pairingCode = await waitFor(
    "bridge to print a pairing code",
    () => /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(bridge.output.stdout)?.[1] ?? false,
    60_000,
  )
  check("bridge prints a pairing code", Boolean(pairingCode), pairingCode)

  // 4. the phone pairs
  const deviceId = "e2e-device"
  const deviceSecret = "e2e-device-secret"
  const paired = await fetch(`${relayUrl}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machine: machineId,
      code: pairingCode,
      deviceId,
      deviceSecret,
      deviceName: "e2e-phone",
      platform: "android",
    }),
  })
  check("phone pairs with the pairing code", paired.ok, `status ${paired.status} ${await cloneText(paired)}`)

  const rpc = async (method, params = {}) => {
    const response = await fetch(`${relayUrl}/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({ machine: machineId, method, params }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(`${method}: ${body.error ?? response.status}`)
    return body.result
  }

  // 5. live event stream from the bridge
  const events = []
  const stream = new WebSocket(`${relayUrl.replace("http", "ws")}/v1/stream?machine=${machineId}`, {
    headers: { authorization: `Bearer ${deviceSecret}` },
  })
  stream.on("message", (raw) => {
    try {
      events.push(JSON.parse(raw.toString()))
    } catch {
      /* ignore keepalives */
    }
  })
  await waitFor("phone stream to open", () => stream.readyState === WebSocket.OPEN, 15_000)

  // 6. machine info comes from the real opencode server
  const info = await rpc("machine.info")
  check("machine.info reports a healthy opencode", info.opencodeHealthy === true, JSON.stringify(info))
  check("machine.info names the machine", info.name === "e2e-laptop", info.name)
  check("machine.info lists the project", (info.directories ?? []).includes(project), JSON.stringify(info.directories))

  // 7. read and write a session through the bridge
  const created = await fetch(`${opencodeUrl}/session?directory=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...opencodeAuth },
    body: JSON.stringify({ title: "e2e session" }),
  })
  const session = await created.json()

  await waitFor(
    "the session to reach the phone as an event",
    () => events.some((event) => event.kind === "event" && event.event?.type === "session.created"),
    15_000,
  )
  check("live session.created event reaches the phone", events.some((event) => event.event?.type === "session.created"))

  const sessions = await rpc("sessions.list", { limit: 10 })
  const listed = sessions.find((entry) => entry.id === session.id)
  check("sessions.list includes the new session", Boolean(listed), JSON.stringify(sessions.map((s) => s.id)))
  check("sessions.list reports the title", listed?.title === "e2e session", listed?.title)
  check("sessions.list defaults to idle", listed?.status?.type === "idle", JSON.stringify(listed?.status))

  const detail = await rpc("session.get", { id: session.id, directory: project })
  check("session.get returns the session", detail.session?.id === session.id)
  check("session.get starts with no approvals", (detail.approvals ?? []).length === 0)

  const renamed = await rpc("session.rename", { id: session.id, directory: project, title: "renamed from the phone" })
  check("session.rename succeeds", renamed === true)
  const afterRename = await rpc("sessions.list", { limit: 10 })
  check(
    "the new title shows up",
    afterRename.find((entry) => entry.id === session.id)?.title === "renamed from the phone",
  )

  // 8. approvals are empty and resolvable-shaped
  const approvals = await rpc("approvals", {})
  check("approvals list starts empty", Array.isArray(approvals) && approvals.length === 0)

  // 9. abort on an idle session is a no-op, not a crash
  const aborted = await rpc("session.abort", { id: session.id, directory: project })
  check("session.abort does not throw", aborted === true || aborted === false, String(aborted))

  // 10. relay status reflects both sides
  const statusResponse = await fetch(`${relayUrl}/v1/status?machine=${machineId}`, {
    headers: { authorization: `Bearer ${deviceSecret}` },
  })
  const status = await statusResponse.json()
  check("relay sees the bridge online", status.agentOnline === true, JSON.stringify(status))
  check("relay sees the phone connected", status.phonesConnected === 1, JSON.stringify(status))

  // 11. a bad device secret is rejected
  const rejected = await fetch(`${relayUrl}/v1/status?machine=${machineId}`, {
    headers: { authorization: "Bearer wrong-secret" },
  })
  check("relay rejects an unknown phone", rejected.status === 401, String(rejected.status))

  stream.close()
  console.log("")
  return failures
}

async function cloneText(response) {
  try {
    return JSON.stringify(await response.clone().json())
  } catch {
    return ""
  }
}

main()
  .then((failures) => {
    cleanup()
    console.log(failures === 0 ? "all checks passed\n" : `${failures} check(s) failed\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error("\ne2e run failed:", error)
    dumpOutputs()
    cleanup()
    process.exit(1)
  })