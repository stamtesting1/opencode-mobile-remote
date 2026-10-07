import { Stack, useRouter } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"

import { theme } from "../lib/format"
import { configureNotificationHandler, lastNotificationData, watchNotificationResponses } from "../lib/notifications"
import { StoreProvider } from "../lib/store"

configureNotificationHandler()

export default function RootLayout() {
  const router = useRouter()

  useEffect(() => {
    const route = (data: Record<string, unknown> | null) => {
      if (!data) return
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : null
      const directory = typeof data.directory === "string" ? data.directory : null
      if (sessionID && directory) {
        router.push({ pathname: "/session/[id]", params: { id: sessionID, directory } })
      } else {
        router.push("/")
      }
    }

    route(lastNotificationData())

    return watchNotificationResponses(route)
  }, [router])

  return (
    <StoreProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.text,
          headerTitleStyle: { color: theme.text, fontSize: 16 },
          contentStyle: { backgroundColor: theme.background },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Pair with your laptop" }} />
        <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </StoreProvider>
  )
}