import Foundation
import UIKit
import Security
import WebKit
import Capacitor

@objc(SingulanceNativePlugin)
public class SingulanceNativePlugin: CAPPlugin, CAPBridgedPlugin, URLSessionTaskDelegate, UIDocumentPickerDelegate {
    public let identifier = "SingulanceNativePlugin"
    public let jsName = "SingulanceNative"
    public let pluginMethods: [CAPPluginMethod] = ["setCredential", "getCredential", "removeCredential", "request", "openStream", "closeStream", "saveFile"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private var saveCall: CAPPluginCall?
    private var saveURL: URL?
    private let service = "com.singulancelabs.mobile.credentials.v1"
    private var streams: [String: URLSessionWebSocketTask] = [:]
    private let streamLock = NSLock()
    private let cookies = URLSessionConfiguration.ephemeral.httpCookieStorage
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = cookies
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 60
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    private func trusted() -> Bool {
        guard let url = bridge?.webView?.url else { return false }
        return bridge?.config.serverURL == bridge?.config.localURL && url.scheme == "capacitor" && url.host == "localhost" && url.port == nil && url.user == nil && url.password == nil
    }
    private func key(_ call: CAPPluginCall) throws -> String {
        guard trusted(), let key = call.getString("key"), ["pendingAuth", "cpToken"].contains(key) else { throw NativeError.denied }
        return key
    }
    private func query(_ key: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key] }
    private func read(_ key: String) throws -> String? {
        var q = query(key); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw NativeError.denied }
        return value
    }
    @objc func setCredential(_ call: CAPPluginCall) {
        do {
            let key = try key(call)
            guard let value = call.getString("value"), value.utf8.count <= 16384 else { throw NativeError.denied }
            let q = query(key); SecItemDelete(q as CFDictionary)
            var item = q; item[kSecValueData as String] = Data(value.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NativeError.denied }
            call.resolve()
        } catch { call.reject("Credential could not be stored.") }
    }
    @objc func getCredential(_ call: CAPPluginCall) {
        do { let value = try read(key(call)); call.resolve(["value": value as Any? ?? NSNull()]) }
        catch { call.reject("Credential could not be read.") }
    }
    @objc func removeCredential(_ call: CAPPluginCall) {
        do {
            let key = try key(call); let status = SecItemDelete(query(key) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeError.denied }
            if key == "cpToken" {
                for cookie in cookies?.cookies ?? [] where cookie.domain == "next.singulancelabs.com" || cookie.domain == ".next.singulancelabs.com" { cookies?.deleteCookie(cookie) }
                streamLock.lock(); let active = Array(streams.values); streams.removeAll(); streamLock.unlock()
                for socket in active { socket.cancel(with: .goingAway, reason: nil) }
                session.getAllTasks { tasks in for task in tasks { task.cancel() } }
            }
            call.resolve()
        } catch { call.reject("Credential could not be removed.") }
    }
    private func allowedURL(_ value: String?) throws -> URL {
        guard let value = value, let url = URL(string: value), url.scheme == "https", url.user == nil, url.password == nil, url.fragment == nil, url.port == nil || url.port == 443,
              let host = url.host, ["api.singulancelabs.com", "next.singulancelabs.com"].contains(host),
              let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
              !path.contains("%"), !path.contains("\\"), !path.contains(".."), !path.contains("//"),
              host == "api.singulancelabs.com" ? (path.hasPrefix("/auth/mobile/") || path.hasPrefix("/v1/")) : (path.hasPrefix("/api/") || path.hasPrefix("/plugins/") || path.hasPrefix("/assets/")) else { throw NativeError.denied }
        return url
    }
    private func makeRequest(_ call: CAPPluginCall) throws -> URLRequest {
        guard trusted() else { throw NativeError.denied }
        let url = try allowedURL(call.getString("url")); var request = URLRequest(url: url)
        let method = call.getString("method") ?? "GET"
        guard ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { throw NativeError.denied }; request.httpMethod = method
        if url.path.hasPrefix("/plugins/") || url.path.hasPrefix("/assets/") { guard ["GET", "HEAD"].contains(method) else { throw NativeError.denied } }
        for (name, raw) in call.getObject("headers") ?? [:] {
            guard ["accept", "content-type"].contains(name.lowercased()), let value = raw as? String, !value.contains("\r"), !value.contains("\n"), value.count <= 256 else { throw NativeError.denied }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if call.getBool("authorize") == true {
            guard url.host == "api.singulancelabs.com", let token = try read("cpToken") else { throw NativeError.denied }
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        request.httpShouldHandleCookies = false
        if url.host == "next.singulancelabs.com" {
            request.setValue("https://next.singulancelabs.com", forHTTPHeaderField: "Origin")
            let runnerCookies = cookies?.cookies(for: url) ?? []
            for (name, value) in HTTPCookie.requestHeaderFields(with: runnerCookies) { request.setValue(value, forHTTPHeaderField: name) }
        }
        if let body = call.getString("body") {
            let encoding = call.getString("bodyEncoding") ?? "utf8"
            guard ["utf8", "base64"].contains(encoding), body.utf8.count <= 12 * 1024 * 1024 else { throw NativeError.denied }
            guard let bytes = encoding == "base64" ? Data(base64Encoded: body) : Data(body.utf8), bytes.count <= 8 * 1024 * 1024 else { throw NativeError.denied }
            request.httpBody = bytes
        }
        return request
    }
    @objc func request(_ call: CAPPluginCall) {
        do {
            guard trusted() else { throw NativeError.denied }
            if call.getBool("authorize") == true, try allowedURL(call.getString("url")).host == "api.singulancelabs.com", try read("cpToken") == nil {
                call.resolve(["status": 401, "headers": [:], "data": "{\"error\":\"signed_out\"}"]); return
            }
            let request = try makeRequest(call)
            session.dataTask(with: request) { data, response, error in
                guard error == nil, let response = response as? HTTPURLResponse, let data = data, data.count <= 20 * 1024 * 1024 else { call.reject("Native request failed."); return }
                if let url = response.url, url.host == "next.singulancelabs.com" {
                    var fields: [String: String] = [:]
                    for (key, value) in response.allHeaderFields { if let key = key as? String, let value = value as? String { fields[key] = value } }
                    for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) where cookie.domain == "next.singulancelabs.com" || cookie.domain == ".next.singulancelabs.com" { self.cookies?.setCookie(cookie) }
                }
                var headers: [String: String] = [:]
                for name in ["Content-Type", "Content-Length", "Content-Disposition", "Retry-After"] { if let value = response.value(forHTTPHeaderField: name) { headers[name.lowercased()] = value } }
                let responseType = call.getString("responseType") ?? "text"
                guard ["text", "base64"].contains(responseType) else { call.reject("Response type is invalid."); return }
                call.resolve(["status": response.statusCode, "headers": headers, "encoding": responseType, "data": responseType == "base64" ? data.base64EncodedString() : (String(data: data, encoding: .utf8) ?? "")])
            }.resume()
        } catch { call.reject("Native request is not allowed.") }
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    private func event(_ id: String, _ type: String, _ data: String? = nil) {
        var event: [String: Any] = ["id": id, "type": type]; if let data = data { event["data"] = data }; notifyListeners("streamEvent", data: event)
    }
    @objc func openStream(_ call: CAPPluginCall) {
        guard trusted(), let id = call.getString("id"), id.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
              let endpoint = call.getString("endpoint"), endpoint.range(of: "^[A-Za-z0-9_$.-]+(/[A-Za-z0-9_$.-]+)*$", options: .regularExpression) != nil else { call.reject("Stream is not allowed."); return }
        var request = URLRequest(url: URL(string: "wss://next.singulancelabs.com/api/remote.mux")!)
        request.httpShouldHandleCookies = false
        request.setValue("https://next.singulancelabs.com", forHTTPHeaderField: "Origin")
        let runnerCookies = cookies?.cookies(for: URL(string: "https://next.singulancelabs.com/api/remote.mux")!) ?? []
        for (name, value) in HTTPCookie.requestHeaderFields(with: runnerCookies) { request.setValue(value, forHTTPHeaderField: name) }
        streamLock.lock(); guard streams[id] == nil && streams.count < 32 else { streamLock.unlock(); call.reject("Stream already exists."); return }
        let socket = session.webSocketTask(with: request); streams[id] = socket; streamLock.unlock()
        let open: [String: Any] = ["type": "open", "streamId": id, "endpoint": endpoint, "payload": call.options["payload"] ?? NSNull()]
        guard let bytes = try? JSONSerialization.data(withJSONObject: open), bytes.count <= 8 * 1024 * 1024, let text = String(data: bytes, encoding: .utf8) else { call.reject("Stream payload is invalid."); close(id); return }
        socket.maximumMessageSize = 8 * 1024 * 1024; socket.resume()
        socket.send(.string(text)) { error in if error != nil { self.event(id, "error", "Native stream unavailable."); self.close(id) } }
        receive(id, socket); call.resolve()
    }
    private func receive(_ id: String, _ socket: URLSessionWebSocketTask) {
        socket.receive { result in
            switch result {
            case .success(.string(let text)): self.event(id, "frame", text); self.receive(id, socket)
            case .success(.data(_)): self.event(id, "error", "Unexpected binary stream frame."); self.close(id)
            case .failure: self.event(id, "error", "Native stream unavailable."); self.close(id)
            @unknown default: self.close(id)
            }
        }
    }
    private func close(_ id: String) {
        streamLock.lock(); let socket = streams.removeValue(forKey: id); streamLock.unlock()
        guard let socket = socket else { return }
        let cancel: [String: Any] = ["type": "cancel", "streamId": id]
        if let bytes = try? JSONSerialization.data(withJSONObject: cancel), let text = String(data: bytes, encoding: .utf8) {
            socket.send(.string(text)) { _ in socket.cancel(with: .normalClosure, reason: nil) }
        } else { socket.cancel(with: .normalClosure, reason: nil) }
    }
    @objc func closeStream(_ call: CAPPluginCall) { guard trusted(), let id = call.getString("id") else { call.reject("Stream could not be closed."); return }; close(id); call.resolve() }
    @objc func saveFile(_ call: CAPPluginCall) {
        guard trusted(), saveCall == nil, let name = call.getString("name"), !name.isEmpty, name.count <= 160,
              !name.contains("/"), !name.contains("\\"), name != ".", name != "..", !name.unicodeScalars.contains(where: { $0.value < 32 }),
              let encoded = call.getString("dataBase64"), encoded.count <= 28 * 1024 * 1024,
              let bytes = Data(base64Encoded: encoded), bytes.count <= 20 * 1024 * 1024 else { call.reject("File could not be saved. Choose a file smaller than 20 MiB."); return }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(name); try bytes.write(to: url, options: [.atomic, .completeFileProtection])
            saveCall = call; saveURL = url
            DispatchQueue.main.async {
                let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true); picker.delegate = self
                guard let controller = self.bridge?.viewController else { self.finishSave(false, "File picker is unavailable."); return }
                controller.present(picker, animated: true)
            }
        } catch { try? FileManager.default.removeItem(at: folder); call.reject("File could not be saved.") }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finishSave(!urls.isEmpty) }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishSave(false) }
    private func finishSave(_ saved: Bool, _ error: String? = nil) {
        let call = saveCall; let url = saveURL; saveCall = nil; saveURL = nil
        if let url = url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        if let error = error { call?.reject(error) } else { call?.resolve(["saved": saved]) }
    }
    enum NativeError: Error { case denied }
}

private class TrustedFrameHandler: NSObject, WKScriptMessageHandler {
    private let delegate: WKScriptMessageHandler
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
              url.scheme == "capacitor", url.host == "localhost", url.port == nil, url.user == nil else { return }
        delegate.userContentController(userContentController, didReceive: message)
    }
}
class SingulanceViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SingulanceNativePlugin())
        // The stock WK script handler can be addressed by iframes even though its
        // helper script is main-frame-only. Filter the native message boundary itself.
        if let capBridge = bridge as? CapacitorBridge, let controller = bridge?.webView?.configuration.userContentController {
            controller.removeScriptMessageHandler(forName: "bridge")
            controller.add(TrustedFrameHandler(capBridge.webViewDelegationHandler), name: "bridge")
        }
    }
}
