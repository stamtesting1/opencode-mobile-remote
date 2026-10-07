export const theme = {
  background: "#0b0d10",
  surface: "#14181d",
  surfaceAlt: "#1c2229",
  border: "#262d36",
  text: "#e8edf3",
  textMuted: "#8b98a5",
  accent: "#3ba55d",
  accentMuted: "#1f3d2b",
  warning: "#ffb020",
  warningMuted: "#3a2c10",
  danger: "#ef5f5f",
  dangerMuted: "#3a1c1c",
  info: "#4c9aff",
} as const

export function relativeTime(timestamp?: number) {
  if (!timestamp) return ""
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatCost(cost?: number) {
  if (!cost) return "$0.00"
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

export function shortPath(directory: string) {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join("/") || directory
}

export function formatTokens(count?: number) {
  if (!count) return "0"
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * opencode returns a plain before/after text pair per file. Turn that into the
 * familiar +/- view without shipping a full diff engine.
 */
export function unifiedDiffLines(file: { before: string; after: string }) {
  const beforeLines = file.before ? file.before.split("\n") : []
  const afterLines = file.after ? file.after.split("\n") : []
  const lines: { kind: "add" | "del" | "ctx"; text: string }[] = []

  let beforeIndex = 0
  let afterIndex = 0
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    const beforeLine = beforeLines[beforeIndex]
    const afterLine = afterLines[afterIndex]
    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) lines.push({ kind: "ctx", text: beforeLine })
      beforeIndex += 1
      afterIndex += 1
      continue
    }
    if (beforeLine !== undefined) {
      lines.push({ kind: "del", text: beforeLine })
      beforeIndex += 1
      continue
    }
    if (afterLine !== undefined) {
      lines.push({ kind: "add", text: afterLine })
      afterIndex += 1
    }
  }
  return lines
}