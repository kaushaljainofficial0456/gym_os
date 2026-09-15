package com.gymos.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Logger;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** Injects mobile/src/shell.js (shipped as public/gymos-shell.js) into the GymOS origin at document start. */
final class ShellScript {

    static final String ASSET = "public/gymos-shell.js";

    private ShellScript() {}

    static void install(Context context, WebView webView, Uri server) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Logger.warn("GymOSShell", "This WebView cannot run document-start scripts: native share, downloads and dialog-aware Back are off");
            return;
        }
        String origin = server.getScheme() + "://" + server.getEncodedAuthority();
        WebViewCompat.addDocumentStartJavaScript(webView, read(context), Collections.singleton(origin));
    }

    private static String read(Context context) {
        try (InputStream in = context.getAssets().open(ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) != -1; ) {
                out.write(buffer, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("Missing " + ASSET + " -- run `npm run sync` in mobile/", e);
        }
    }
}
