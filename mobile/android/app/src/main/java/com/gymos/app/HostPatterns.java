package com.gymos.app;

import java.util.Locale;

/**
 * Host patterns from capacitor.config.js (plugins.GymOSShell.inAppHosts):
 * "example.com" matches that host exactly; "*.example.com" matches it and
 * every subdomain.
 */
final class HostPatterns {

    private final String[] patterns;

    HostPatterns(String[] patterns) {
        this.patterns = patterns == null ? new String[0] : patterns.clone();
    }

    boolean matches(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String candidate = host.toLowerCase(Locale.ROOT);
        for (String raw : patterns) {
            String pattern = raw.toLowerCase(Locale.ROOT);
            if (pattern.startsWith("*.")) {
                String domain = pattern.substring(2);
                if (candidate.equals(domain) || candidate.endsWith("." + domain)) {
                    return true;
                }
            } else if (candidate.equals(pattern)) {
                return true;
            }
        }
        return false;
    }
}
