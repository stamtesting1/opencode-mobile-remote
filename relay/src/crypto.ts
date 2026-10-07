/** Hashing helpers for the secrets that flow between bridge, phone and relay. */

const encoder = new TextEncoder()

export async function sha256(value: string, salt: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${value}`))
  return toHex(new Uint8Array(digest))
}

export function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export function randomHex(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** Constant-time string comparison so pairing codes cannot be probed byte by byte. */
export function safeEqual(a: string, b: string) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) {
    // Still walk a fixed amount of work to keep timing flat.
    crypto.getRandomValues(new Uint8Array(64))
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

export function normalizeCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "")
}