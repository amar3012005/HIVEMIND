package com.singulancelabs.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class NativeRequestPolicyTest {
    @Test public void approvedApiAndRunnerPathsAreAllowed() {
        for (String url : new String[]{"https://api.singulancelabs.com/auth/mobile/exchange", "https://api.singulancelabs.com/v1/session/status", "https://next.singulancelabs.com/api/hivemind/session/establish", "https://next.singulancelabs.com/api/Session.send"}) assertEquals(url,NativeRequestPolicy.validate(url).toString());
    }
    @Test public void arbitraryOriginsTraversalAndCredentialsAreRejected() {
        for (String url : new String[]{"http://api.singulancelabs.com/v1/session/status", "https://evil.example/v1/session/status", "https://api.singulancelabs.com.evil.example/v1/session/status", "https://user@api.singulancelabs.com/v1/session/status", "https://api.singulancelabs.com:444/v1/session/status", "https://api.singulancelabs.com/v1/%2e%2e/admin", "https://api.singulancelabs.com/v1/../admin", "https://api.singulancelabs.com/v1/session#token", "https://api.singulancelabs.com/admin", "https://next.singulancelabs.com/hivemind", "file:///etc/passwd", "javascript:alert(1)"}) {
            try { NativeRequestPolicy.validate(url); fail(url); } catch(IllegalArgumentException expected) {}
        }
    }
}
