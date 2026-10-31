package com.singulancelabs.mobile;

import java.net.URI;
import java.util.Set;
import java.util.regex.Pattern;

/** Fixed destinations for OpenDot employee rooms; mirrors the iOS RoomViewController rules. */
final class RoomPolicy {
    static final String ROOM_HOST = "runtime-runner.singulancelabs.com";
    static final Set<String> ALLOWED_HOSTS = Set.of(ROOM_HOST, "dots.singulancelabs.com");
    private static final Pattern EMPLOYEE_PATH = Pattern.compile("^/employees/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    /** Returns the room URL for an `/employees/<uuid>` path, or throws IllegalArgumentException. */
    static String roomUrl(String path) {
        if (path == null || !EMPLOYEE_PATH.matcher(path).matches()) throw new IllegalArgumentException("Room is not allowed.");
        return "https://" + ROOM_HOST + path + "?embed=hivemind";
    }

    /** True for about: documents and https URLs on the room hosts without userinfo or a port. */
    static boolean allowsNavigation(String destination) {
        try {
            URI uri = new URI(destination);
            if ("about".equalsIgnoreCase(uri.getScheme())) return true;
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getPort() == -1 && uri.getUserInfo() == null
                && uri.getHost() != null && ALLOWED_HOSTS.contains(uri.getHost().toLowerCase(java.util.Locale.ROOT));
        } catch (Exception ignored) {
            return false;
        }
    }

    /** True only for the secure Control session cookie scoped to singulancelabs.com. */
    static boolean isControlSessionCookie(String name, boolean secure, String domain) {
        if (!"hm_cp_session".equals(name) || !secure || domain == null) return false;
        String host = domain.startsWith(".") ? domain.substring(1) : domain;
        return host.equals("singulancelabs.com") || host.endsWith(".singulancelabs.com");
    }
}
