import { Ionicons } from "@expo/vector-icons"
import { Tabs } from "expo-router"

import { theme } from "../../lib/format"
import { useStore } from "../../lib/store"

export default function TabsLayout() {
  const { approvals } = useStore()

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.background },
        headerTintColor: theme.text,
        headerTitleStyle: { color: theme.text, fontSize: 16 },
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        sceneStyle: { backgroundColor: theme.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Approvals",
          tabBarBadge: approvals.length > 0 ? approvals.length : undefined,
          tabBarBadgeStyle: { backgroundColor: theme.danger },
          tabBarIcon: ({ color, size }) => (
            <Ionicons color={color} size={size} name={approvals.length ? "alert-circle" : "checkmark-circle"} />
          ),
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: "Sessions",
          tabBarIcon: ({ color, size }) => <Ionicons color={color} size={size} name="code-slash" />,
        }}
      />
      <Tabs.Screen
        name="new"
        options={{
          title: "New task",
          tabBarIcon: ({ color, size }) => <Ionicons color={color} size={size} name="add-circle" />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons color={color} size={size} name="settings" />,
        }}
      />
    </Tabs>
  )
}