package com.singulancelabs.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Arrays;
import java.util.List;

public class MainActivity extends BridgeActivity {

    // Google explicitly rejects/blocks OAuth consent inside an embedded
    // WebView — the app-review guideline, not just a UX preference. Slack
    // and other providers don't hard-block it the same way, but routing
    // every OAuth host through the system browser is the one pattern
    // every provider accepts, so it's simplest to do it uniformly rather
    // than special-case per provider. The web app itself (same JS as the
    // desktop/browser build) is unaware of this — it just does
    // window.location.href = auth_url like it always has; this intercepts
    // that navigation at the native layer instead of requiring a mobile-
    // specific JS change to the shared web app.
    private static final List<String> OAUTH_HOSTS = Arrays.asList(
        "accounts.google.com",
        "slack.com",
        "github.com",
        "login.microsoftonline.com",
        "linkedin.com"
    );

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;

        WebView webView = bridge.getWebView();
        webView.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host != null) {
                    for (String oauthHost : OAUTH_HOSTS) {
                        if (host.equals(oauthHost) || host.endsWith("." + oauthHost)) {
                            startActivity(new Intent(Intent.ACTION_VIEW, uri));
                            return true; // handled — block the embedded WebView from loading it
                        }
                    }
                }
                return super.shouldOverrideUrlLoading(view, request); // preserve Capacitor's own routing
            }
        });
    }
}
