package com.gymos.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;
import java.net.URISyntaxException;

/** Hands a link GymOS does not display itself to the app that owns it. */
final class ExternalLinks {

    private ExternalLinks() {}

    static void open(Activity activity, Uri uri) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * intent: links (a UPI app offered by a payment page) are Android intents
     * written as a URL. Opened the way Chrome opens them: as a BROWSABLE intent
     * with no explicit component or selector, so a page can never use one to
     * start a private activity; falling back to browser_fallback_url.
     */
    static void openIntentUri(Activity activity, String link) {
        Intent intent;
        try {
            intent = Intent.parseUri(link, Intent.URI_INTENT_SCHEME);
        } catch (URISyntaxException e) {
            return;
        }
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setComponent(null);
        intent.setSelector(null);
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            String fallback = intent.getStringExtra("browser_fallback_url");
            if (fallback != null && fallback.startsWith("https://")) {
                open(activity, Uri.parse(fallback));
            } else {
                Toast.makeText(activity, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
            }
        }
    }
}
