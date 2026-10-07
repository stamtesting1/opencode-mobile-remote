import Constants from "expo-constants"
import * as SecureStore from "expo-secure-store"

const keys = {
  relayUrl: "relay_url",
  machineId: "machine_id",
  deviceId: "device_id",
  deviceSecret: "device_secret",
  deviceName: "device_name",
}

export type Credentials = {
  relayUrl: string
  machineId: string
  deviceId: string
  deviceSecret: string
  deviceName: string
}

/**
 * The relay URL can be baked in at build time (extra.relayUrl in app.json) so most
 * people never have to type it, but it stays editable in Settings.
 */
export function buildTimeRelayUrl() {
  const extra = Constants.expoConfig?.extra as { relayUrl?: string } | undefined
  return extra?.relayUrl?.trim() ?? ""
}

export async function loadCredentials(): Promise<Credentials | null> {
  const [relayUrl, machineId, deviceId, deviceSecret, deviceName] = await Promise.all([
    SecureStore.getItemAsync(keys.relayUrl),
    SecureStore.getItemAsync(keys.machineId),
    SecureStore.getItemAsync(keys.deviceId),
    SecureStore.getItemAsync(keys.deviceSecret),
    SecureStore.getItemAsync(keys.deviceName),
  ])
  const relay = (relayUrl || buildTimeRelayUrl()).trim()
  if (!relay || !machineId || !deviceId || !deviceSecret) return null
  return {
    relayUrl: relay.replace(/\/+$/, ""),
    machineId,
    deviceId,
    deviceSecret,
    deviceName: deviceName ?? "phone",
  }
}

export async function saveCredentials(credentials: Credentials) {
  await Promise.all([
    SecureStore.setItemAsync(keys.relayUrl, credentials.relayUrl),
    SecureStore.setItemAsync(keys.machineId, credentials.machineId),
    SecureStore.setItemAsync(keys.deviceId, credentials.deviceId),
    SecureStore.setItemAsync(keys.deviceSecret, credentials.deviceSecret),
    SecureStore.setItemAsync(keys.deviceName, credentials.deviceName),
  ])
}

export async function updateRelayUrl(relayUrl: string) {
  await SecureStore.setItemAsync(keys.relayUrl, relayUrl.replace(/\/+$/, ""))
}

export async function clearCredentials() {
  await Promise.all(Object.values(keys).map((key) => SecureStore.deleteItemAsync(key)))
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