import { ApiError, api } from "./api";

type MobileGpsSendResult = {
  sentAt: string;
};

export async function sendCurrentGpsLocation(): Promise<MobileGpsSendResult> {
  if (!("geolocation" in navigator)) {
    throw new Error("Standort ist auf diesem Gerät nicht verfügbar.");
  }

  const position = await getCurrentPosition();
  const capturedAt = new Date(position.timestamp || Date.now()).toISOString();
  await api.createGpsLocationPoint({
    captured_at: capturedAt,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_meters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    source: "mobile",
    device_id: getMobileGpsDeviceId(),
  });

  return { sentAt: new Date().toISOString() };
}

export function formatMobileGpsError(error: unknown): string {
  if (isGeolocationPositionError(error)) {
    if (error.code === error.PERMISSION_DENIED) {
      return "Standortberechtigung fehlt.";
    }
    if (error.code === error.POSITION_UNAVAILABLE) {
      return "Standort konnte nicht ermittelt werden.";
    }
    if (error.code === error.TIMEOUT) {
      return "Standortabfrage hat zu lange gedauert.";
    }
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Standort konnte nicht gesendet werden. Bitte erneut anmelden.";
    }
    return error.message || "Standort konnte nicht gesendet werden.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Standort konnte nicht gesendet werden.";
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 60_000,
      timeout: 15_000,
    });
  });
}

function getMobileGpsDeviceId(): string {
  const userAgent = navigator.userAgent || "webview";
  return `mobile:${userAgent.slice(0, 96)}`;
}

function isGeolocationPositionError(error: unknown): error is GeolocationPositionError {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && "PERMISSION_DENIED" in error
    && "POSITION_UNAVAILABLE" in error
    && "TIMEOUT" in error;
}
