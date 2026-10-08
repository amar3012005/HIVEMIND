package com.singulancelabs.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;

/** Runner-only cookie storage. Core authentication is exclusively native Bearer. */
final class RunnerCookieJar implements CookieJar {
    private static final String HOST = "next.singulancelabs.com";
    private final ConcurrentHashMap<String, Cookie> cookies = new ConcurrentHashMap<>();
    public void saveFromResponse(HttpUrl url, List<Cookie> values) {
        if (!HOST.equals(url.host())) return;
        for (Cookie cookie : values) {
            if (!HOST.equals(cookie.domain())) continue;
            String key = cookie.name() + "\n" + cookie.path();
            if (cookie.expiresAt() <= System.currentTimeMillis()) cookies.remove(key);
            else cookies.put(key, cookie);
        }
    }
    public List<Cookie> loadForRequest(HttpUrl url) {
        List<Cookie> result = new ArrayList<>();
        if (!HOST.equals(url.host())) return result;
        cookies.forEach((key, cookie) -> {
            if (cookie.expiresAt() <= System.currentTimeMillis()) cookies.remove(key, cookie);
            else if (cookie.matches(url)) result.add(cookie);
        });
        return result;
    }
    void clear() { cookies.clear(); }
}
