package com.gymos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialUnknownException;
import androidx.credentials.exceptions.NoCredentialException;
import org.junit.Test;

public class GoogleSignInTest {

    @Test
    public void acceptsOnlyAGoogleOAuthClientId() {
        assertTrue(GoogleSignIn.isClientId("1234567890-abcdef.apps.googleusercontent.com"));
        assertFalse(GoogleSignIn.isClientId(null));
        assertFalse(GoogleSignIn.isClientId(""));
        assertFalse(GoogleSignIn.isClientId("apps.googleusercontent.com"));
        assertFalse(GoogleSignIn.isClientId("1234.apps.googleusercontent.com.evil.test"));
        assertFalse(GoogleSignIn.isClientId("1234 abc.apps.googleusercontent.com"));
    }

    @Test
    public void closingGooglesSheetIsCanceledNotAnError() {
        assertEquals("CANCELED", GoogleSignIn.failureFor(new GetCredentialCancellationException("closed")).code);
    }

    @Test
    public void noAccountOnThePhoneSaysSo() {
        GoogleSignIn.Failure failure = GoogleSignIn.failureFor(new NoCredentialException("none"));
        assertEquals("NO_ACCOUNT", failure.code);
        assertTrue(failure.message.contains("No Google account"));
    }

    @Test
    public void anyOtherFailureKeepsGooglesReasonForDiagnosis() {
        GoogleSignIn.Failure failure = GoogleSignIn.failureFor(new GetCredentialUnknownException("[28444] Developer console is not set up correctly."));
        assertEquals("FAILED", failure.code);
        assertTrue(failure.message.contains("Developer console is not set up correctly"));
        assertTrue(failure.message.contains("email"));
    }
}
