/**
 * Expo push delivery.
 *
 * The relay holds every device token, so it can also clean up tokens that Expo tells
 * us are dead (app uninstalled, reinstalled, project changed).
 */

const PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"
const RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts"

export type ExpoPushMessage = {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound?: "default" | null
  priority?: "default" | "high"
  channelId?: string
  badge?: number
}

export type PushTicket = { token: string; id: string | null; ok: boolean; message?: string }

export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<PushTicket[]> {
  if (!messages.length) return []

  const response = await fetch(PUSH_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(messages),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`expo push failed (${response.status}): ${text.slice(0, 300)}`)
  }

  const body = (await response.json()) as {
    data?: ({ status: string; id?: string; message?: string; details?: { error?: string } } | { error: string })[]
  }

  return messages.map((message, index) => {
    const entry = body.data?.[index]
    if (!entry || "error" in entry) {
      const failure = entry && "error" in entry ? entry.error : "unknown push error"
      return { token: message.to, id: null, ok: false, message: failure }
    }
    if (entry.status === "ok" && entry.id) {
      return { token: message.to, id: entry.id, ok: true }
    }
    return {
      token: message.to,
      id: null,
      ok: false,
      message: entry.message ?? entry.details?.error ?? "rejected",
    }
  })
}

/** Second-leg check: turns "accepted" tickets into delivery errors. */
export async function fetchPushReceipts(ids: string[]): Promise<Map<string, { ok: boolean; message?: string }>> {
  const results = new Map<string, { ok: boolean; message?: string }>()
  if (!ids.length) return results

  const response = await fetch(RECEIPTS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ids }),
  })
  if (!response.ok) return results

  const body = (await response.json()) as {
    data?: Record<string, { status?: string; message?: string; details?: { error?: string } } | { error: string }>
  }

  for (const [id, entry] of Object.entries(body.data ?? {})) {
    if (!entry || "error" in entry) {
      results.set(id, { ok: false, message: "receipt error" })
    } else if (entry.status === "ok") {
      results.set(id, { ok: true })
    } else {
      results.set(id, { ok: false, message: entry.details?.error ?? entry.message ?? "not delivered" })
    }
  }
  return results
}