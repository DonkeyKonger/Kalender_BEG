package de.beg.kalenderbaustellen;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidBackgroundGps")
public class AndroidBackgroundGpsPlugin extends Plugin {
    @PluginMethod
    public void startTracking(PluginCall call) {
        Context context = getContext();
        if (!hasForegroundLocationPermission(context)) {
            call.reject("Standortberechtigung fehlt.");
            return;
        }
        if (!hasBackgroundLocationPermission(context)) {
            call.reject("Hintergrund-Standortberechtigung fehlt. Bitte in Android den Standortzugriff auf \"Immer erlauben\" setzen.");
            return;
        }
        if (!hasNotificationPermission(context)) {
            call.reject("Benachrichtigungsberechtigung fehlt. Bitte Benachrichtigungen für die App erlauben.");
            return;
        }

        String apiBaseUrl = call.getString("apiBaseUrl");
        String accessToken = call.getString("accessToken");
        String source = call.getString("source", "android_background_service");
        if (apiBaseUrl == null || apiBaseUrl.trim().isEmpty()) {
            call.reject("API-Basis-URL fehlt.");
            return;
        }
        if (accessToken == null || accessToken.trim().isEmpty()) {
            call.reject("Login-Token fehlt.");
            return;
        }

        AndroidBackgroundGpsService.startTracking(context, apiBaseUrl, accessToken, source);
        call.resolve(statusToJson(AndroidBackgroundGpsService.readStatus(context)));
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        AndroidBackgroundGpsService.stopTracking(getContext());
        call.resolve(statusToJson(AndroidBackgroundGpsService.readStatus(getContext())));
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(statusToJson(AndroidBackgroundGpsService.readStatus(getContext())));
    }

    private JSObject statusToJson(AndroidBackgroundGpsService.BackgroundGpsStatus status) {
        JSObject result = new JSObject();
        result.put("isTracking", status.isTracking);
        result.put("intervalMs", status.intervalMs);
        result.put("queuedCount", status.queuedCount);
        result.put("lastSentAt", status.lastSentAt);
        result.put("message", status.message);
        return result;
    }

    private boolean hasForegroundLocationPermission(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocationPermission(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return true;
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
}
