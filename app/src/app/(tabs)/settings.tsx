import Constants from "expo-constants"
import { useState } from "react"
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useRouter } from "expo-router"
import * as Device from "expo-device"

import { Button, Card, Muted, Screen } from "../../components/ui"
import { machineLabel } from "../../lib/credentials"
import { relativeTime, theme } from "../../lib/format"
import { registerForPush } from "../../lib/notifications"
import { useStore } from "../../lib/store"

export default function SettingsScreen() {
  const {
    credentials,
    machines,
    activeMachineId,
    machine,
    relayStatus,
    streamConnected,
    switchMachine,
    setRelayUrl,
    removeMachine,
    refreshApprovals,
  } = useStore()
  const router = useRouter()
  const [relayDraft, setRelayDraft] = useState(credentials?.relayUrl ?? "")
  const [pushState, setPushState] = useState<"unknown" | "on" | "off">("unknown")
  const [busy, setBusy] = useState(false)

  const probePush = async () => {
    setPushState("unknown")
    const token = await registerForPush()
    setPushState(token ? "on" : "off")
  }

  const saveRelay = async () => {
    if (!credentials) return
    setBusy(true)
    try {
      await setRelayUrl(credentials.machineId, relayDraft.trim())
      Alert.alert("Saved", "Relay URL updated for this machine.")
    } catch (error) {
      Alert.alert("Could not save", (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmRemove = (machineId: string, label: string) => {
    Alert.alert(
      `Remove ${label}?`,
      "This phone will stop talking to that laptop. You can pair it again later with a fresh code.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void removeMachine(machineId) },
      ],
    )
  }

  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? "not configured"

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <Card>
          <View style={styles.cardHeader}>
            <Text style={styles.label}>Machines</Text>
            <Pressable onPress={() => router.push("/pair")}>
              <Text style={styles.add}>+ Add</Text>
            </Pressable>
          </View>

          {machines.length === 0 ? <Muted>No machines paired yet.</Muted> : null}

          {machines.map((entry) => {
            const active = entry.machineId === activeMachineId
            return (
              <Pressable
                key={entry.machineId}
                onPress={() => void switchMachine(entry.machineId)}
                style={[styles.machine, active && styles.machineActive]}
              >
                <View style={styles.flex}>
                  <Text style={styles.machineName}>
                    {machineLabel(entry)}
                    {active ? "  ✓" : ""}
                  </Text>
                  <Text style={styles.machineId}>{entry.machineId}</Text>
                  {active && machine ? (
                    <Text style={styles.machineMeta}>
                      {machine.opencodeHealthy ? `opencode ${machine.opencodeVersion ?? ""}` : "opencode unreachable"}
                    </Text>
                  ) : null}
                </View>
                <Pressable onPress={() => confirmRemove(entry.machineId, machineLabel(entry))} hitSlop={10}>
                  <Text style={styles.remove}>remove</Text>
                </Pressable>
              </Pressable>
            )
          })}

          <Text style={styles.hint}>
            Tap to switch, long-press to rename. Only one machine is shown at a time, so you always know which
            laptop you are approving work on.
          </Text>
        </Card>

        <Card>
          <Text style={styles.label}>Connection</Text>
          <Row label="Phone stream" value={streamConnected ? "connected" : "reconnecting…"} good={streamConnected} />
          <Row
            label="Bridge"
            value={relayStatus?.agentOnline ? "online" : "offline"}
            good={Boolean(relayStatus?.agentOnline)}
          />
          <Row label="Bridge seen" value={relativeTime(relayStatus?.lastSeenAt) || "never"} />
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <Text style={styles.label}>Push notifications</Text>
            <Pressable onPress={() => void probePush()}>
              <Text style={styles.add}>retest</Text>
            </Pressable>
          </View>
          <Row
            label="Status"
            value={
              pushState === "on"
                ? "ready"
                : pushState === "off"
                  ? "not available in this build"
                  : "not tested yet"
            }
            good={pushState === "on"}
          />
          {pushState !== "on" ? (
            <Text style={styles.note}>
              Remote push needs a development build with Firebase credentials; Expo Go cannot receive it.
              Everything else works over the live connection.
            </Text>
          ) : null}
          <Row label="EAS project" value={projectId} />
        </Card>

        {credentials ? (
          <Card>
            <Text style={styles.label}>Relay for {machineLabel(credentials)}</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRelayDraft}
              placeholder="https://your-worker.workers.dev"
              placeholderTextColor={theme.textMuted}
              style={styles.input}
              value={relayDraft}
            />
            <View style={styles.actions}>
              <Button
                label="Save"
                onPress={saveRelay}
                disabled={busy || !relayDraft.trim()}
                small
              />
              <Button label="Refresh" onPress={() => void refreshApprovals()} small />
            </View>
            {machine?.directories?.length ? (
              <>
                <Text style={[styles.label, styles.spaced]}>Known projects</Text>
                {machine.directories.map((directory) => (
                  <Muted key={directory}>{directory}</Muted>
                ))}
              </>
            ) : null}
          </Card>
        ) : null}

        {!Device.isDevice ? <Muted>Running on an emulator: push is disabled.</Muted> : null}
      </ScrollView>
    </Screen>
  )
}

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, good && { color: theme.accent }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  flex: { flex: 1 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginBottom: 16 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: theme.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
  add: { color: theme.accent, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  machine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "transparent",
    marginBottom: 4,
  },
  machineActive: { borderColor: theme.accent, backgroundColor: theme.accentMuted },
  machineName: { color: theme.text, fontSize: 15, fontWeight: "600" },
  machineId: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  machineMeta: { color: theme.textMuted, fontSize: 11, marginTop: 2 },
  remove: { color: theme.danger, fontSize: 12 },
  hint: { color: theme.textMuted, fontSize: 11, lineHeight: 16, marginTop: 8 },
  spaced: { marginTop: 14 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, gap: 12 },
  rowLabel: { color: theme.textMuted, fontSize: 13 },
  rowValue: { color: theme.text, fontSize: 13, flexShrink: 1, textAlign: "right" },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  input: {
    backgroundColor: "#0d1014",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    color: theme.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  actions: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "center" },
})
