import type { PermissionResponse } from "@opencode-mobile/protocol"
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useCallback, useState } from "react"

import { ApprovalCard, Card, EmptyState, Screen } from "../../components/ui"
import { theme } from "../../lib/format"
import { useStore } from "../../lib/store"

export default function ApprovalsScreen() {
  const { approvals, resolveApproval, refreshApprovals, lastError, relayStatus, machine } = useStore()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([refreshApprovals()])
    setRefreshing(false)
  }, [refreshApprovals])

  const resolve = useCallback(
    async (permissionID: string, sessionID: string, response: PermissionResponse) => {
      const approval = approvals.find((entry) => entry.id === permissionID && entry.sessionID === sessionID)
      if (!approval) return
      setBusyId(permissionID)
      try {
        await resolveApproval(approval, response)
      } catch (error) {
        alert((error as Error).message)
        await refreshApprovals()
      } finally {
        setBusyId(null)
      }
    },
    [approvals, refreshApprovals, resolveApproval],
  )

  const bridgeOffline = relayStatus ? !relayStatus.agentOnline : false

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={theme.textMuted} />}
      >
        <View style={styles.headerRow}>
          <Text style={styles.count}>
            {approvals.length === 0 ? "nothing waiting" : `${approvals.length} waiting on you`}
          </Text>
          {machine ? <Text style={styles.machine}>{machine.name}</Text> : null}
        </View>

        {bridgeOffline ? (
          <Card style={styles.offlineCard}>
            <Text style={styles.offlineTitle}>The bridge is offline</Text>
            <Text style={styles.offlineBody}>
              Start it on your laptop, otherwise approvals cannot be answered from here.
            </Text>
          </Card>
        ) : null}

        {lastError ? <Text style={styles.error}>{lastError}</Text> : null}

{approvals.length === 0 ? (
          <EmptyState
            title="No approvals waiting"
            subtitle="When opencode asks to run a command or edit a file, it lands here and you get a notification."
          />
        ) : (
          approvals.map((approval) => (
            <ApprovalCard
              key={`${approval.sessionID}:${approval.id}`}
              approval={approval}
              busy={busyId === approval.id}
              onResolve={(response) => resolve(approval.id, approval.sessionID, response)}
            />
          ))
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 },
  count: { color: theme.text, fontSize: 20, fontWeight: "700" },
  machine: { color: theme.textMuted, fontSize: 12 },
  offlineCard: { borderColor: theme.warning, backgroundColor: theme.warningMuted },
  offlineTitle: { color: theme.warning, fontWeight: "700", fontSize: 14 },
  offlineBody: { color: theme.text, fontSize: 13, marginTop: 6, lineHeight: 18 },
error: { color: theme.danger, fontSize: 13, marginBottom: 12 },
})

