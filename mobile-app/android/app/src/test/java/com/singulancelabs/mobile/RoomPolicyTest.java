package com.singulancelabs.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class RoomPolicyTest {
    private static final String ID = "123e4567-e89b-12d3-a456-426614174000";
    @Test public void acceptsOnlyEmployeeUuidPaths() {
        assertEquals("https://runtime-runner.singulancelabs.com/employees/" + ID + "?embed=hivemind", RoomPolicy.roomUrl("/employees/" + ID));
        for (String bad : new String[]{null, "", "/employees/", "/employees/abc", "/employees/" + ID + "/", "/employees/" + ID + "?x=1", "/employees/" + ID + "/../x", "//evil.com/employees/" + ID, "https://evil.com/employees/" + ID, "/admin"}) {
            try { RoomPolicy.roomUrl(bad); fail("accepted " + bad); } catch (IllegalArgumentException expected) { /* rejected */ }
        }
    }
    @Test public void navigationIsLimitedToRoomHosts() {
        assertTrue(RoomPolicy.allowsNavigation("https://runtime-runner.singulancelabs.com/employees/" + ID));
        assertTrue(RoomPolicy.allowsNavigation("https://dots.singulancelabs.com/x"));
        assertTrue(RoomPolicy.allowsNavigation("about:blank"));
        assertFalse(RoomPolicy.allowsNavigation("http://runtime-runner.singulancelabs.com/"));
        assertFalse(RoomPolicy.allowsNavigation("https://runtime-runner.singulancelabs.com:8443/"));
        assertFalse(RoomPolicy.allowsNavigation("https://runtime-runner.singulancelabs.com@evil.com/"));
        assertFalse(RoomPolicy.allowsNavigation("https://evil.com/runtime-runner.singulancelabs.com"));
        assertFalse(RoomPolicy.allowsNavigation("https://next.singulancelabs.com/"));
        assertFalse(RoomPolicy.allowsNavigation("javascript:alert(1)"));
        assertFalse(RoomPolicy.allowsNavigation("intent://x#Intent;end"));
        assertFalse(RoomPolicy.allowsNavigation("file:///etc/passwd"));
        assertFalse(RoomPolicy.allowsNavigation("not a url"));
    }
    @Test public void onlyTheSecureControlSessionCookieQualifies() {
        assertTrue(RoomPolicy.isControlSessionCookie("hm_cp_session", true, ".singulancelabs.com"));
        assertTrue(RoomPolicy.isControlSessionCookie("hm_cp_session", true, "singulancelabs.com"));
        assertFalse(RoomPolicy.isControlSessionCookie("hm_cp_session", false, "singulancelabs.com"));
        assertFalse(RoomPolicy.isControlSessionCookie("other", true, "singulancelabs.com"));
        assertFalse(RoomPolicy.isControlSessionCookie("hm_cp_session", true, "evilsingulancelabs.com"));
        assertFalse(RoomPolicy.isControlSessionCookie("hm_cp_session", true, null));
    }
}
