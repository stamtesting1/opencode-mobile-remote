import { useState } from "react"
import { router } from "expo-router"
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from "react-native"

import { Button, Card, Screen } from "../components/ui"
import { buildTimeRelayUrl } from "../lib/credentials"
import { theme } from "../lib/format"
import { useStore } from "../lib/store"

export default function PairScreen() {
  const { pair } = useStore()
  const defaultRelay = buildTimeRelayUrl()
  const [relayUrl, setRelayUrl] = useState(defaultRelay)
  const [machineId, setMachineId] = useState("")
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await pair({ machineId, code, relayUrl, name })
      router.replace("/(tabs)")
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Pair with a laptop</Text>
          <Text style={styles.subtitle}>
            On the machine running the bridge, the terminal prints a machine id and a pairing code. Type them in
            here. Pair as many laptops as you like, then switch between them in Settings.
          </Text>

          <Card>
            <Text style={styles.label}>Machine id</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setMachineId}
              placeholder="from the bridge terminal"
              placeholderTextColor={theme.textMuted}
              style={styles.input}
              value={machineId}
            />

            <Text style={[styles.label, styles.spaced]}>Pairing code</Text>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={setCode}
              placeholder="XXXX-XXXX"
              placeholderTextColor={theme.textMuted}
              style={[styles.input, styles.codeInput]}
              value={code}
            />

            <Text style={[styles.label, styles.spaced]}>Name (optional)</Text>
            <TextInput
              autoCapitalize="none"
              onChangeText={setName}
              placeholder="work laptop, home desktop…"
              placeholderTextColor={theme.textMuted}
              style={styles.input}
              value={name}
            />

            <Text style={[styles.label, styles.spaced]}>Relay URL</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRelayUrl}
              placeholder="https://your-worker.workers.dev"
              placeholderTextColor={theme.textMuted}
              style={styles.input}
              value={relayUrl}
            />
          </Card>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button
            label={busy ? "Pairing…" : "Pair this phone"}
            onPress={submit}
            tone="approve"
            disabled={busy || !machineId.trim() || !code.trim() || !relayUrl.trim()}
          />

          <Text style={styles.help}>
            Codes rotate every 15 minutes. A code can only be used once. If the code has expired, read the newest
            one from the bridge terminal, or restart the bridge.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, paddingBottom: 48 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700" },
  subtitle: { color: theme.textMuted, fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 20 },
  label: { color: theme.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  spaced: { marginTop: 16 },
  input: {
    backgroundColor: "#0d1014",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    color: theme.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
    fontSize: 14,
  },
  codeInput: { fontSize: 20, letterSpacing: 4, textAlign: "center" },
  error: { color: theme.danger, fontSize: 13, marginBottom: 12 },
  help: { color: theme.textMuted, fontSize: 12, lineHeight: 18, marginTop: 16 },
  helpDim: { color: theme.textMuted, fontSize: 11, marginTop: 8, opacity: 0.7 },
})