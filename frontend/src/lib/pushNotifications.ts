import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

import { api, getApiBaseUrl } from "./api";
import type { CurrentUser } from "../types/auth";

type PushNotificationAction = {
  notification: {
    data?: Record<string, unknown>;
  };
};

let initializedForUserId: number | null = null;
let listenersAttached = false;
let pushInitStarted = false;

export function canUsePushNotifications(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function initializePushNotifications(currentUser: CurrentUser): Promise<boolean> {
  const platform = Capacitor.getPlatform();
  const isNativePlatform = Capacitor.isNativePlatform();

  if (pushInitStarted) {
    console.info("[Push] init skipped; already started", {
      userId: currentUser.id,
      initializedForUserId,
      platform,
    });
    return initializedForUserId === currentUser.id;
  }

  console.info("[Push] init entered", {
    userId: currentUser.id,
    platform,
    isNativePlatform,
  });

  if (initializedForUserId === currentUser.id) {
    console.info("[Push] init skipped; already initialized for user", {
      userId: currentUser.id,
      platform,
    });
    return true;
  }

  if (!isNativePlatform || platform !== "android") {
    console.info("[Push] init skipped; native Android platform required", {
      platform,
      isNativePlatform,
    });
    return initializedForUserId === currentUser.id;
  }

  console.info("[Push] native platform detected", { platform });
  pushInitStarted = true;

  const pluginMethodsAvailable =
    typeof PushNotifications.addListener === "function" &&
    typeof PushNotifications.checkPermissions === "function" &&
    typeof PushNotifications.requestPermissions === "function" &&
    typeof PushNotifications.register === "function";
  console.info("[Push] PushNotifications plugin available", {
    available: pluginMethodsAvailable,
  });
  if (!pluginMethodsAvailable) {
    return false;
  }

  if (!listenersAttached) {
    console.info("[Push] listener registration started");
    listenersAttached = true;
    await PushNotifications.addListener("registration", (token) => {
      console.info("[Push] registration token received", {
        apiBaseUrl: getApiBaseUrl(),
        platform: Capacitor.getPlatform(),
        tokenLength: token.value.length,
      });
      console.info("[Push] registerPushDevice API call started", {
        apiBaseUrl: getApiBaseUrl(),
        platform: Capacitor.getPlatform(),
      });
      void api.registerPushDevice({
        platform: Capacitor.getPlatform(),
        token: token.value,
      })
        .then((device) => {
          console.info("[Push] registerPushDevice API call success", {
            pushDeviceId: device.id,
            platform: device.platform,
            isActive: device.is_active,
          });
        })
        .catch((error) => {
          console.warn("[Push] registerPushDevice API call failed", {
            step: "registerPushDevice",
            message: getErrorMessage(error),
            error,
          });
        });
    });
    await PushNotifications.addListener("registrationError", (error) => {
      console.warn("[Push] PushNotifications registration error event received", {
        step: "PushNotifications registration",
        message: getErrorMessage(error),
        error,
      });
    });
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      handlePushNotificationAction(action);
    });
    console.info("[Push] listener registration complete");
  } else {
    console.info("[Push] listener registration skipped; listeners already attached");
  }

  const permissionCheck = await PushNotifications.checkPermissions();
  console.info("[Push] permission check result", permissionCheck);
  const permissionStatus = await PushNotifications.requestPermissions();
  console.info("[Push] permission request result", permissionStatus);
  if (permissionStatus.receive !== "granted") {
    console.warn("[Push] permission was not granted", {
      step: "requestPermissions",
      receive: permissionStatus.receive,
    });
    return false;
  }
  console.info("[Push] PushNotifications.register() called");
  await PushNotifications.register();
  initializedForUserId = currentUser.id;
  return true;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function handlePushNotificationAction(action: PushNotificationAction): void {
  const type = String(action.notification.data?.type ?? "");
  if (type === "plan_update" || type === "measurement_reviewed") {
    window.location.assign("/me/assignments");
    return;
  }
  window.location.assign("/me/assignments");
}
