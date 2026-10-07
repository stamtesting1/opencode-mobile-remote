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
  getActiveMachineId,
  loadMachines,
  machineLabel,
  persistMachines,
  randomHex,
  setActiveMachineId,
  type StoredMachine,
} from "./credentials"
import { registerForPush, syncApprovalBadge, watchPushTokenRotations } from "./notifications"

type Store = {
  ready: boolean
  machines: StoredMachine[]
  activeMachineId: string | null
  /** The machine currently in view, for code that only cares about one. */
  credentials: StoredMachine | null
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
  pair: (input: { machineId: string; code: string; relayUrl?: string; name?: string }) => Promise<StoredMachine>
  switchMachine: (machineId: string) => Promise<void>
  renameMachine: (machineId: string, name: string) => Promise<void>
  setRelayUrl: (machineId: string, url: string) => Promise<void>
  removeMachine: (machineId: string) => Promise<void>
  rpc: <T>(method: Parameters<RelayApi["rpc"]>[0], params?: Record<string, unknown>) => Promise<T>
}

const StoreContext = createContext<Store | null>(null)

export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useStore must be used inside <StoreProvider>")
  return store
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<StoredMachine[]>([])
  const [activeMachineId, setActive] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [streamConnected, setStreamConnected] = useState(false)
  const [machine, setMachine] = useState<MachineInfo | null>(null)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [revision, setRevision] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)

  const credentials = useMemo(
    () => machines.find((entry) => entry.machineId === activeMachineId) ?? null,
    [machines, activeMachineId],
  )
  const api = useMemo(() => (credentials ? new RelayApi(credentials) : null), [credentials])

  const bump = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    loadMachines()
      .then(async (loaded) => {
        setMachines(loaded)
        const storedActive = await getActiveMachineId()
        const active = loaded.find((entry) => entry.machineId === storedActive) ?? loaded[0]
        setActive(active?.machineId ?? null)
      })
      .catch((error) => setLastError((error as Error).message))
      .finally(() => setReady(true))
  }, [])

  /** Switching machines must not leave another laptop's data on screen. */
  const clearMachineData = useCallback(() => {
    setApprovals([])
    setSessions([])
    setMachine(null)
    setRelayStatus(null)
    setStreamConnected(false)
    setLastError(null)
  }, [])

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
    async (input: { machineId: string; code: string; relayUrl?: string; name?: string }) => {
      const relayUrl = (input.relayUrl || buildTimeRelayUrl()).replace(/\/+$/, "")
      if (!relayUrl) throw new Error("enter your relay URL, or set extra.relayUrl in app.json when building")
      const draft: StoredMachine = {
        relayUrl,
        machineId: input.machineId.trim(),
        deviceId: randomHex(16),
        deviceSecret: randomHex(32),
        name: input.name?.trim() || "",
        addedAt: Date.now(),
      }

      const probe = new RelayApi(draft)
      const result = await probe.pair({
        relayUrl: draft.relayUrl,
        machineId: draft.machineId,
        code: input.code,
        deviceId: draft.deviceId,
        deviceSecret: draft.deviceSecret,
        deviceName: "android-phone",
      })

      const stored: StoredMachine = {
        ...draft,
        name: draft.name || result.machineName || machineLabel(draft),
      }

      const next = [...machines.filter((entry) => entry.machineId !== stored.machineId), stored]
      await persistMachines(next)
      await setActiveMachineId(stored.machineId)
      clearMachineData()
      setMachines(next)
      setActive(stored.machineId)
      setLastError(null)
      return stored
    },
    [clearMachineData, machines],
  )

  const switchMachine = useCallback(
    async (machineId: string) => {
      if (machineId === activeMachineId) return
      clearMachineData()
      await setActiveMachineId(machineId)
      setActive(machineId)
    },
    [activeMachineId, clearMachineData],
  )

  const renameMachine = useCallback(
    async (machineId: string, name: string) => {
      const next = machines.map((entry) => (entry.machineId === machineId ? { ...entry, name: name.trim() } : entry))
      await persistMachines(next)
      setMachines(next)
    },
    [machines],
  )

  const setRelayUrl = useCallback(
    async (machineId: string, url: string) => {
      const clean = url.replace(/\/+$/, "")
      const next = machines.map((entry) => (entry.machineId === machineId ? { ...entry, relayUrl: clean } : entry))
      await persistMachines(next)
      setMachines(next)
    },
    [machines],
  )

  const resolveApproval = useCallback(
    async (approval: PendingApproval, response: PermissionResponse) => {
      const client = api
      if (!client) throw new Error("this phone is not paired yet")
      // Drop it locally straight away so the card disappears even if the relay is slow.
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

  const removeMachine = useCallback(
    async (machineId: string) => {
      const target = machines.find((entry) => entry.machineId === machineId)
      if (target) {
        await new RelayApi(target).unpair().catch(() => undefined)
      }
      const next = machines.filter((entry) => entry.machineId !== machineId)
      await persistMachines(next)
      setMachines(next)
      if (activeMachineId === machineId) {
        const fallback = next[0]?.machineId ?? null
        clearMachineData()
        await setActiveMachineId(fallback)
        setActive(fallback)
      }
    },
    [activeMachineId, clearMachineData, machines],
  )

  const value = useMemo<Store>(
    () => ({
      ready,
      machines,
      activeMachineId,
      credentials,
      api,
      paired: machines.length > 0,
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
      switchMachine,
      renameMachine,
      setRelayUrl,
      removeMachine,
      rpc,
    }),
    [
      ready,
      machines,
      activeMachineId,
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
      switchMachine,
      renameMachine,
      setRelayUrl,
      removeMachine,
      rpc,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}