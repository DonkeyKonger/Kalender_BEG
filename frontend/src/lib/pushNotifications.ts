import { Capacitor } from "@capacitor/core";

import { api } from "./api";
import type { CurrentUser } from "../types/auth";

type PushRegistrationToken = {
  value: string;
};

type PushNotificationAction = {
  notification: {
    data?: Record<string, unknown>;
  };
};

interface PushNotificationsPlugin {
  requestPermissions: () => Promise<{ receive: "granted" | "denied" | "prompt" | "prompt-with-rationale" }>;
  register: () => Promise<void>;
  addListener(
    eventName: "registration",
    listenerFunc: (token: PushRegistrationToken) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "registrationError",
    listenerFunc: (error: unknown) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "pushNotificationActionPerformed",
    listenerFunc: (action: PushNotificationAction) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

let initializedForUserId: number | null = null;
let listenersAttached = false;

export function canUsePushNotifications(): boolean {
  return Capacitor.isNativePlatform();
}

export async function initializePushNotifications(currentUser: CurrentUser): Promise<boolean> {
  if (initializedForUserId === currentUser.id || !Capacitor.isNativePlatform()) {
    return initializedForUserId === currentUser.id;
  }

  const PushNotifications = await loadPushNotificationsPlugin();
  if (!PushNotifications) {
    return false;
  }

  initializedForUserId = currentUser.id;

  if (!listenersAttached) {
    listenersAttached = true;
    await PushNotifications.addListener("registration", (token) => {
      void api.registerPushDevice({
        platform: Capacitor.getPlatform(),
        token: token.value,
      }).catch((error) => {
        console.warn("Push token registration failed", error);
      });
    });
    await PushNotifications.addListener("registrationError", (error) => {
      console.warn("Push registration failed", error);
    });
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      handlePushNotificationAction(action);
    });
  }

  const permissionStatus = await PushNotifications.requestPermissions();
  if (permissionStatus.receive !== "granted") {
    return false;
  }
  await PushNotifications.register();
  return true;
}

async function loadPushNotificationsPlugin(): Promise<PushNotificationsPlugin | null> {
  try {
    const pluginModule = await import("@capacitor/push-notifications");
    return pluginModule.PushNotifications as PushNotificationsPlugin;
  } catch (error) {
    console.warn("Capacitor Push Notifications plugin is not available", error);
    return null;
  }
}

function handlePushNotificationAction(action: PushNotificationAction): void {
  const type = String(action.notification.data?.type ?? "");
  if (type === "plan_update" || type === "measurement_reviewed") {
    window.location.assign("/me/assignments");
    return;
  }
  window.location.assign("/me/assignments");
}
