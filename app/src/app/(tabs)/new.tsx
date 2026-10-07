import { useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"

import { Button, Card, Muted, Screen } from "../../components/ui"
import { shortPath, theme } from "../../lib/format"
import { useStore } from "../../lib/store"

type Project = { id: string; worktree: string }

export default function NewTaskScreen() {
  const { rpc, machine, sessions, revision } = useStore()
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [directory, setDirectory] = useState("")
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!machine) return
    rpc<Project[]>("projects.list", {})
      .then((list) => {
        setProjects(list ?? [])
        setDirectory((current) => current || list?.[0]?.worktree || "")
      })
      .catch(() => setProjects(machine.directories.map((worktree) => ({ id: worktree, worktree }))))
  }, [machine, rpc])

  const recentDirectory = sessions[0]?.directory

  const send = async () => {
    if (!directory || !prompt.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await rpc<{ sessionID: string }>("session.create", {
        directory,
        text: prompt.trim(),
      })
      setPrompt("")
      router.push({ pathname: "/session/[id]", params: { id: result.sessionID, directory } })
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" key={revision}>
          <Text style={styles.title}>Send work to your laptop</Text>
          <Text style={styles.subtitle}>
            This creates a session on the machine running the bridge. You will get a notification when it needs an
            approval and again when it finishes.
          </Text>

          <Card>
            <Text style={styles.label}>Project</Text>
            <View style={styles.chips}>
              {projects.length === 0 ? <Muted>no projects reported yet</Muted> : null}
              {projects.map((project) => {
                const active = project.worktree === directory
                return (
                  <Text
                    key={project.worktree}
                    accessibilityRole="button"
                    onPress={() => setDirectory(project.worktree)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    {shortPath(project.worktree)}
                  </Text>
                )
              })}
            </View>
            {recentDirectory && recentDirectory !== directory ? (
              <Text style={styles.link} onPress={() => setDirectory(recentDirectory)}>
                use most recent: {shortPath(recentDirectory)}
              </Text>
            ) : null}

            <Text style={[styles.label, styles.spaced]}>Task</Text>
            <TextInput
              multiline
              onChangeText={setPrompt}
              placeholder="e.g. run the test suite and fix whatever fails"
              placeholderTextColor={theme.textMuted}
              style={styles.input}
              textAlignVertical="top"
              value={prompt}
            />
          </Card>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button
            label={busy ? "Sending…" : "Start task"}
            onPress={send}
            tone="approve"
            disabled={busy || !prompt.trim() || !directory}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700" },
  subtitle: { color: theme.textMuted, fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 20 },
  label: { color: theme.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  spaced: { marginTop: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  chip: {
    color: theme.text,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 13,
    overflow: "hidden",
  },
  chipActive: { backgroundColor: theme.accentMuted, color: theme.accent },
  link: { color: theme.info, fontSize: 12, marginTop: 10 },
  input: {
    backgroundColor: "#0d1014",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    color: theme.text,
    padding: 12,
    marginTop: 6,
    minHeight: 120,
    fontSize: 14,
  },
  error: { color: theme.danger, fontSize: 13, marginBottom: 12 },
})