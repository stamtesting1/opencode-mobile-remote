import Constants from "expo-constants"
import * as SecureStore from "expo-secure-store"

export type StoredMachine = {
  machineId: string
  deviceId: string
  deviceSecret: string
  relayUrl: string
  name: string
  addedAt: number
}

export type Credentials = StoredMachine

const keys = {
  machines: "machines_v2",
  active: "active_machine_v2",
  // v1 keys, read once so upgrading the app does not lose an existing pairing.
  legacy: {
    relayUrl: "relay_url",
    machineId: "machine_id",
    deviceId: "device_id",
    deviceSecret: "device_secret",
    deviceName: "device_name",
  },
}

const MAX_MACHINES = 12

/**
 * The relay URL can be baked in at build time (extra.relayUrl in app.json) so most
 * people never have to type it, but it stays editable per machine in Settings.
 */
export function buildTimeRelayUrl() {
  const extra = Constants.expoConfig?.extra as { relayUrl?: string } | undefined
  return extra?.relayUrl?.trim() ?? ""
}

function valid(machine: unknown): machine is StoredMachine {
  if (!machine || typeof machine !== "object") return false
  const candidate = machine as Partial<StoredMachine>
  return (
    typeof candidate.machineId === "string" &&
    candidate.machineId.length > 0 &&
    typeof candidate.deviceId === "string" &&
    candidate.deviceId.length > 0 &&
    typeof candidate.deviceSecret === "string" &&
    candidate.deviceSecret.length > 0 &&
    typeof candidate.relayUrl === "string" &&
    candidate.relayUrl.length > 0
  )
}

export async function loadMachines(): Promise<StoredMachine[]> {
  const raw = await SecureStore.getItemAsync(keys.machines)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter(valid)
    } catch {
      /* fall through to the migration below */
    }
  }
  return migrateLegacy()
}

/** An app update should never cost the user their existing pairing. */
async function migrateLegacy(): Promise<StoredMachine[]> {
  const [relayUrl, machineId, deviceId, deviceSecret, name] = await Promise.all([
    SecureStore.getItemAsync(keys.legacy.relayUrl),
    SecureStore.getItemAsync(keys.legacy.machineId),
    SecureStore.getItemAsync(keys.legacy.deviceId),
    SecureStore.getItemAsync(keys.legacy.deviceSecret),
    SecureStore.getItemAsync(keys.legacy.deviceName),
  ])

  const machine: StoredMachine | null =
    machineId && deviceId && deviceSecret
      ? {
          machineId,
          deviceId,
          deviceSecret,
          relayUrl: (relayUrl || buildTimeRelayUrl()).replace(/\/+$/, ""),
          name: name || "laptop",
          addedAt: Date.now(),
        }
      : null

  if (!machine) return []
  await persistMachines([machine])
  await setActiveMachineId(machine.machineId)
  return [machine]
}

export async function persistMachines(machines: StoredMachine[]) {
  const trimmed = machines.slice(0, MAX_MACHINES)
  await SecureStore.setItemAsync(keys.machines, JSON.stringify(trimmed))
}

export async function getActiveMachineId() {
  return SecureStore.getItemAsync(keys.active)
}

export async function setActiveMachineId(machineId: string | null) {
  if (machineId) await SecureStore.setItemAsync(keys.active, machineId)
  else await SecureStore.deleteItemAsync(keys.active)
}

export async function clearAllMachines() {
  await Promise.all([
    SecureStore.deleteItemAsync(keys.machines),
    SecureStore.deleteItemAsync(keys.active),
    ...Object.values(keys.legacy).map((key) => SecureStore.deleteItemAsync(key)),
  ])
}

export function randomHex(bytes = 24) {
  const buffer = new Uint8Array(bytes)
  for (let index = 0; index < bytes; index += 1) {
    buffer[index] = Math.floor(Math.random() * 256)
  }
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export function websocketUrl(relayUrl: string, machineId: string) {
  const base = relayUrl.replace(/^http/, "ws")
  return `${base}/v1/stream?machine=${encodeURIComponent(machineId)}`
}

/** What to show in the machine list when we only have an opaque id. */
export function machineLabel(machine: StoredMachine) {
  const trimmed = machine.name?.trim()
  if (trimmed) return trimmed
  return machine.machineId.length > 10 ? `machine ${machine.machineId.slice(0, 6)}` : machine.machineId
}