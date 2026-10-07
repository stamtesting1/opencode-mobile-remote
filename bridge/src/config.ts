import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type BridgeConfig = {
  version: number
  machineId: string
  machineSecret: string
  machineName: string
  relayUrl: string
  /** When set, the bridge attaches to an already running opencode server instead of spawning one. */
  opencodeUrl: string | null
  /** Working directory for the spawned opencode server. */
  opencodeDir: string
  opencodePort: number
  /** Basic auth credentials, when the opencode server requires them. */
  opencodeUsername?: string
  opencodePassword?: string
}

export const CONFIG_DIR = join(homedir(), ".opencode-mobile")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")
export const STATE_PATH = join(CONFIG_DIR, "state.json")

function randomId(bytes = 16) {
  return randomBytes(bytes).toString("base64url")
}

function defaultMachineName() {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || "laptop"
}

function envString(key: string): string | undefined {
  const value = process.env[key]
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

export function defaultConfig(): BridgeConfig {
  return {
    version: 1,
    machineId: randomId(9),
    machineSecret: randomId(32),
    machineName: defaultMachineName(),
    relayUrl: envString("OPENCODE_BRIDGE_RELAY_URL") ?? "",
    opencodeUrl: envString("OPENCODE_BRIDGE_URL") ?? null,
    opencodeDir: envString("OPENCODE_BRIDGE_DIR") ?? process.cwd(),
    opencodePort: Number(envString("OPENCODE_BRIDGE_PORT") ?? 4599),
  }
}

export function loadConfig(): BridgeConfig {
  let config: BridgeConfig = defaultConfig()
  if (existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<BridgeConfig>
      config = { ...config, ...parsed }
    } catch (error) {
      throw new Error(`Could not parse ${CONFIG_PATH}: ${(error as Error).message}`)
    }
  }

  const overrides: Partial<BridgeConfig> = {}
  const relayUrl = envString("OPENCODE_BRIDGE_RELAY_URL")
  const opencodeUrl = envString("OPENCODE_BRIDGE_URL")
  const opencodeDir = envString("OPENCODE_BRIDGE_DIR")
  const machineName = envString("OPENCODE_BRIDGE_NAME")
  const opencodePort = envString("OPENCODE_BRIDGE_PORT")
  if (relayUrl) overrides.relayUrl = relayUrl
  if (opencodeUrl) overrides.opencodeUrl = opencodeUrl
  if (opencodeDir) overrides.opencodeDir = opencodeDir
  if (machineName) overrides.machineName = machineName
  if (opencodePort) overrides.opencodePort = Number(opencodePort)

  // opencode's own auth env vars, so the bridge works against a secured server.
  const password = envString("OPENCODE_SERVER_PASSWORD") ?? config.opencodePassword
  if (password) {
    overrides.opencodePassword = password
    overrides.opencodeUsername =
      envString("OPENCODE_SERVER_USERNAME") ?? envString("OPENCODE_BRIDGE_USERNAME") ?? config.opencodeUsername ?? "opencode"
  }

  config = { ...config, ...overrides }

  return config
}

export function saveConfig(config: BridgeConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8")
  try {
    chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

export function requireConfig(config: BridgeConfig) {
  if (!config.relayUrl) {
    throw new Error(
      [
        "No relay URL configured.",
        "",
        "Either set OPENCODE_BRIDGE_RELAY_URL=wss://<your-worker>.workers.dev",
        "or add relayUrl to " + CONFIG_PATH,
      ].join("\n"),
    )
  }
  if (!/^wss?:\/\//.test(config.relayUrl)) {
    throw new Error(`relayUrl must start with ws:// or wss:// (got ${config.relayUrl})`)
  }
  return config
}