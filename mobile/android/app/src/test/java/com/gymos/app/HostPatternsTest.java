package com.gymos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HostPatternsTest {

    private final HostPatterns hosts = new HostPatterns(new String[] { "*.razorpay.com", "*.whoop.com", "cloud.ouraring.com" });

    @Test
    public void wildcardMatchesTheDomainAndEverySubdomain() {
        assertTrue(hosts.matches("razorpay.com"));
        assertTrue(hosts.matches("api.razorpay.com"));
        assertTrue(hosts.matches("api.prod.whoop.com"));
        assertTrue(hosts.matches("API.Razorpay.COM"));
    }

    @Test
    public void exactPatternMatchesOnlyThatHost() {
        assertTrue(hosts.matches("cloud.ouraring.com"));
        assertFalse(hosts.matches("ouraring.com"));
        assertFalse(hosts.matches("evil.cloud.ouraring.com"));
    }

    @Test
    public void lookalikeHostsDoNotMatch() {
        assertFalse(hosts.matches("razorpay.com.evil.test"));
        assertFalse(hosts.matches("notrazorpay.com"));
        assertFalse(hosts.matches("whoop.com-login.test"));
    }

    @Test
    public void missingHostOrPatternsNeverMatch() {
        assertFalse(hosts.matches(null));
        assertFalse(hosts.matches(""));
        assertFalse(new HostPatterns(null).matches("api.razorpay.com"));
    }
}
