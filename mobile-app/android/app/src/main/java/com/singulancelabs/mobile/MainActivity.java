package com.singulancelabs.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;
        final Uri appOrigin = Uri.parse(bridge.getServerUrl() == null ? bridge.getLocalUrl() : bridge.getServerUrl());
        bridge.getWebView().setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return super.shouldOverrideUrlLoading(view, request);
                Uri uri = request.getUrl();
                if (NavigationPolicy.sameOrigin(uri.toString(), appOrigin.toString())) return super.shouldOverrideUrlLoading(view, request);
                // OAuth and external destinations never receive the privileged app WebView.
                String scheme = uri.getScheme();
                if ("https".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme) || "tel".equalsIgnoreCase(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (ActivityNotFoundException ignored) { /* Stay in the authenticated app. */ }
                }
                return true; // Reject HTTP, JavaScript, file and arbitrary intent/custom schemes.
            }
        });
    }
}
