package com.singulancelabs.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class NavigationPolicyTest {
    private final String app = "https://localhost";
    @Test public void applicationOriginIsAllowed() {
        assertTrue(NavigationPolicy.sameOrigin("https://localhost/hivemind/m/chat?room=1", app));
        assertTrue(NavigationPolicy.sameOrigin("https://LOCALHOST/hivemind/m/chat", app));
    }
    @Test public void externalAndDeceptiveOriginsAreRejected() {
        for (String value : new String[] {"https://accounts.google.com", "https://localhost.evil.example/", "https://localhost@evil.example/", "https://evil@localhost/", "http://localhost/", "https://localhost:444/", "javascript:alert(1)", "file:///etc/passwd", "intent://localhost/", "singulance://auth/callback", "not a url"}) {
            assertFalse(value, NavigationPolicy.sameOrigin(value, app));
        }
    }
}
