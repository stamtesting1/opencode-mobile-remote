import { useRouter } from "expo-router"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { useCallback, useState } from "react"

import { Card, EmptyState, Muted, Screen, StatusPill } from "../../components/ui"
import { relativeTime, shortPath, theme } from "../../lib/format"
import { useStore } from "../../lib/store"

export default function SessionsScreen() {
  const { sessions, refreshSessions, revision } = useStore()
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await refreshSessions()
    setRefreshing(false)
  }, [refreshSessions])

  const working = sessions.filter((session) => session.status.type === "busy")
  const rest = sessions.filter((session) => session.status.type !== "busy")

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={theme.textMuted} />}
      >
        <View key={revision}>
          {sessions.length === 0 ? (
            <EmptyState
              title="No sessions yet"
              subtitle="Start opencode on your laptop against the bridge's server, or send a task from the New task tab."
            />
          ) : null}

          {working.length > 0 ? <Text style={styles.section}>Working now</Text> : null}
          {working.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onPress={() =>
                router.push({ pathname: "/session/[id]", params: { id: session.id, directory: session.directory } })
              }
            />
          ))}

          {rest.length > 0 ? <Text style={styles.section}>Recent</Text> : null}
          {rest.slice(0, 40).map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onPress={() =>
                router.push({ pathname: "/session/[id]", params: { id: session.id, directory: session.directory } })
              }
            />
          ))}
        </View>
      </ScrollView>
    </Screen>
  )
}

function SessionRow({
  session,
  onPress,
}: {
  session: import("@opencode-mobile/protocol").SessionSummary
  onPress: () => void
}) {
  const needsYou = session.approvalCount > 0
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && { opacity: 0.75 }]}>
      <Card style={needsYou ? styles.rowAttention : styles.row}>
        <View style={styles.rowTop}>
          <Text style={styles.title} numberOfLines={1}>
            {session.title}
          </Text>
          <StatusPill status={session.status} />
        </View>

        <View style={styles.rowBottom}>
          <Muted>{shortPath(session.directory)}</Muted>
          <Text style={styles.meta}>
            {needsYou ? `${session.approvalCount} to approve` : relativeTime(session.time.updated)}
          </Text>
        </View>

        {session.lastText ? (
          <Text style={styles.lastText} numberOfLines={2}>
            {session.lastText}
          </Text>
        ) : null}

        {session.error ? <Text style={styles.error}>{session.error}</Text> : null}
      </Card>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  section: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
    marginTop: 6,
  },
  row: {},
  rowAttention: { borderColor: theme.warning },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  title: { color: theme.text, fontSize: 15, fontWeight: "600", flex: 1 },
  rowBottom: { flexDirection: "row", justifyContent: "space-between", marginTop: 6, gap: 10 },
  meta: { color: theme.textMuted, fontSize: 11 },
  lastText: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 8 },
  error: { color: theme.danger, fontSize: 12, marginTop: 8 },
})