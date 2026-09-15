package com.gymos.app;

import android.os.Message;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/** Capacitor's chrome client (file chooser, camera permission, JS dialogs) plus popup windows. */
final class ShellChromeClient extends BridgeWebChromeClient {

    private final PopupWindows popups;

    ShellChromeClient(Bridge bridge, PopupWindows popups) {
        super(bridge);
        this.popups = popups;
    }

    @Override
    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        return popups.open(view, resultMsg);
    }
}
