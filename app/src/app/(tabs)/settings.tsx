import Constants from "expo-constants"
import { useEffect, useState } from "react"
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import * as Device from "expo-device"

import { Button, Card, Muted, Screen } from "../../components/ui"
import { buildTimeRelayUrl } from "../../lib/credentials"
import { relativeTime, theme } from "../../lib/format"
import { registerForPush } from "../../lib/notifications"
import { useStore } from "../../lib/store"

export default function SettingsScreen() {
  const { credentials, machine, relayStatus, streamConnected, unpair, setRelayUrl, refreshApprovals } = useStore()
  const [relayDraft, setRelayDraft] = useState(() => credentials?.relayUrl ?? buildTimeRelayUrl())
  const [pushState, setPushState] = useState<"unknown" | "on" | "off">("unknown")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // In Expo Go (and on emulators) remote push is unavailable, so probe instead of assuming.
    registerForPush()
      .then((token) => setPushState(token ? "on" : "off"))
      .catch(() => setPushState("off"))
  }, [])

  const saveRelay = async () => {
    setBusy(true)
    try {
      await setRelayUrl(relayDraft.trim())
      Alert.alert("Saved", "Relay URL updated. Restart the app if pairing still fails.")
    } catch (error) {
      Alert.alert("Could not save", (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmUnpair = () => {
    Alert.alert("Unpair this phone?", "You will need a fresh pairing code to reconnect.", [
      { text: "Cancel", style: "cancel" },
      { text: "Unpair", style: "destructive", onPress: () => void unpair() },
    ])
  }

  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? "not configured"

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <Card>
          <Text style={styles.label}>Connection</Text>
          <Row label="Phone stream" value={streamConnected ? "connected" : "reconnecting…"} good={streamConnected} />
          <Row
            label="Bridge"
            value={relayStatus?.agentOnline ? "online" : "offline"}
            good={Boolean(relayStatus?.agentOnline)}
          />
          <Row label="Machine" value={machine?.name ?? credentials?.machineId ?? "unknown"} />
          <Row label="opencode" value={machine?.opencodeHealthy ? `healthy ${machine.opencodeVersion ?? ""}` : "unreachable"} good={Boolean(machine?.opencodeHealthy)} />
          <Row label="Bridge seen" value={relativeTime(relayStatus?.lastSeenAt) || "never"} />
        </Card>

        <Card>
          <Text style={styles.label}>Push notifications</Text>
          <Row
            label="Status"
            value={
              pushState === "on"
                ? "ready"
                : pushState === "off"
                  ? "not available in this build"
                  : "checking…"
            }
            good={pushState === "on"}
          />
          {pushState !== "on" ? (
            <Text style={styles.note}>
              Remote push needs a development build on a physical device (Expo Go cannot receive it). Everything else
              works in Expo Go over the live connection.
            </Text>
          ) : null}
          <Row label="EAS project" value={projectId} />
        </Card>

        <Card>
          <Text style={styles.label}>Relay</Text>
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
            <Button label="Save" onPress={saveRelay} disabled={busy || !relayDraft.trim()} small />
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

        <Card style={styles.dangerCard}>
          <Text style={styles.label}>Pairing</Text>
          <Muted>Machine id: {credentials?.machineId ?? "unknown"}</Muted>
          <View style={styles.actions}>
            <Button label="Unpair this phone" tone="danger" onPress={confirmUnpair} small />
          </View>
        </Card>

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
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginBottom: 16 },
  label: { color: theme.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
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
  dangerCard: { borderColor: "#4a2626" },
})