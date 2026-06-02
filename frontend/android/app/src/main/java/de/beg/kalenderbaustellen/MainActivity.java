package de.beg.kalenderbaustellen;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AndroidBackgroundGpsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
