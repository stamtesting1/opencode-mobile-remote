import type { PendingApproval, PermissionResponse, SessionStatus } from "@opencode-mobile/protocol"
import { StyleSheet, Text, View, Pressable } from "react-native"
import type { ReactNode } from "react"

import { relativeTime, theme } from "../lib/format"

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>
}

export function StatusPill({ status }: { status: SessionStatus }) {
  const label =
    status.type === "busy"
      ? "working"
      : status.type === "retry"
        ? `retry ${status.attempt}`
        : "idle"
  const tone =
    status.type === "busy"
      ? { backgroundColor: theme.accentMuted, color: theme.accent }
      : status.type === "retry"
        ? { backgroundColor: theme.warningMuted, color: theme.warning }
        : { backgroundColor: theme.surfaceAlt, color: theme.textMuted }
  return (
    <View style={[styles.pill, { backgroundColor: tone.backgroundColor }]}>
      <Text style={[styles.pillText, { color: tone.color }]}>{label}</Text>
    </View>
  )
}

export function Button({
  label,
  onPress,
  tone = "neutral",
  disabled,
  small,
}: {
  label: string
  onPress: () => void
  tone?: "neutral" | "approve" | "danger" | "ghost"
  disabled?: boolean
  small?: boolean
}) {
  const palette = {
    approve: { backgroundColor: theme.accent, color: "#05240f", borderColor: theme.accent },
    danger: { backgroundColor: theme.danger, color: "#2a0c0c", borderColor: theme.danger },
    neutral: { backgroundColor: theme.surfaceAlt, color: theme.text, borderColor: theme.border },
    ghost: { backgroundColor: "transparent", color: theme.textMuted, borderColor: theme.border },
  }[tone]

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: palette.backgroundColor, borderColor: palette.borderColor },
        (disabled || pressed) && { opacity: disabled ? 0.4 : 0.75 },
      ]}
    >
      <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: palette.color }]}>{label}</Text>
    </Pressable>
  )
}

/** The main event: one permission request, with the three answers opencode accepts. */
export function ApprovalCard({
  approval,
  onResolve,
  busy,
}: {
  approval: PendingApproval
  onResolve: (response: PermissionResponse) => void
  busy?: boolean
}) {
  const detail = approvalDetail(approval)
  return (
    <Card style={styles.approvalCard}>
      <View style={styles.rowBetween}>
        <Text style={styles.approvalType}>{approval.type}</Text>
        <Text style={styles.mutedSmall}>{relativeTime(approval.time?.created)}</Text>
      </View>
      <Text style={styles.approvalTitle}>{approval.title}</Text>
      <View style={styles.detailBox}>
        <Text style={styles.detailText}>{detail}</Text>
      </View>
      <View style={styles.actions}>
        <Button label="Allow once" tone="approve" onPress={() => onResolve("once")} disabled={busy} />
        <Button label="Always" onPress={() => onResolve("always")} disabled={busy} />
        <Button label="Reject" tone="danger" onPress={() => onResolve("reject")} disabled={busy} />
      </View>
    </Card>
  )
}

function approvalDetail(approval: PendingApproval) {
  const metadata = (approval.metadata ?? {}) as Record<string, unknown>
  const candidates = [metadata.command, metadata.filePath, metadata.path, metadata.url, metadata.description]
  const match = candidates.find((value) => typeof value === "string" && value.length)
  return typeof match === "string" ? match : JSON.stringify(metadata, null, 2).slice(0, 400)
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
    marginBottom: 12,
  },
  approvalCard: { borderColor: "#4a3a12", backgroundColor: "#181509" },
  muted: { color: theme.textMuted, fontSize: 13 },
  mutedSmall: { color: theme.textMuted, fontSize: 11 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: "600" },
  button: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
  },
  buttonSmall: { paddingVertical: 6, flex: 0 },
  buttonText: { fontWeight: "600", fontSize: 14 },
  buttonTextSmall: { fontSize: 12 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  approvalType: { color: theme.warning, fontWeight: "700", fontSize: 11, letterSpacing: 1 },
  approvalTitle: { color: theme.text, fontSize: 15, fontWeight: "600", marginTop: 4 },
  detailBox: {
    backgroundColor: "#0d1014",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 10,
    marginTop: 10,
  },
  detailText: { color: "#cbd5df", fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
  empty: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { color: theme.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
  emptySubtitle: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 19,
  },
})