package com.gymos.app;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import java.util.Locale;
import java.util.function.BooleanSupplier;

/**
 * Windows the page opens with window.open() or target="_blank".
 *
 * A WebView has no tabs. With multiple-window support off (Capacitor's
 * default), a popup replaced the app page itself -- and Razorpay's checkout,
 * which finishes a payment in a popup and reports back to the page that
 * opened it, lost that page. A popup for GymOS or an in-app host now opens in
 * a sheet over the app with a close button (Back closes it too); a popup for
 * any other site goes to the browser, as a link to another site would.
 */
final class PopupWindows {

    private final AppCompatActivity activity;
    private final String appHost;
    private final HostPatterns inAppHosts;
    private final BooleanSupplier lightTheme;
    private final Handler mainThread = new Handler(Looper.getMainLooper());

    private WebView popup;
    private View sheet;
    private TextView title;

    PopupWindows(AppCompatActivity activity, String appHost, HostPatterns inAppHosts, BooleanSupplier lightTheme) {
        this.activity = activity;
        this.appHost = appHost;
        this.inAppHosts = inAppHosts;
        this.lightTheme = lightTheme;
    }

    boolean isOpen() {
        return popup != null;
    }

    @SuppressLint("SetJavaScriptEnabled")
    boolean open(WebView opener, Message resultMsg) {
        close();
        WebView window = new WebView(activity);
        WebSettings settings = window.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(opener.getSettings().getUserAgentString());
        CookieManager.getInstance().setAcceptThirdPartyCookies(window, true);
        window.setWebViewClient(new Client());
        window.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView view, String pageTitle) {
                if (view == popup && title != null && !TextUtils.isEmpty(pageTitle)) {
                    title.setText(pageTitle);
                }
            }

            @Override
            public void onCloseWindow(WebView view) {
                if (view == popup) {
                    close();
                }
            }
        });
        popup = window;
        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(window);
        resultMsg.sendToTarget();
        return true;
    }

    void back() {
        if (popup == null) {
            return;
        }
        if (popup.canGoBack()) {
            popup.goBack();
        } else {
            close();
        }
    }

    void close() {
        if (sheet != null) {
            ((ViewGroup) sheet.getParent()).removeView(sheet);
            sheet = null;
            title = null;
        }
        if (popup != null) {
            WebView closing = popup;
            popup = null;
            // Later, not now: close() can run inside one of this WebView's own callbacks.
            mainThread.post(closing::destroy);
        }
    }

    /** True when the popup must not load {@code url} itself. */
    private boolean route(WebView window, Uri url) {
        if (window != popup) {
            return true;
        }
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "http":
            case "https":
                break;
            case "about":
            case "blob":
            case "data":
                return false;
            case "intent":
                ExternalLinks.openIntentUri(activity, url.toString());
                closeIfHidden();
                return true;
            default:
                ExternalLinks.open(activity, url);
                closeIfHidden();
                return true;
        }
        if (sheet != null) {
            // Once showing, the window keeps its own navigations (a bank's 3-D Secure page mid-checkout).
            return false;
        }
        String host = url.getHost();
        if (host != null && (host.equalsIgnoreCase(appHost) || inAppHosts.matches(host))) {
            show(window, host);
            return false;
        }
        ExternalLinks.open(activity, url);
        close();
        return true;
    }

    private void closeIfHidden() {
        if (sheet == null) {
            close();
        }
    }

    private void show(WebView window, String host) {
        boolean light = lightTheme.getAsBoolean();
        int background = ContextCompat.getColor(activity, light ? R.color.gymos_bg_light : R.color.gymos_bg_dark);
        int ink = ContextCompat.getColor(activity, light ? R.color.gymos_ink_light : R.color.gymos_ink_dark);
        int line = ContextCompat.getColor(activity, light ? R.color.gymos_line_light : R.color.gymos_line_dark);

        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(background);
        // Touches on the sheet must never reach the app page underneath.
        layout.setClickable(true);

        LinearLayout bar = new LinearLayout(activity);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(0, 0, dp(16), 0);

        ImageButton closeButton = new ImageButton(activity);
        closeButton.setImageResource(R.drawable.ic_close);
        closeButton.setColorFilter(ink);
        TypedValue ripple = new TypedValue();
        activity.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true);
        closeButton.setBackgroundResource(ripple.resourceId);
        closeButton.setContentDescription(activity.getString(R.string.popup_close));
        closeButton.setOnClickListener((v) -> close());
        bar.addView(closeButton, new LinearLayout.LayoutParams(dp(56), dp(56)));

        title = new TextView(activity);
        title.setTextColor(ink);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setText(host);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        layout.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)));

        View divider = new View(activity);
        divider.setBackgroundColor(line);
        layout.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        layout.addView(window, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        ViewGroup content = activity.findViewById(android.R.id.content);
        content.addView(layout, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        sheet = layout;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics()));
    }

    private final class Client extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return route(view, request.getUrl());
        }

        // A window's first load does not always pass through shouldOverrideUrlLoading.
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (url != null && route(view, Uri.parse(url))) {
                view.stopLoading();
            }
        }
    }
}
