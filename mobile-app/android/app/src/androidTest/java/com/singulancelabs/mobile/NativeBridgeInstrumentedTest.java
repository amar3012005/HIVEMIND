package com.singulancelabs.mobile;

import android.webkit.WebView;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeBridgeInstrumentedTest {
    private String evaluate(ActivityScenario<MainActivity> activity,String script) throws Exception {
        CountDownLatch ready=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>();
        activity.onActivity(app -> app.getBridge().getWebView().evaluateJavascript(script,result -> {value.set(result);ready.countDown();}));
        assertTrue("JavaScript evaluation timed out",ready.await(20,TimeUnit.SECONDS));return value.get();
    }
    private void waitResult(ActivityScenario<MainActivity> activity,String script,String expected) throws Exception {
        long until=System.currentTimeMillis()+60000;while(System.currentTimeMillis()<until){String result=evaluate(activity,script);if(expected.equals(result))return;Thread.sleep(500);}fail("Expected "+expected+", got "+evaluate(activity,script));
    }
    @Test public void secureCredentialsAndSignedOutNativeRequestWork() throws Exception {
        try(ActivityScenario<MainActivity> activity=ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(app -> app.getBridge().getWebView().loadUrl("https://localhost/native-smoke.html"));
            waitResult(activity,"typeof window.nativeSmoke","\"function\"");
            evaluate(activity,"window.nativeSmoke();'started'");
            waitResult(activity,"window.nativeSmokeResult || window.nativeSmokeError","\"passed\"");
        }
    }
    @Test public void sandboxFrameCannotInvokeSecureNativePlugin() throws Exception {
        try(ActivityScenario<MainActivity> activity=ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(app -> app.getBridge().getWebView().loadUrl("https://localhost/native-smoke.html"));
            waitResult(activity,"typeof window.nativeSmoke","\"function\"");
            evaluate(activity,"(async()=>{await Capacitor.nativePromise('SingulanceNative','removeCredential',{key:'pendingAuth'});window.frameTestReady=true})()");
            waitResult(activity,"window.frameTestReady","true");
            evaluate(activity,"(()=>{window.addEventListener('message',e=>{if(e.data==='attempted')window.frameAttempted=true});let frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.srcdoc='<script>try{window.androidBridge.postMessage(JSON.stringify({callbackId:\"evil\",pluginId:\"SingulanceNative\",methodName:\"setCredential\",options:{key:\"pendingAuth\",value:\"attacker\"}}))}catch(e){}parent.postMessage(\"attempted\",\"*\")<\\/script>';document.body.append(frame);return 'mounted'})()");
            waitResult(activity,"window.frameAttempted","true");
            evaluate(activity,"(async()=>{window.frameDenied=(await Capacitor.nativePromise('SingulanceNative','getCredential',{key:'pendingAuth'})).value===null})()");
            waitResult(activity,"window.frameDenied","true");
        }
    }
    @Test public void savingUsesTheSystemDocumentPickerAndCancellationResolves() throws Exception {
        try(ActivityScenario<MainActivity> activity=ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(app -> app.getBridge().getWebView().loadUrl("https://localhost/native-smoke.html"));
            waitResult(activity,"typeof window.nativeSmoke","\"function\"");
            evaluate(activity,"Capacitor.nativePromise('SingulanceNative','saveFile',{name:'native-smoke.txt',mimeType:'text/plain',dataBase64:'c21va2U='}).then(value=>window.saveResult=value.saved)");
            long until=System.currentTimeMillis()+30000;boolean seen=false;while(System.currentTimeMillis()<until){AccessibilityNodeInfo root=InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();if(root!=null && String.valueOf(root.getPackageName()).contains("documentsui")){seen=true;break;}Thread.sleep(500);}assertTrue("System document picker was not presented",seen);
            InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand("input keyevent 4").close();
            waitResult(activity,"window.saveResult","false");
        }
    }
}
