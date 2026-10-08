package com.singulancelabs.mobile;
import java.net.URI;
import java.util.Set;
final class NativeRequestPolicy {
    static URI validate(String value) {
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IllegalArgumentException();
            String host = uri.getHost(), path = uri.getRawPath();
            if (!Set.of("api.singulancelabs.com", "next.singulancelabs.com").contains(host) || path == null || path.contains("%") || path.contains("\\") || path.contains("..") || path.contains("//")) throw new IllegalArgumentException();
            if ("api.singulancelabs.com".equals(host) ? !(path.startsWith("/auth/mobile/") || path.startsWith("/v1/")) : !(path.startsWith("/api/") || path.startsWith("/plugins/") || path.startsWith("/assets/"))) throw new IllegalArgumentException();
            return uri;
        } catch (Exception ignored) { throw new IllegalArgumentException("Native request destination is not allowed."); }
    }
}
