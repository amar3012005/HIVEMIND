package com.singulancelabs.mobile;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.lang.ref.WeakReference;

/**
 * Full-screen host for one OpenDot room. It is a separate activity with a WebView that has no
 * JavaScript interface and no native bridge, navigation limited to RoomPolicy hosts, no new
 * windows, and cookies, storage and cache wiped when it closes. The Control session cookie is
 * placed by the plugin and never reaches JavaScript of the packaged app.
 */
public class RoomActivity extends AppCompatActivity {
    static final String EXTRA_URL = "url";
    private static WeakReference<RoomActivity> current = new WeakReference<>(null);
    private static Runnable closedListener;
    private WebView webView;
    private boolean silent;

        static void closeSilently() {
        RoomActivity open = current.get();
        if (open != null) { open.silent = true; open.finish(); }
    }
    /** Stores the Control cookie for the room hosts, then starts the room or reuses the open one; `opened` runs on the UI thread. */
    static void open(android.app.Activity host, String url, String setCookie, Runnable closed, Runnable opened) {
        CookieManager manager = CookieManager.getInstance();
        manager.setAcceptCookie(true);
        manager.setCookie("https://api.singulancelabs.com/", setCookie, stored -> {
            manager.flush();
            host.runOnUiThread(() -> {
                closedListener = closed;
                RoomActivity open = current.get();
                if (open != null && open.webView != null) open.webView.loadUrl(url);
                else host.startActivity(new android.content.Intent(host, RoomActivity.class).putExtra(EXTRA_URL, url));
                opened.run();
            });
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);
        String url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null || !RoomPolicy.allowsNavigation(url)) { silent = true; finish(); return; }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(250, 249, 244));
        Button done = new Button(this);
        done.setText("Done");
        done.setContentDescription("room-done");
        done.setAllCaps(false);
        done.setOnClickListener(view -> finish());
        root.addView(done, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        ((LinearLayout.LayoutParams) done.getLayoutParams()).gravity = Gravity.START;
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSaveFormData(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !RoomPolicy.allowsNavigation(request.getUrl().toString());
            }
        });
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        // Edge-to-edge: keep Done and the page clear of the system bars and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack(); else finish();
            }
        });
        webView.loadUrl(url);
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.clearHistory();
            webView.clearCache(true);
            webView.destroy();
            webView = null;
        }
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(null);
        cookies.flush();
        WebStorage.getInstance().deleteAllData();
        if (current.get() == this) current = new WeakReference<>(null);
        boolean notify = !silent && isFinishing();
        super.onDestroy();
        Runnable listener = closedListener;
        if (notify && listener != null) listener.run();
    }
}
