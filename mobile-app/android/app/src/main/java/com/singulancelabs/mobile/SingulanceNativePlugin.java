package com.singulancelabs.mobile;

import android.content.Context;
import android.content.Intent;
import android.app.Activity;
import androidx.activity.result.ActivityResult;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.CookieManager;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.*;
import org.json.JSONObject;

@CapacitorPlugin(name="SingulanceNative")
public class SingulanceNativePlugin extends Plugin {
    private static final String KEY_ALIAS = "singulance.mobile.credentials.v1";
    private final ExecutorService executor = Executors.newFixedThreadPool(4);
    private final Map<String,WebSocket> streams = new ConcurrentHashMap<>();
    private final Set<String> reservedStreams = ConcurrentHashMap.newKeySet();
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).connectTimeout(15,TimeUnit.SECONDS).readTimeout(60,TimeUnit.SECONDS).pingInterval(30,TimeUnit.SECONDS).build();
    private SharedPreferences preferences;
    private final java.util.concurrent.atomic.AtomicBoolean saving = new java.util.concurrent.atomic.AtomicBoolean(false);
    @Override public void load() { preferences = getContext().getSharedPreferences("singulance.secure.v1", Context.MODE_PRIVATE); }
    private void requireTrusted() {
        String url = getBridge().getWebView().getUrl();
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || getBridge().getConfig().isUsingLegacyBridge() || getBridge().getServerUrl() != null || !NavigationPolicy.sameOrigin(url, "https://localhost")) throw new SecurityException("Native bridge requires the trusted packaged application.");
    }
    private String key(PluginCall call) {
        requireTrusted(); String key = call.getString("key");
        if (!"pendingAuth".equals(key) && !"cpToken".equals(key)) throw new IllegalArgumentException("Unknown credential key.");
        return key;
    }
    private synchronized javax.crypto.SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (javax.crypto.SecretKey)store.getKey(KEY_ALIAS, null);
    }
    private synchronized String readCredential(String key) throws Exception {
        String value = preferences.getString(key, null); if (value == null) return null;
        String[] parts = value.split("\\.", 2); if (parts.length != 2) throw new SecurityException("Credential is unavailable.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), new GCMParameterSpec(128, Base64.decode(parts[0],Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }
    @PluginMethod public void setCredential(PluginCall call) {
        try { String key=key(call), value=call.getString("value"); if(value==null || value.length()>16384) throw new IllegalArgumentException();
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,encryptionKey());
            String encrypted=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+"."+Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
            if (!preferences.edit().putString(key,encrypted).commit()) throw new IOException(); call.resolve();
        } catch(Exception ignored){ call.reject("Credential could not be stored."); }
    }
    @PluginMethod public void getCredential(PluginCall call) {
        try { String value=readCredential(key(call)); JSObject result=new JSObject();result.put("value",value==null?JSObject.NULL:value);call.resolve(result); }
        catch(Exception ignored){call.reject("Credential could not be read.");}
    }
    @PluginMethod public void removeCredential(PluginCall call) {
        try { String key=key(call); if(!preferences.edit().remove(key).commit())throw new IOException(); if("cpToken".equals(key)){CookieManager.getInstance().removeAllCookies(null);for(WebSocket socket:streams.values())socket.cancel();streams.clear();reservedStreams.clear();http.dispatcher().cancelAll();} call.resolve(); }
        catch(Exception ignored){call.reject("Credential could not be removed.");}
    }
    private Request requestOptions(PluginCall call) throws Exception {
        URI uri=NativeRequestPolicy.validate(call.getString("url"));
        String method=call.getString("method","GET");
        if(!Set.of("GET","HEAD","POST","PUT","PATCH","DELETE").contains(method))throw new IllegalArgumentException();
        if((uri.getPath().startsWith("/plugins/")||uri.getPath().startsWith("/assets/"))&&!Set.of("GET","HEAD").contains(method))throw new IllegalArgumentException("Resource requests are read-only.");
        Request.Builder request=new Request.Builder().url(uri.toString());
        JSObject headers=call.getObject("headers",new JSObject());
        Iterator<String> names=headers.keys();while(names.hasNext()){String name=names.next(); if(!Set.of("accept","content-type").contains(name.toLowerCase(Locale.ROOT)))throw new IllegalArgumentException("Header is not allowed.");String value=headers.getString(name);if(value==null||value.contains("\r")||value.contains("\n")||value.length()>256)throw new IllegalArgumentException();request.header(name,value);}
        if(call.getBoolean("authorize",false)){
            if(!"api.singulancelabs.com".equals(uri.getHost()))throw new SecurityException("Bearer credentials are only valid at the control API.");
            String token=readCredential("cpToken");if(token==null)throw new SecurityException("Sign in required.");request.header("Authorization","Bearer "+token);
        }
        if("next.singulancelabs.com".equals(uri.getHost())){
            request.header("Origin","https://next.singulancelabs.com");
            String cookie=CookieManager.getInstance().getCookie(uri.toString());if(cookie!=null)request.header("Cookie",cookie);
        }
        String body=call.getString("body"),encoding=call.getString("bodyEncoding","utf8");
        if(!Set.of("utf8","base64").contains(encoding))throw new IllegalArgumentException();
        if(body!=null && body.length()>12*1024*1024)throw new IllegalArgumentException("Request is too large.");
        byte[] content=body==null?null:("base64".equals(encoding)?Base64.decode(body,Base64.NO_WRAP):body.getBytes(StandardCharsets.UTF_8));
        if(content!=null&&content.length>8*1024*1024)throw new IllegalArgumentException("Request is too large.");
        RequestBody bytes=content==null ? null : RequestBody.create(content,MediaType.parse(headers.optString("Content-Type",headers.optString("content-type","application/json"))));
        if(Set.of("POST","PUT","PATCH").contains(method)&&bytes==null)bytes=RequestBody.create(new byte[0],null);
        return request.method(method,bytes).build();
    }
    private JSObject responseHeaders(Response response){
        JSObject result=new JSObject();for(String name:new String[]{"Content-Type","Content-Length","Content-Disposition","Retry-After"}){String value=response.header(name);if(value!=null)result.put(name.toLowerCase(Locale.ROOT),value);}
        if("next.singulancelabs.com".equals(response.request().url().host())){
            for(String cookie:response.headers("Set-Cookie"))CookieManager.getInstance().setCookie(response.request().url().toString(),cookie);
            CookieManager.getInstance().flush();
        }
        return result;
    }
    @PluginMethod public void request(PluginCall call){
        final Request request;try{requireTrusted();
            if(call.getBoolean("authorize",false)&&"api.singulancelabs.com".equals(NativeRequestPolicy.validate(call.getString("url")).getHost())&&readCredential("cpToken")==null){JSObject signedOut=new JSObject();signedOut.put("status",401);signedOut.put("headers",new JSObject());signedOut.put("data","{\"error\":\"signed_out\"}");call.resolve(signedOut);return;}
            request=requestOptions(call);}catch(Exception ignored){call.reject("Native request is not allowed.");return;}
        executor.execute(()->{try(Response response=http.newCall(request).execute()){
            JSObject result=new JSObject();result.put("status",response.code());result.put("headers",responseHeaders(response));
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();if(response.body()!=null)try(InputStream in=response.body().byteStream()){byte[] buf=new byte[8192];int read;while((read=in.read(buf))!=-1){if(bytes.size()+read>20*1024*1024)throw new IOException("Response is too large.");bytes.write(buf,0,read);}}
            String responseType=call.getString("responseType","text");if(!Set.of("text","base64").contains(responseType))throw new IllegalArgumentException();result.put("data","base64".equals(responseType)?Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP):bytes.toString(StandardCharsets.UTF_8.name()));result.put("encoding",responseType);call.resolve(result);
        }catch(Exception ignored){call.reject("Native request failed.");}});
    }
    private void event(String id,String type,String data){JSObject value=new JSObject();value.put("id",id);value.put("type",type);if(data!=null)value.put("data",data);notifyListeners("streamEvent",value);}
    @PluginMethod public void openStream(PluginCall call){
        final String id=call.getString("id"),endpoint=call.getString("endpoint");
        try{requireTrusted();if(id==null||!id.matches("[A-Za-z0-9_-]{1,80}")||endpoint==null||!endpoint.matches("[A-Za-z0-9_$.-]+(/[A-Za-z0-9_$.-]+)*")||reservedStreams.size()>=32||!reservedStreams.add(id))throw new IllegalArgumentException();}catch(Exception ignored){call.reject("Stream is not allowed.");return;}
        JSObject open=new JSObject();open.put("type","open");open.put("streamId",id);open.put("endpoint",endpoint);open.put("payload",call.getData().opt("payload")==null?JSONObject.NULL:call.getData().opt("payload"));
        if(open.toString().getBytes(StandardCharsets.UTF_8).length>8*1024*1024){reservedStreams.remove(id);call.reject("Stream payload is too large.");return;}
        Request.Builder request=new Request.Builder().url("wss://next.singulancelabs.com/api/remote.mux").header("Origin","https://next.singulancelabs.com");
        String cookie=CookieManager.getInstance().getCookie("https://next.singulancelabs.com/api/remote.mux");if(cookie!=null)request.header("Cookie",cookie);
        http.newWebSocket(request.build(),new WebSocketListener(){
            @Override public void onOpen(WebSocket socket,Response response){if(!reservedStreams.contains(id)){socket.cancel();return;}streams.put(id,socket);responseHeaders(response);socket.send(open.toString());event(id,"open",null);}
            @Override public void onMessage(WebSocket socket,String text){if(text.length()>8*1024*1024){socket.cancel();event(id,"error","Native stream frame is too large.");return;}event(id,"frame",text);}
            @Override public void onClosed(WebSocket socket,int code,String reason){streams.remove(id);reservedStreams.remove(id);event(id,"end",null);}
            @Override public void onFailure(WebSocket socket,Throwable error,Response response){streams.remove(id);reservedStreams.remove(id);event(id,"error","Native stream unavailable.");}
        });call.resolve();
    }
    @PluginMethod public void closeStream(PluginCall call){try{requireTrusted();String id=call.getString("id");reservedStreams.remove(id);WebSocket socket=streams.remove(id);if(socket!=null){socket.send("{\"type\":\"cancel\",\"streamId\":\""+id+"\"}");socket.close(1000,"cancelled");}call.resolve();}catch(Exception ignored){call.reject("Stream could not be closed.");}}
    @PluginMethod public void saveFile(PluginCall call) {
        try {
            requireTrusted(); if(!saving.compareAndSet(false,true)){call.reject("A file picker is already open.");return;} String name=call.getString("name"),mime=call.getString("mimeType","application/octet-stream"),data=call.getString("dataBase64");
            if(name==null||name.isBlank()||name.length()>160||name.contains("/")||name.contains("\\")||name.chars().anyMatch(c->c<32)||".".equals(name)||"..".equals(name)||!mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")||data==null||data.length()>28*1024*1024||data.length()%4!=0)throw new IllegalArgumentException();
            byte[] bytes=Base64.decode(data,Base64.NO_WRAP);if(bytes.length>20*1024*1024)throw new IllegalArgumentException("File is too large.");
            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType(mime);intent.putExtra(Intent.EXTRA_TITLE,name);
            startActivityForResult(call,intent,"savePicked");
        }catch(Exception ignored){saving.set(false);call.reject("File could not be saved. Choose a file smaller than 20 MiB.");}
    }
    @ActivityCallback private void savePicked(PluginCall call,ActivityResult result) {
        if(call==null){saving.set(false);return;}
        if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null){JSObject status=new JSObject();status.put("saved",false);saving.set(false);call.resolve(status);return;}
        final android.net.Uri uri=result.getData().getData();if(!"content".equals(uri.getScheme())){saving.set(false);call.reject("File picker destination is invalid.");return;}executor.execute(()->{try{
            byte[] bytes=Base64.decode(call.getString("dataBase64"),Base64.NO_WRAP);if(bytes.length>20*1024*1024)throw new IOException();
            try(OutputStream output=getContext().getContentResolver().openOutputStream(uri,"w")){if(output==null)throw new IOException();output.write(bytes);}
            JSObject status=new JSObject();status.put("saved",true);call.resolve(status);
        }catch(Exception ignored){call.reject("File could not be saved.");}finally{saving.set(false);}});
    }
    @Override protected void handleOnDestroy(){for(WebSocket socket:streams.values())socket.cancel();streams.clear();reservedStreams.clear();executor.shutdownNow();http.dispatcher().executorService().shutdown();http.connectionPool().evictAll();}
}
