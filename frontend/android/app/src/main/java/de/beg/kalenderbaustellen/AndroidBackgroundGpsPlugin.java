package de.beg.kalenderbaustellen;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "AndroidBackgroundGps",
    permissions = {
        @Permission(
            alias = "foregroundLocation",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        ),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class AndroidBackgroundGpsPlugin extends Plugin {
    private static final String TAG = "KbAndroidGpsPlugin";

    @PluginMethod
    public void startTracking(PluginCall call) {
        Log.i(TAG, "startTracking called from JS.");
        Context context = getContext();
        if (!hasForegroundLocationPermission(context)) {
            Log.w(TAG, "startTracking rejected: foreground location permission missing.");
            call.reject("Standortberechtigung fehlt.");
            return;
        }
        if (!hasBackgroundLocationPermission(context)) {
            Log.w(TAG, "startTracking rejected: background location permission missing.");
            call.reject("Hintergrund-Standortberechtigung fehlt. Bitte in Android den Standortzugriff auf \"Immer erlauben\" setzen.");
            return;
        }
        if (!hasNotificationPermission(context)) {
            Log.w(TAG, "startTracking rejected: notification permission missing.");
            call.reject("Benachrichtigungsberechtigung fehlt. Bitte Benachrichtigungen für die App erlauben.");
            return;
        }

        String apiBaseUrl = call.getString("apiBaseUrl");
        String accessToken = call.getString("accessToken");
        String source = call.getString("source", "android_background_service");
        if (apiBaseUrl == null || apiBaseUrl.trim().isEmpty()) {
            Log.w(TAG, "startTracking rejected: apiBaseUrl missing.");
            call.reject("API-Basis-URL fehlt.");
            return;
        }
        if (accessToken == null || accessToken.trim().isEmpty()) {
            Log.w(TAG, "startTracking rejected: accessToken missing.");
            call.reject("Login-Token fehlt.");
            return;
        }

        AndroidBackgroundGpsService.startTracking(context, apiBaseUrl, accessToken, source);
        call.resolve(statusToJson(AndroidBackgroundGpsService.readStatus(context)));
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        Log.i(TAG, "stopTracking called from JS.");
        AndroidBackgroundGpsService.stopTracking(getContext());
        call.resolve(statusToJson(AndroidBackgroundGpsService.readStatus(getContext())));
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(statusToJson(AndroidBackgroundGpsService.readStatus(getContext())));
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        Log.i(TAG, "checkPermissions called from JS.");
        call.resolve(permissionStatusToJson(getContext()));
    }

    @PluginMethod
    public void requestForegroundLocationPermission(PluginCall call) {
        Context context = getContext();
        if (hasForegroundLocationPermission(context) && hasNotificationPermission(context)) {
            call.resolve(permissionStatusToJson(context));
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAliases(
                new String[] { "foregroundLocation", "notifications" },
                call,
                "foregroundLocationPermissionCallback"
            );
            return;
        }
        requestPermissionForAlias("foregroundLocation", call, "foregroundLocationPermissionCallback");
    }

    @PluginMethod
    public void openAppLocationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve(permissionStatusToJson(getContext()));
    }

    @PermissionCallback
    private void foregroundLocationPermissionCallback(PluginCall call) {
        call.resolve(permissionStatusToJson(getContext()));
    }

    private JSObject statusToJson(AndroidBackgroundGpsService.BackgroundGpsStatus status) {
        JSObject result = new JSObject();
        result.put("isTracking", status.isTracking);
        result.put("isServiceRunning", status.isServiceRunning);
        result.put("isForegroundServiceRunning", status.isForegroundServiceRunning);
        result.put("intervalMs", status.intervalMs);
        result.put("queuedCount", status.queuedCount);
        result.put("lastSentAt", status.lastSentAt);
        result.put("lastError", status.lastError);
        result.put("lastQueuedAt", status.lastQueuedAt);
        result.put("lastServiceStartAt", status.lastServiceStartAt);
        result.put("lastServiceStopAt", status.lastServiceStopAt);
        result.put("nextPingAt", status.nextPingAt);
        result.put("message", status.message);
        return result;
    }

    private JSObject permissionStatusToJson(Context context) {
        JSObject result = new JSObject();
        result.put("foregroundLocationGranted", hasForegroundLocationPermission(context));
        result.put("backgroundLocationGranted", hasBackgroundLocationPermission(context));
        result.put("notificationsGranted", hasNotificationPermission(context));
        result.put("canRequestForegroundLocation", true);
        result.put("requiresBackgroundLocationSettings", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        result.put("canOpenAppSettings", true);
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
