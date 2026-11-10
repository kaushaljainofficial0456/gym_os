package com.gymos.app;

import android.app.Activity;
import android.os.CancellationSignal;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/**
 * Native "Sign in with Google", through Android's Credential Manager.
 *
 * Google refuses to sign anyone in inside an embedded WebView, which is what
 * this app is, so the website's own Google button cannot work here. This asks
 * Android for a Google ID token instead and hands it back to the page, which
 * posts it to the same /auth/google routes the website uses.
 *
 * serverClientId is the website's own (Web application) OAuth client ID, so
 * the token's audience is the one the backend already checks. Google only
 * issues it once the project also has an Android OAuth client registered for
 * this app's package name and signing-key SHA-1 -- until then the request
 * fails with a "developer console is not set up" error.
 */
final class GoogleSignIn {

    /** What the page gets back when sign-in does not produce a token. */
    static final class Failure {
        final String code;
        final String message;

        Failure(String code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    interface Callback {
        void onToken(String idToken);

        void onFailure(Failure failure);
    }

    private GoogleSignIn() {}

    /** A web OAuth client ID looks like "1234-abc.apps.googleusercontent.com". */
    static boolean isClientId(String value) {
        return value != null && value.length() < 200 && value.matches("[A-Za-z0-9._-]+\\.apps\\.googleusercontent\\.com");
    }

    static void start(Activity activity, String serverClientId, Callback callback) {
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager.create(activity).getCredentialAsync(
            activity,
            request,
            new CancellationSignal(),
            ContextCompat.getMainExecutor(activity),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (credential instanceof CustomCredential
                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        try {
                            callback.onToken(GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken());
                        } catch (Exception e) {
                            callback.onFailure(new Failure("FAILED", "Google sent a sign-in the app could not read. Try again."));
                        }
                        return;
                    }
                    callback.onFailure(new Failure("FAILED", "Google did not return a sign-in. Try again."));
                }

                @Override
                public void onError(GetCredentialException e) {
                    callback.onFailure(failureFor(e));
                }
            }
        );
    }

    static Failure failureFor(GetCredentialException e) {
        if (e instanceof GetCredentialCancellationException) {
            return new Failure("CANCELED", "Google sign-in was closed.");
        }
        if (e instanceof NoCredentialException) {
            return new Failure("NO_ACCOUNT", "No Google account is available on this phone. Add one in Settings, or sign in with email.");
        }
        String detail = e.getMessage() == null ? e.getType() : e.getMessage();
        return new Failure("FAILED", "Google sign-in didn't work in the app (" + detail + "). Sign in with email instead.");
    }
}
