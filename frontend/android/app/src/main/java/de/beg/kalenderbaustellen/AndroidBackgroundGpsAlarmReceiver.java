package de.beg.kalenderbaustellen;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class AndroidBackgroundGpsAlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "KbAndroidGpsAlarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!AndroidBackgroundGpsService.ACTION_ALARM_TICK.equals(action)) {
            Log.i(TAG, "Ignoring unrelated alarm receiver action: " + action);
            return;
        }
        AndroidBackgroundGpsService.triggerScheduledTick(context);
    }
}
