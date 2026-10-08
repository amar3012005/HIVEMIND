package com.singulancelabs.mobile;

import java.net.URI;
import java.net.URISyntaxException;

/** Only exact app-origin documents may keep access to the Capacitor bridge. */
final class NavigationPolicy {
    static boolean sameOrigin(String destination, String appOrigin) {
        try {
            URI uri = new URI(destination);
            URI origin = new URI(appOrigin);
            return uri.getScheme() != null && uri.getScheme().equalsIgnoreCase(origin.getScheme())
                && uri.getHost() != null && uri.getHost().equalsIgnoreCase(origin.getHost())
                && uri.getPort() == origin.getPort() && uri.getUserInfo() == null;
        } catch (URISyntaxException | NullPointerException ignored) {
            return false;
        }
    }
}
