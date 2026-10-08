package com.singulancelabs.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.List;
import okhttp3.Cookie;
import okhttp3.HttpUrl;
public class RunnerCookieJarTest {
    private final HttpUrl runner = HttpUrl.get("https://next.singulancelabs.com/api/remote.mux");
    private final HttpUrl core = HttpUrl.get("https://api.singulancelabs.com/v1/session/status");
    @Test public void isolatesCoreAndAncestorCookies() {
        RunnerCookieJar jar = new RunnerCookieJar();
        Cookie valid = Cookie.parse(runner,"session=runner; Secure; HttpOnly; Path=/");
        jar.saveFromResponse(core,List.of(valid));
        assertTrue(jar.loadForRequest(runner).isEmpty());
        jar.saveFromResponse(runner,List.of(Cookie.parse(runner,"session=core; Domain=singulancelabs.com; Path=/")));
        assertTrue(jar.loadForRequest(runner).isEmpty());
        jar.saveFromResponse(runner,List.of(valid));
        assertEquals("runner",jar.loadForRequest(runner).get(0).value());
        assertTrue(jar.loadForRequest(core).isEmpty());
        jar.clear(); assertTrue(jar.loadForRequest(runner).isEmpty());
    }
    @Test public void expiryRemovesExistingCookie() {
        RunnerCookieJar jar = new RunnerCookieJar();
        jar.saveFromResponse(runner,List.of(Cookie.parse(runner,"session=ok; Path=/")));
        jar.saveFromResponse(runner,List.of(Cookie.parse(runner,"session=gone; Max-Age=0; Path=/")));
        assertTrue(jar.loadForRequest(runner).isEmpty());
    }
}
