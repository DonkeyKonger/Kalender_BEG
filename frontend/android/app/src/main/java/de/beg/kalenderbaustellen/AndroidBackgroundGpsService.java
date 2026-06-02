package de.beg.kalenderbaustellen;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.Task;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AndroidBackgroundGpsService extends Service {
    static final long GPS_INTERVAL_MS = 900_000L;

    private static final String TAG = "KbAndroidGps";
    private static final String ACTION_START = "de.beg.kalenderbaustellen.gps.START";
    private static final String ACTION_STOP = "de.beg.kalenderbaustellen.gps.STOP";
    private static final String EXTRA_API_BASE_URL = "apiBaseUrl";
    private static final String EXTRA_ACCESS_TOKEN = "accessToken";
    private static final String EXTRA_SOURCE = "source";
    private static final String PREFS_NAME = "kb_android_background_gps";
    private static final String KEY_TRACKING = "tracking";
    private static final String KEY_API_BASE_URL = "api_base_url";
    private static final String KEY_ACCESS_TOKEN = "access_token";
    private static final String KEY_SOURCE = "source";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_LAST_SENT_AT = "last_sent_at";
    private static final String KEY_QUEUE = "queue";
    private static final String NOTIFICATION_CHANNEL_ID = "kb_android_gps_tracking";
    private static final int NOTIFICATION_ID = 7201;
    private static final int MAX_QUEUE_ITEMS = 672;

    private HandlerThread handlerThread;
    private Handler handler;
    private ExecutorService networkExecutor;
    private FusedLocationProviderClient fusedLocationProvider;
    private ConnectivityManager connectivityManager;
    private boolean networkCallbackRegistered = false;
    private boolean tickInFlight = false;

    private final Runnable tickRunnable = this::runGpsTick;
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network network) {
            scheduleImmediateTick();
        }
    };

    public static void startTracking(Context context, String apiBaseUrl, String accessToken, String source) {
        Intent intent = new Intent(context, AndroidBackgroundGpsService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_API_BASE_URL, apiBaseUrl);
        intent.putExtra(EXTRA_ACCESS_TOKEN, accessToken);
        intent.putExtra(EXTRA_SOURCE, source);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void stopTracking(Context context) {
        preferences(context)
            .edit()
            .putBoolean(KEY_TRACKING, false)
            .remove(KEY_ACCESS_TOKEN)
            .apply();

        Intent intent = new Intent(context, AndroidBackgroundGpsService.class);
        intent.setAction(ACTION_STOP);
        try {
            context.startService(intent);
        } catch (IllegalStateException ignored) {
            context.stopService(intent);
        }
    }

    public static BackgroundGpsStatus readStatus(Context context) {
        SharedPreferences prefs = preferences(context);
        return new BackgroundGpsStatus(
            prefs.getBoolean(KEY_TRACKING, false),
            GPS_INTERVAL_MS,
            readQueueCount(prefs),
            prefs.getString(KEY_LAST_SENT_AT, null),
            prefs.getBoolean(KEY_TRACKING, false) ? "Android-Hintergrundstandort aktiv." : "Android-Hintergrundstandort gestoppt."
        );
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handlerThread = new HandlerThread("KbAndroidBackgroundGps");
        handlerThread.start();
        handler = new Handler(handlerThread.getLooper());
        networkExecutor = Executors.newSingleThreadExecutor();
        fusedLocationProvider = LocationServices.getFusedLocationProviderClient(this);
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        createNotificationChannel();
        registerNetworkCallback();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            shutdownTracking();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            saveTrackingConfig(intent);
        }

        if (!isTrackingEnabled()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundNotification();
        scheduleImmediateTick();
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
        if (networkCallbackRegistered && connectivityManager != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                // Callback may already be removed by the OS.
            }
        }
        if (networkExecutor != null) {
            networkExecutor.shutdownNow();
        }
        if (handlerThread != null) {
            handlerThread.quitSafely();
        }
        super.onDestroy();
    }

    private void saveTrackingConfig(Intent intent) {
        String apiBaseUrl = intent.getStringExtra(EXTRA_API_BASE_URL);
        String accessToken = intent.getStringExtra(EXTRA_ACCESS_TOKEN);
        String source = intent.getStringExtra(EXTRA_SOURCE);
        SharedPreferences.Editor editor = preferences(this).edit()
            .putBoolean(KEY_TRACKING, true)
            .putString(KEY_DEVICE_ID, getStableDeviceId());
        if (apiBaseUrl != null) {
            editor.putString(KEY_API_BASE_URL, apiBaseUrl);
        }
        if (accessToken != null) {
            editor.putString(KEY_ACCESS_TOKEN, accessToken);
        }
        editor.putString(KEY_SOURCE, source != null ? source : "android_background_service");
        editor.apply();
    }

    private void shutdownTracking() {
        if (handler != null) {
            handler.removeCallbacks(tickRunnable);
        }
        tickInFlight = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void runGpsTick() {
        if (!isTrackingEnabled()) {
            stopSelf();
            return;
        }
        if (tickInFlight) {
            scheduleNextTick();
            return;
        }
        tickInFlight = true;
        if (networkExecutor == null) {
            finishTick();
            return;
        }
        networkExecutor.execute(() -> {
            flushQueuedPoints();
            requestCurrentLocation();
        });
    }

    private void requestCurrentLocation() {
        if (!hasLocationPermission()) {
            Log.w(TAG, "Location permission missing; stopping Android background GPS.");
            preferences(this).edit().putBoolean(KEY_TRACKING, false).apply();
            finishTick();
            stopSelf();
            return;
        }

        try {
            Task<Location> task = fusedLocationProvider.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null);
            task.addOnSuccessListener(networkExecutor, location -> {
                if (location != null && isValidLocation(location)) {
                    sendOrQueue(buildPayload(location));
                } else {
                    Log.w(TAG, "No valid current location returned for background GPS tick.");
                }
            });
            task.addOnFailureListener(networkExecutor, error -> Log.w(TAG, "Current location request failed.", error));
            task.addOnCompleteListener(networkExecutor, ignored -> finishTick());
        } catch (SecurityException error) {
            Log.w(TAG, "Location permission rejected while requesting background GPS.", error);
            finishTick();
        } catch (RuntimeException error) {
            Log.w(TAG, "Current location request failed unexpectedly.", error);
            finishTick();
        }
    }

    private void sendOrQueue(JSONObject payload) {
        if (!trySendPayload(payload)) {
            enqueuePayload(payload);
        }
    }

    private boolean trySendPayload(JSONObject payload) {
        if (!isNetworkAvailable()) {
            return false;
        }

        HttpURLConnection connection = null;
        try {
            URL url = new URL(locationPointEndpoint());
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + readAccessToken());
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int responseCode = connection.getResponseCode();
            if (responseCode >= 200 && responseCode < 300) {
                preferences(this).edit().putString(KEY_LAST_SENT_AT, nowIso()).apply();
                return true;
            }
            if (responseCode == 401 || responseCode == 403) {
                Log.w(TAG, "Background GPS auth failed; stopping service.");
                preferences(this).edit().putBoolean(KEY_TRACKING, false).remove(KEY_ACCESS_TOKEN).apply();
                stopSelf();
                return true;
            }
            if (responseCode >= 400 && responseCode < 500) {
                Log.w(TAG, "Background GPS point rejected with status " + responseCode + "; dropping payload.");
                return true;
            }
            Log.w(TAG, "Background GPS point failed with retryable status " + responseCode + ".");
            return false;
        } catch (Exception error) {
            Log.w(TAG, "Background GPS point send failed; queued for retry.", error);
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void flushQueuedPoints() {
        JSONArray queue = readQueue();
        if (queue.length() == 0) {
            return;
        }

        JSONArray remaining = new JSONArray();
        for (int index = 0; index < queue.length(); index += 1) {
            JSONObject payload = queue.optJSONObject(index);
            if (payload == null) {
                continue;
            }
            if (!trySendPayload(payload)) {
                remaining.put(payload);
                for (int rest = index + 1; rest < queue.length(); rest += 1) {
                    JSONObject restPayload = queue.optJSONObject(rest);
                    if (restPayload != null) {
                        remaining.put(restPayload);
                    }
                }
                break;
            }
        }
        writeQueue(trimQueue(remaining));
    }

    private void enqueuePayload(JSONObject payload) {
        JSONArray queue = readQueue();
        queue.put(payload);
        writeQueue(trimQueue(queue));
    }

    private JSONArray trimQueue(JSONArray queue) {
        if (queue.length() <= MAX_QUEUE_ITEMS) {
            return queue;
        }
        JSONArray trimmed = new JSONArray();
        int start = queue.length() - MAX_QUEUE_ITEMS;
        for (int index = start; index < queue.length(); index += 1) {
            JSONObject payload = queue.optJSONObject(index);
            if (payload != null) {
                trimmed.put(payload);
            }
        }
        return trimmed;
    }

    private JSONArray readQueue() {
        String raw = preferences(this).getString(KEY_QUEUE, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException error) {
            Log.w(TAG, "Stored background GPS queue is invalid; resetting queue.", error);
            return new JSONArray();
        }
    }

    private void writeQueue(JSONArray queue) {
        preferences(this).edit().putString(KEY_QUEUE, queue.toString()).apply();
    }

    private JSONObject buildPayload(Location location) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("captured_at", toIso(location.getTime()));
            payload.put("latitude", location.getLatitude());
            payload.put("longitude", location.getLongitude());
            if (location.hasAccuracy()) {
                payload.put("accuracy_meters", location.getAccuracy());
            } else {
                payload.put("accuracy_meters", JSONObject.NULL);
            }
            payload.put("source", readSource());
            payload.put("device_id", readDeviceId());
        } catch (JSONException error) {
            Log.w(TAG, "Could not build background GPS payload.", error);
        }
        return payload;
    }

    private boolean isValidLocation(Location location) {
        return location.getLatitude() >= -90
            && location.getLatitude() <= 90
            && location.getLongitude() >= -180
            && location.getLongitude() <= 180;
    }

    private void scheduleImmediateTick() {
        if (handler == null || !isTrackingEnabled()) {
            return;
        }
        handler.removeCallbacks(tickRunnable);
        handler.post(tickRunnable);
    }

    private void scheduleNextTick() {
        if (handler == null || !isTrackingEnabled()) {
            return;
        }
        handler.removeCallbacks(tickRunnable);
        handler.postDelayed(tickRunnable, GPS_INTERVAL_MS);
    }

    private void finishTick() {
        tickInFlight = false;
        scheduleNextTick();
    }

    private void registerNetworkCallback() {
        if (connectivityManager == null || networkCallbackRegistered) {
            return;
        }
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
            networkCallbackRegistered = true;
        } catch (RuntimeException error) {
            Log.w(TAG, "Could not register network callback for background GPS retry.", error);
        }
    }

    private boolean isNetworkAvailable() {
        if (connectivityManager == null) {
            return true;
        }
        Network network = connectivityManager.getActiveNetwork();
        if (network == null) {
            return false;
        }
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        return capabilities != null
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private boolean hasLocationPermission() {
        boolean foreground = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!foreground) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return true;
        }
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startForegroundNotification() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = launchIntent == null ? null : PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Kalender Baustellen Standortprüfung")
            .setContentText("Standortdaten werden zur Plausibilitätsprüfung deiner Baustellenzeiten gesendet.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE);
        if (pendingIntent != null) {
            builder.setContentIntent(pendingIntent);
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Standortprüfung",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Sendet Standortpunkte zur Plausibilitätsprüfung von Baustellenzeiten.");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private boolean isTrackingEnabled() {
        return preferences(this).getBoolean(KEY_TRACKING, false);
    }

    private String locationPointEndpoint() {
        String baseUrl = preferences(this).getString(KEY_API_BASE_URL, "");
        while (baseUrl.endsWith("/")) {
            baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
        }
        return baseUrl + "/gps/location-points";
    }

    private String readAccessToken() {
        return preferences(this).getString(KEY_ACCESS_TOKEN, "");
    }

    private String readSource() {
        return preferences(this).getString(KEY_SOURCE, "android_background_service");
    }

    private String readDeviceId() {
        return preferences(this).getString(KEY_DEVICE_ID, getStableDeviceId());
    }

    private String getStableDeviceId() {
        String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        if (androidId != null && !androidId.trim().isEmpty()) {
            return "android_app:" + androidId;
        }
        SharedPreferences prefs = preferences(this);
        String existing = prefs.getString(KEY_DEVICE_ID, null);
        if (existing != null && !existing.trim().isEmpty()) {
            return existing;
        }
        String generated = "android_app:" + UUID.randomUUID();
        prefs.edit().putString(KEY_DEVICE_ID, generated).apply();
        return generated;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static int readQueueCount(SharedPreferences prefs) {
        String raw = prefs.getString(KEY_QUEUE, "[]");
        try {
            return new JSONArray(raw).length();
        } catch (JSONException ignored) {
            return 0;
        }
    }

    private static String nowIso() {
        return toIso(System.currentTimeMillis());
    }

    private static String toIso(long timestampMs) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timestampMs));
    }

    public static class BackgroundGpsStatus {
        public final boolean isTracking;
        public final long intervalMs;
        public final int queuedCount;
        @Nullable public final String lastSentAt;
        public final String message;

        BackgroundGpsStatus(boolean isTracking, long intervalMs, int queuedCount, @Nullable String lastSentAt, String message) {
            this.isTracking = isTracking;
            this.intervalMs = intervalMs;
            this.queuedCount = queuedCount;
            this.lastSentAt = lastSentAt;
            this.message = message;
        }
    }
}
