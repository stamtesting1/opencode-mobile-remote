import { Redirect } from "expo-router"
import { ActivityIndicator, StyleSheet, Text, View } from "react-native"

import { theme } from "../lib/format"
import { useStore } from "../lib/store"

export default function Gate() {
  const { ready, paired } = useStore()

  if (!ready) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.label}>starting opencode mobile</Text>
      </View>
    )
  }

  return <Redirect href={paired ? "/(tabs)" : "/pair"} />
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  label: { color: theme.textMuted, fontSize: 13 },
})