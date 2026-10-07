import type {
  MachineInfo,
  Notify,
  OpencodeEvent,
  PendingApproval,
  PermissionResponse,
  SessionSummary,
} from "@opencode-mobile/protocol"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

import { RelayApi, type RelayStatus } from "./api"
import {
  buildTimeRelayUrl,
  clearCredentials,
  loadCredentials,
  randomHex,
  saveCredentials,
  updateRelayUrl,
  type Credentials,
} from "./credentials"
import { registerForPush, syncApprovalBadge, watchPushTokenRotations } from "./notifications"

type Store = {
  ready: boolean
  credentials: Credentials | null
  api: RelayApi | null
  paired: boolean
  streamConnected: boolean
  machine: MachineInfo | null
  relayStatus: RelayStatus | null
  approvals: PendingApproval[]
  sessions: SessionSummary[]
  lastError: string | null
  /** Bumped whenever an opencode event arrives so screens can refetch. */
  revision: number
  refreshApprovals: () => Promise<void>
  refreshSessions: () => Promise<void>
  resolveApproval: (approval: PendingApproval, response: PermissionResponse) => Promise<void>
  pair: (input: { machineId: string; code: string; relayUrl?: string }) => Promise<void>
  setRelayUrl: (url: string) => Promise<void>
  unpair: () => Promise<void>
  rpc: <T>(method: Parameters<RelayApi["rpc"]>[0], params?: Record<string, unknown>) => Promise<T>
}

const StoreContext = createContext<Store | null>(null)

export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useStore must be used inside <StoreProvider>")
  return store
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [ready, setReady] = useState(false)
  const [streamConnected, setStreamConnected] = useState(false)
  const [machine, setMachine] = useState<MachineInfo | null>(null)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [revision, setRevision] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)

  const api = useMemo(() => (credentials ? new RelayApi(credentials) : null), [credentials])

  useEffect(() => {
    loadCredentials()
      .then(setCredentials)
      .catch((error) => setLastError((error as Error).message))
      .finally(() => setReady(true))
  }, [])

  const bump = useCallback(() => setRevision((value) => value + 1), [])

  const refreshApprovals = useCallback(async () => {
    const client = api
    if (!client) return
    try {
      const pending = await client.rpc<PendingApproval[]>("approvals", {})
      setApprovals(Array.isArray(pending) ? pending : [])
      setLastError(null)
    } catch (error) {
      setLastError((error as Error).message)
    }
  }, [api])

  const refreshSessions = useCallback(async () => {
    const client = api
    if (!client) return
    try {
      const list = await client.rpc<SessionSummary[]>("sessions.list", { limit: 60 })
      setSessions(Array.isArray(list) ? list : [])
    } catch (error) {
      setLastError((error as Error).message)
    }
  }, [api])

  const rpc = useCallback(
    async <T,>(method: Parameters<RelayApi["rpc"]>[0], params: Record<string, unknown> = {}) => {
      const client = api
      if (!client) throw new Error("this phone is not paired yet")
      const result = await client.rpc<T>(method, params)
      bump()
      return result
    },
    [api, bump],
  )

  const onEvent = useCallback(
    (event: OpencodeEvent) => {
      const properties = (event.properties ?? {}) as Record<string, unknown>
      switch (event.type) {
        case "permission.updated": {
          const permission = properties as unknown as PendingApproval
          setApprovals((current) =>
            current.some((entry) => entry.id === permission.id && entry.sessionID === permission.sessionID)
              ? current
              : [...current, permission],
          )
          void syncApprovalBadge(1)
          break
        }
        case "permission.replied": {
          const replied = properties as unknown as { sessionID?: string; permissionID?: string }
          setApprovals((current) =>
            current.filter(
              (entry) => !(entry.sessionID === replied.sessionID && entry.id === replied.permissionID),
            ),
          )
          break
        }
        default:
          break
      }
      bump()
    },
    [bump],
  )

  const onNotify = useCallback(
    (notify: Notify) => {
      if (notify.kind === "approval") void syncApprovalBadge(approvals.length + 1)
      bump()
    },
    [approvals.length, bump],
  )

  // Live channel + initial hydration.
  useEffect(() => {
    if (!api) return
    const close = api.openStream({
      onOpen: () => setStreamConnected(true),
      onClose: () => setStreamConnected(false),
      onEvent,
      onNotify,
    })

    const hydrate = async () => {
      try {
        const [info, status] = await Promise.all([
          api.rpc<MachineInfo>("machine.info", {}),
          api.status().catch(() => null),
        ])
        setMachine(info)
        setRelayStatus(status)
        await Promise.all([refreshApprovals(), refreshSessions()])
      } catch (error) {
        setLastError((error as Error).message)
      }
    }
    void hydrate()

    const poll = setInterval(() => {
      void api
        .status()
        .then(setRelayStatus)
        .catch(() => undefined)
    }, 30_000)

    return () => {
      close()
      clearInterval(poll)
    }
  }, [api, onEvent, onNotify, refreshApprovals, refreshSessions])

  // Keep push registration in step with the relay.
  useEffect(() => {
    if (!api) return
    let cancelled = false

    const pushToken = registerForPush()
      .then((token) => {
        if (cancelled) return null
        return api.registerPushToken(token).then(() => token)
      })
      .catch((error) => {
        console.warn("push registration failed:", (error as Error).message)
        return null
      })

    const stopWatching = watchPushTokenRotations((token) => {
      void api.registerPushToken(token).catch(() => undefined)
    })

    return () => {
      cancelled = true
      stopWatching()
      void pushToken
    }
  }, [api])

  useEffect(() => {
    void syncApprovalBadge(approvals.length)
  }, [approvals.length])

  const pair = useCallback(
    async (input: { machineId: string; code: string; relayUrl?: string }) => {
      const relayUrl = (input.relayUrl || buildTimeRelayUrl()).replace(/\/+$/, "")
      if (!relayUrl) throw new Error("set the relay URL first (Settings or build config)")
      const next: Credentials = {
        relayUrl,
        machineId: input.machineId.trim(),
        deviceId: randomHex(16),
        deviceSecret: randomHex(32),
        deviceName: "android-phone",
      }
      const probe = new RelayApi(next)
      await probe.pair({
        relayUrl: next.relayUrl,
        machineId: next.machineId,
        code: input.code,
        deviceId: next.deviceId,
        deviceSecret: next.deviceSecret,
        deviceName: next.deviceName,
      })
      await saveCredentials(next)
      setCredentials(next)
      setLastError(null)
    },
    [],
  )

  const resolveApproval = useCallback(
    async (approval: PendingApproval, response: PermissionResponse) => {
      const client = api
      if (!client) throw new Error("this phone is not paired yet")
      setApprovals((current) =>
        current.filter((entry) => !(entry.id === approval.id && entry.sessionID === approval.sessionID)),
      )
      await client.rpc("approvals.resolve", {
        sessionID: approval.sessionID,
        permissionID: approval.id,
        directory: approval.directory,
        response,
      })
      bump()
    },
    [api, bump],
  )

  const setRelayUrl = useCallback(
    async (url: string) => {
      const clean = url.replace(/\/+$/, "")
      await updateRelayUrl(clean)
      setCredentials((current) => (current ? { ...current, relayUrl: clean } : current))
    },
    [],
  )

  const unpair = useCallback(async () => {
    const client = api
    await client?.unpair().catch(() => undefined)
    await clearCredentials()
    setCredentials(null)
    setApprovals([])
    setSessions([])
    setMachine(null)
    setRelayStatus(null)
  }, [api])

  const value = useMemo<Store>(
    () => ({
      ready,
      credentials,
      api,
      paired: Boolean(credentials),
      streamConnected,
      machine,
      relayStatus,
      approvals,
      sessions,
      lastError,
      revision,
      refreshApprovals,
      refreshSessions,
      resolveApproval,
      pair,
      setRelayUrl,
      unpair,
      rpc,
    }),
    [
      ready,
      credentials,
      api,
      streamConnected,
      machine,
      relayStatus,
      approvals,
      sessions,
      lastError,
      revision,
      refreshApprovals,
      refreshSessions,
      resolveApproval,
      pair,
      setRelayUrl,
      unpair,
      rpc,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}
