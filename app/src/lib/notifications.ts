import type { Notify } from "@opencode-mobile/protocol"
import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import { Platform } from "react-native"

const APPROVALS_CHANNEL = "approvals"
const UPDATES_CHANNEL = "updates"

export function configureNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  })
}

/**
 * Registers for push and returns the Expo token.
 *
 * Android needs a development build (Expo Go cannot receive remote push since SDK 53),
 * so every failure path degrades to "no push" instead of throwing: the app still works
 * over its live websocket while it is open.
 */
export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(APPROVALS_CHANNEL, {
      name: "Approvals",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#ffb020",
      sound: "default",
    })
    await Notifications.setNotificationChannelAsync(UPDATES_CHANNEL, {
      name: "Progress",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: "#3ba55d",
    })
  }

  if (!Device.isDevice) return null

  const existing = await Notifications.getPermissionsAsync()
  let status = existing.status
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status
  }
  if (status !== "granted") return null

  try {
    const token = await Notifications.getExpoPushTokenAsync()
    return token.data
  } catch (error) {
    console.warn("could not get expo push token:", (error as Error).message)
    return null
  }
}

export function watchPushTokenRotations(handler: (token: string) => void) {
  const subscription = Notifications.addPushTokenListener((token) => handler(token.data))
  return () => subscription.remove()
}

export function watchNotificationResponses(handler: (data: Record<string, unknown>) => void) {
  const handle = (response: Notifications.NotificationResponse) => {
    const data = response.notification.request.content.data as Record<string, unknown>
    handler(data)
  }
  const subscription = Notifications.addNotificationResponseReceivedListener(handle)
  return () => subscription.remove()
}

export function lastNotificationData(): Record<string, unknown> | null {
  const response = Notifications.getLastNotificationResponse()
  if (!response?.notification) return null
  return response.notification.request.content.data as Record<string, unknown>
}

/** Keep the OS tray in sync with how many approvals are waiting. */
export async function syncApprovalBadge(count: number) {
  try {
    await Notifications.setBadgeCountAsync(count)
  } catch {
    /* many Android launchers do not support badges */
  }
}

export function notifyFromPushData(data: Record<string, unknown>): Notify | null {
  const kind = typeof data.kind === "string" ? data.kind : null
  if (!kind) return null
  return {
    kind: kind as Notify["kind"],
    title: typeof data.title === "string" ? data.title : "opencode",
    body: typeof data.body === "string" ? data.body : "",
    sessionID: typeof data.sessionID === "string" ? data.sessionID : undefined,
    permissionID: typeof data.permissionID === "string" ? data.permissionID : undefined,
    directory: typeof data.directory === "string" ? data.directory : undefined,
    at: typeof data.at === "number" ? data.at : Date.now(),
  }
}

