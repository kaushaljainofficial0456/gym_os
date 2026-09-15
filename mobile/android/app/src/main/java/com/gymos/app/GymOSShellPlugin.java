package com.gymos.app;

import android.net.Uri;
import android.util.Base64;
import android.widget.Toast;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Locale;

/**
 * Native half of mobile/src/shell.js. Callable only from the GymOS origin and
 * the shell's own offline page -- the only origins Capacitor exposes its
 * bridge to, since the config sets server.url and no server.allowNavigation.
 */
@CapacitorPlugin(name = "GymOSShell")
public class GymOSShellPlugin extends Plugin {

    private HostPatterns inAppHosts = new HostPatterns(null);

    @Override
    public void load() {
        inAppHosts = new HostPatterns(getConfig().getArray("inAppHosts", new String[0]));
    }

    HostPatterns getInAppHosts() {
        return inAppHosts;
    }

    /**
     * Consulted for main-frame navigations before Capacitor's own rule (GymOS
     * loads in the app, every other site opens in the browser). WHOOP / Oura
     * sign-in pages load in the app so their OAuth callback lands back in
     * GymOS, as it does on the web; intent: links start the app they name.
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        if ("intent".equals(scheme)) {
            ExternalLinks.openIntentUri(getActivity(), url.toString());
            return true;
        }
        if ("https".equals(scheme) && inAppHosts.matches(url.getHost())) {
            return false;
        }
        return null;
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        boolean light = "light".equals(call.getString("theme"));
        getActivity().runOnUiThread(() -> {
            ((MainActivity) getActivity()).setLightTheme(light);
            call.resolve();
        });
    }

    @PluginMethod
    public void saveDownload(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("No file data");
            return;
        }
        String fileName = Downloads.safeFileName(call.getString("filename"));
        String mimeType = call.getString("mimeType", "application/octet-stream");
        try {
            Uri uri = Downloads.save(getContext(), fileName, mimeType, Base64.decode(data, Base64.DEFAULT));
            getActivity().runOnUiThread(() -> {
                Toast.makeText(getContext(), getContext().getString(R.string.download_saved, fileName), Toast.LENGTH_SHORT).show();
                Downloads.open(getActivity(), uri, mimeType);
            });
            call.resolve();
        } catch (IOException | IllegalArgumentException e) {
            Logger.error("GymOSShell", "Could not save a download", e);
            getActivity().runOnUiThread(() -> Toast.makeText(getContext(), R.string.download_failed, Toast.LENGTH_LONG).show());
            call.reject("Could not save the file");
        }
    }
}
