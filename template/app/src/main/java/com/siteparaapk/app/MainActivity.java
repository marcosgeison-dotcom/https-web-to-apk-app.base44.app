package com.siteparaapk.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends Activity {

    private WebView webView;
    private JSONObject config = new JSONObject();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        config = readConfig();
        setContentView(R.layout.activity_main);

        webView = (WebView) findViewById(R.id.webview);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(config.optBoolean("enable_js", true));
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        if (config.optBoolean("offline_cache")) {
            s.setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        }

        try {
            getWindow().setStatusBarColor(Color.parseColor(config.optString("status_bar_color", "#2563EB")));
        } catch (Exception ignored) {
        }

        String mode = config.optString("display_mode", "navbar");
        if ("fullscreen".equals(mode) || "immersive".equals(mode)) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                    WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (config.optBoolean("external_links_browser", true)) {
                    try {
                        Uri uri = Uri.parse(url);
                        String siteHost = Uri.parse(config.optString("site_url", "")).getHost();
                        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                        if (siteHost != null && uri.getHost() != null
                                && !uri.getHost().equalsIgnoreCase(siteHost)
                                && ("http".equals(scheme) || "https".equals(scheme))) {
                            startActivity(new Intent(Intent.ACTION_VIEW, uri));
                            return true;
                        }
                    } catch (Exception ignored) {
                    }
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                String css = config.optString("custom_css", "");
                if (!css.isEmpty()) {
                    view.evaluateJavascript(
                            "(function(){var s=document.createElement('style');s.textContent="
                                    + JSONObject.quote(css) + ";document.head.appendChild(s);})();", null);
                }
                String js = config.optString("custom_js", "");
                if (!js.isEmpty()) {
                    view.evaluateJavascript(js, null);
                }
            }
        });

        if (config.optBoolean("allow_downloads", true)) {
            webView.setDownloadListener(new DownloadListener() {
                @Override
                public void onDownloadStart(String url, String userAgent,
                                            String contentDisposition, String mimeType, long contentLength) {
                    try {
                        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                        request.setNotificationVisibility(
                                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                        dm.enqueue(request);
                        Toast.makeText(MainActivity.this, "Baixando arquivo...", Toast.LENGTH_SHORT).show();
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        webView.loadUrl(config.optString("site_url", "https://example.com"));
    }

    private JSONObject readConfig() {
        try (InputStream is = getAssets().open("config.json")) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = is.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return new JSONObject(bos.toString("UTF-8"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}