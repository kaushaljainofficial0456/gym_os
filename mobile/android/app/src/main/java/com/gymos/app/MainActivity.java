package com.gymos.app;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;

/**
 * The GymOS web app in a Capacitor WebView, plus the Android behaviour a
 * browser tab gets for free: a splash until GymOS paints, a Back button that
 * understands the app, popup windows, deep links, and system bars that follow
 * the app's theme. See mobile/README.md.
 */
public class MainActivity extends BridgeActivity {

    // The splash waits for GymOS's first frame, but never longer than this on a
    // slow network -- the web app shows its own loading state after that.
    private static final long SPLASH_TIMEOUT_MS = 6000;

    private Uri server;
    private PopupWindows popups;
    private boolean lightTheme;
    private boolean firstPageVisible;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        long splashDeadline = SystemClock.uptimeMillis() + SPLASH_TIMEOUT_MS;
        SplashScreen.installSplashScreen(this)
            .setKeepOnScreenCondition(() -> !firstPageVisible && SystemClock.uptimeMillis() < splashDeadline);
        registerPlugin(GymOSShellPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                navigateBack();
            }
        });
    }

    @Override
    protected void load() {
        server = Uri.parse(CapConfig.loadDefault(this).getServerUrl());
        // Registered before super.load() starts loading GymOS, so the very first
        // document already gets the script.
        ShellScript.install(this, findViewById(com.getcapacitor.android.R.id.webview), server);
        super.load();

        WebView webView = bridge.getWebView();
        WebSettings settings = webView.getSettings();
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        // Chrome accepts third-party cookies and the Razorpay checkout frame relies
        // on them. GymOS's own session cookie is SameSite=strict either way.
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        GymOSShellPlugin shell = (GymOSShellPlugin) bridge.getPlugin("GymOSShell").getInstance();
        popups = new PopupWindows(this, server.getHost(), shell.getInAppHosts(), () -> lightTheme);
        webView.setWebChromeClient(new ShellChromeClient(bridge, popups));
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                firstPageVisible = true;
            }
        });
    }

    private void navigateBack() {
        if (popups != null && popups.isOpen()) {
            popups.back();
            return;
        }
        if (bridge == null) {
            moveTaskToBack(true);
            return;
        }
        WebView webView = bridge.getWebView();
        String url = webView.getUrl();
        boolean canGoBack = webView.canGoBack();
        if (!isGymOSPage(url)) {
            // The offline page (whose history entry is the load that just failed),
            // or a WHOOP / Oura sign-in page opened from GymOS.
            if (canGoBack && url != null && !url.equals(bridge.getErrorUrl())) {
                webView.goBack();
            } else {
                moveTaskToBack(true);
            }
            return;
        }
        // The page decides: close a dialog, step back, or leave from a home screen
        // (mobile/src/shell.js). Leaving keeps GymOS alive in the background, as
        // Back from a launcher app has done since Android 12.
        webView.evaluateJavascript("window.__gymosShell ? window.__gymosShell.back(" + canGoBack + ") : null", (result) -> {
            if ("\"exit\"".equals(result)) {
                moveTaskToBack(true);
            } else if ("null".equals(result)) {
                if (canGoBack) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }

    private boolean isGymOSPage(String url) {
        if (url == null) {
            return false;
        }
        Uri page = Uri.parse(url);
        return server.getScheme().equals(page.getScheme()) && server.getEncodedAuthority().equalsIgnoreCase(page.getEncodedAuthority());
    }

    // BridgeActivity.load() routes the launch intent through here as well.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openAppLink(intent);
    }

    /** A GymOS link opened from outside the app -- a shared workout, an invite, a password reset -- opens that page. */
    private void openAppLink(Intent intent) {
        Uri link = intent == null ? null : intent.getData();
        if (bridge == null || link == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        if ("https".equals(link.getScheme()) && server.getEncodedAuthority().equalsIgnoreCase(link.getEncodedAuthority())) {
            bridge.getWebView().loadUrl(link.toString());
        }
    }

    void setLightTheme(boolean light) {
        lightTheme = light;
        SystemBarTheme.apply(this, light);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Capacitor's SystemBars restyles the bars on rotation or a system dark-mode
        // switch; GymOS follows the page's theme, not the system's.
        SystemBarTheme.apply(this, lightTheme);
    }

    @Override
    public void onPause() {
        super.onPause();
        // WebView writes cookies to disk lazily; flushing on the way to the
        // background keeps the session if Android then reclaims the process.
        CookieManager.getInstance().flush();
    }

    @Override
    public void onDestroy() {
        if (popups != null) {
            popups.close();
        }
        super.onDestroy();
    }
}
