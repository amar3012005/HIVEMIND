package com.singulancelabs.mobile;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import java.util.Set;

/** Maps the shared haptic kinds to predefined view feedback; the system touch-feedback setting still applies (no ignore-global flag). */
final class Haptics {
    static final Set<String> KINDS = Set.of("light", "soft", "warning", "success", "selection", "error");

    static boolean allows(String kind) { return kind != null && KINDS.contains(kind); }

    /** Plays `kind` on `view`; call on the UI thread. Returns false for an unknown kind. */
    static boolean play(View view, String kind) {
        if (view == null || !allows(kind)) return false;
        boolean r = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        int effect;
        switch (kind) {
            case "light": effect = HapticFeedbackConstants.KEYBOARD_TAP; break;
            case "soft":
            case "selection": effect = HapticFeedbackConstants.CLOCK_TICK; break;
            case "success": effect = r ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK; break;
            case "warning": effect = r ? HapticFeedbackConstants.GESTURE_END : HapticFeedbackConstants.CONTEXT_CLICK; break;
            default: effect = r ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS; break;
        }
        view.performHapticFeedback(effect);
        return true;
    }
}
