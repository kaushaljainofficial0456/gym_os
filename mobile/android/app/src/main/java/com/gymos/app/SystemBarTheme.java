package com.gymos.app;

import android.app.Activity;
import android.view.Window;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Matches the status and navigation bars to the web app's light/dark theme.
 * The WebView is inset clear of both bars (SystemBars insetsHandling "css"),
 * so the bars show the window behind it: painted in the theme's --bg, with
 * icons that stay legible on it.
 */
final class SystemBarTheme {

    private SystemBarTheme() {}

    static void apply(Activity activity, boolean light) {
        Window window = activity.getWindow();
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setAppearanceLightStatusBars(light);
        bars.setAppearanceLightNavigationBars(light);
        window.getDecorView().setBackgroundColor(ContextCompat.getColor(activity, light ? R.color.gymos_bg_light : R.color.gymos_bg_dark));
    }
}
