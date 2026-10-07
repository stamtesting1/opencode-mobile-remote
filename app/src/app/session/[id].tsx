import type { ChatMessage, PermissionResponse, SessionDetail } from "@opencode-mobile/protocol"
import { Stack, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"

import { ApprovalCard, Button, Card, Muted, StatusPill } from "../../components/ui"
import { formatCost, formatTokens, relativeTime, shortPath, theme, unifiedDiffLines } from "../../lib/format"
import { useStore } from "../../lib/store"

type Tab = "conversation" | "plan" | "changes"

export default function SessionScreen() {
  const params = useLocalSearchParams<{ id: string; directory: string }>()
  const { rpc, revision, resolveApproval } = useStore()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [tab, setTab] = useState<Tab>("conversation")
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<ScrollView>(null)

  const id = typeof params.id === "string" ? params.id : ""
  const directory = typeof params.directory === "string" ? params.directory : ""

  const load = useCallback(async () => {
    if (!id || !directory) return
    try {
      const result = await rpc<SessionDetail>("session.get", { id, directory })
      setDetail(result)
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }, [id, directory, rpc])

  useEffect(() => {
    // Fetch on mount and whenever a live event arrives: this is async state, not a
    // synchronous derivation, so it belongs in an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, revision])

  const send = async () => {
    if (!draft.trim() || sending) return
    setSending(true)
    try {
      await rpc("session.prompt", { id, directory, text: draft.trim() })
      setDraft("")
      await load()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setSending(false)
    }
  }

  const abort = async () => {
    try {
      await rpc("session.abort", { id, directory })
      await load()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  const approve = async (permissionId: string, sessionID: string, response: PermissionResponse) => {
    const approval = detail?.approvals.find((entry) => entry.id === permissionId)
    if (!approval) return
    try {
      await resolveApproval(approval, response)
      await load()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  if (!detail) {
    return (
      <View style={styles.loading}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={theme.accent} />}
      </View>
    )
  }

  const doneTodos = detail.todos.filter((todo) => todo.status === "completed").length

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: detail.session.title || "Session" }} />

      <View style={styles.header}>
        <View style={styles.headerTop}>
          <StatusPill status={detail.status} />
          <Muted>{shortPath(detail.session.directory)}</Muted>
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {detail.session.title || "Untitled session"}
        </Text>
        <Text style={styles.stats}>
          {formatCost(detail.cost)} · {formatTokens(detail.tokens.input)} in / {formatTokens(detail.tokens.output)} out
          {detail.diffs.length ? ` · ${detail.diffs.length} files changed` : ""}
          {detail.todos.length ? ` · ${doneTodos}/${detail.todos.length} done` : ""}
        </Text>
        {detail.error ? <Text style={styles.error}>{detail.error}</Text> : null}
      </View>

      <View style={styles.tabs}>
        {(["conversation", "plan", "changes"] as Tab[]).map((name) => (
          <Pressable key={name} onPress={() => setTab(name)} style={[styles.tab, tab === name && styles.tabActive]}>
            <Text style={[styles.tabText, tab === name && styles.tabTextActive]}>{name}</Text>
          </Pressable>
        ))}
        {detail.status.type === "busy" ? (
          <Pressable onPress={abort} style={styles.abort}>
            <Text style={styles.abortText}>abort</Text>
          </Pressable>
        ) : null}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          ref={scrollRef}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {detail.approvals.length > 0 ? (
            <>
              <Text style={styles.sectionLabel}>needs your approval</Text>
              {detail.approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onResolve={(response) => approve(approval.id, approval.sessionID, response)}
                />
              ))}
            </>
          ) : null}

          {tab === "conversation" ? <Conversation messages={detail.messages} /> : null}

          {tab === "plan"
            ? detail.todos.length === 0
              ? <Muted>No plan yet.</Muted>
              : detail.todos.map((todo) => (
                  <Card key={todo.id}>
                    <Text style={styles.todoText}>
                      {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○"} {todo.content}
                    </Text>
                  </Card>
                ))
            : null}

          {tab === "changes"
            ? detail.diffs.length === 0
              ? <Muted>No file changes in this session.</Muted>
              : detail.diffs.map((file) => <DiffCard key={file.file} file={file} />)
            : null}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            multiline
            onChangeText={setDraft}
            placeholder="Reply to opencode…"
            placeholderTextColor={theme.textMuted}
            style={styles.composerInput}
            value={draft}
          />
          <Button label={sending ? "…" : "Send"} onPress={send} disabled={sending || !draft.trim()} small />
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

function Conversation({ messages }: { messages: ChatMessage[] }) {
  if (!messages.length) return <Muted>No messages yet.</Muted>
  return (
    <>
      {messages.map((message) => (
        <Card key={message.id} style={message.role === "user" ? styles.userCard : undefined}>
          <View style={styles.messageHeader}>
            <Text style={styles.role}>{message.role === "user" ? "you" : message.modelID ?? "assistant"}</Text>
            <Text style={styles.time}>{relativeTime(message.time?.created)}</Text>
          </View>
          {message.parts?.map((part) => (
            <Part key={part.id} part={part} />
          ))}
          {message.error ? <Text style={styles.error}>{message.error.name}</Text> : null}
        </Card>
      ))}
    </>
  )
}

function Part({ part }: { part: ChatMessage["parts"][number] }) {
  if (part.type === "text") {
    return part.text ? <Text style={styles.text}>{part.text}</Text> : null
  }
  if (part.type === "reasoning") {
    return part.text ? (
      <Text style={styles.reasoning} numberOfLines={6}>
        {part.text}
      </Text>
    ) : null
  }
  if (part.type === "tool") {
    const state = part.state
    const label =
      state?.status === "running"
        ? "running"
        : state?.status === "completed"
          ? "done"
          : state?.status === "error"
            ? "failed"
            : "queued"
    return (
      <View style={styles.tool}>
        <Text style={styles.toolName}>
          {part.tool} <Text style={styles.toolState}>[{label}]</Text>
        </Text>
        {"title" in state && state.title ? (
          <Text style={styles.toolTitle} numberOfLines={2}>
            {state.title}
          </Text>
        ) : null}
      </View>
    )
  }
  if (part.type === "subtask") {
    return (
      <View style={styles.tool}>
        <Text style={styles.toolName}>subtask · {part.agent}</Text>
        <Text style={styles.toolTitle} numberOfLines={2}>
          {part.description || part.prompt}
        </Text>
      </View>
    )
  }
  if (part.type === "patch") {
    return <Text style={styles.toolTitle}>patched {part.files?.length ?? 0} files</Text>
  }
  if (part.type === "retry") {
    return <Text style={styles.toolTitle}>retrying (attempt {part.attempt})</Text>
  }
  return null
}

function DiffCard({ file }: { file: { file: string; before: string; after: string; additions: number; deletions: number } }) {
  const lines = unifiedDiffLines(file).slice(0, 400)
  return (
    <Card>
      <View style={styles.diffHeader}>
        <Text style={styles.diffName} numberOfLines={1}>
          {file.file}
        </Text>
        <Text style={styles.diffCounts}>
          <Text style={{ color: theme.accent }}>+{file.additions}</Text>{" "}
          <Text style={{ color: theme.danger }}>-{file.deletions}</Text>
        </Text>
      </View>
      <View style={styles.diffBody}>
        {lines.map((line, index) => (
          <Text
            key={index}
            style={[
              styles.diffLine,
              line.kind === "add" && styles.diffAdd,
              line.kind === "del" && styles.diffDel,
            ]}
          >
            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            {line.text}
          </Text>
        ))}
      </View>
    </Card>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1 },
  loading: { flex: 1, backgroundColor: theme.background, alignItems: "center", justifyContent: "center", padding: 24 },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  headerTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { color: theme.text, fontSize: 18, fontWeight: "700", lineHeight: 24 },
  stats: { color: theme.textMuted, fontSize: 12, marginTop: 6 },
  tabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  tab: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  tabActive: { backgroundColor: theme.surfaceAlt },
  tabText: { color: theme.textMuted, fontSize: 13, textTransform: "capitalize" },
  tabTextActive: { color: theme.text, fontWeight: "600" },
  abort: { marginLeft: "auto" },
  abortText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
  content: { padding: 16, paddingBottom: 24 },
  sectionLabel: {
    color: theme.warning,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  userCard: { backgroundColor: "#111722" },
  messageHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  role: { color: theme.textMuted, fontSize: 11, fontWeight: "600" },
  time: { color: theme.textMuted, fontSize: 11 },
  text: { color: theme.text, fontSize: 14, lineHeight: 20 },
  reasoning: { color: theme.textMuted, fontSize: 12, lineHeight: 17, fontStyle: "italic" },
  tool: {
    backgroundColor: "#0d1014",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 8,
    marginTop: 6,
  },
  toolName: { color: theme.info, fontSize: 12, fontWeight: "600" },
  toolState: { color: theme.textMuted, fontWeight: "400" },
  toolTitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  todoText: { color: theme.text, fontSize: 14, lineHeight: 20 },
  diffHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  diffName: { color: theme.text, fontSize: 13, fontWeight: "600", flex: 1 },
  diffCounts: { fontSize: 12 },
  diffBody: {
    marginTop: 10,
    backgroundColor: "#0a0c0f",
    borderRadius: 8,
    padding: 8,
    maxHeight: 320,
  },
  diffLine: { color: theme.textMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
  diffAdd: { color: "#7bd88f" },
  diffDel: { color: "#ff9d9d" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
  },
  composerInput: {
    flex: 1,
    color: theme.text,
    backgroundColor: "#0d1014",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxHeight: 120,
    fontSize: 14,
  },
  error: { color: theme.danger, fontSize: 12, marginTop: 8 },
})