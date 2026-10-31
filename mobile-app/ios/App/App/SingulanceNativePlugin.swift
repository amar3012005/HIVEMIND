import Foundation
import UIKit
import Security
import WebKit
import Capacitor
import AuthenticationServices

@objc(SingulanceNativePlugin)
public class SingulanceNativePlugin: CAPPlugin, CAPBridgedPlugin, URLSessionTaskDelegate, UIDocumentPickerDelegate, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "SingulanceNativePlugin"
    public let jsName = "SingulanceNative"
    public let pluginMethods: [CAPPluginMethod] = ["authenticate", "setCredential", "getCredential", "removeCredential", "request", "openStream", "closeStream", "saveFile", "getAppearance", "workspaceAccess", "openRoom", "closeRoom"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private var authenticationSession: ASWebAuthenticationSession?
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge!.viewController!.view.window!
    }
    @objc func authenticate(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.trusted(), self.authenticationSession == nil,
                  let url = try? self.allowedURL(call.getString("url")),
                  url.host == "api.singulancelabs.com", url.path == "/auth/mobile/start",
                  self.bridge?.viewController?.view.window != nil else {
                call.reject("Sign-in could not start."); return
            }
            let authentication = ASWebAuthenticationSession(url: url, callbackURLScheme: "singulance") { callback, error in
                self.authenticationSession = nil
                guard error == nil, let callback = callback else { call.reject("Sign-in was cancelled or failed."); return }
                call.resolve(["url": callback.absoluteString])
            }
            authentication.presentationContextProvider = self
            self.authenticationSession = authentication
            if !authentication.start() { self.authenticationSession = nil; call.reject("Sign-in could not start.") }
        }
    }
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
        if !Thread.isMainThread {
            return DispatchQueue.main.sync { self.trusted() }
        }
        guard let url = bridge?.webView?.url else { return false }
        return bridge?.config.serverURL == bridge?.config.localURL && url.scheme == "capacitor" && url.host == "localhost" && url.port == nil && url.user == nil && url.password == nil
    }
    private func key(_ call: CAPPluginCall) throws -> String {
        guard trusted(), let key = call.getString("key"), ["pendingAuth", "cpToken"].contains(key) else { throw NativeError.denied }
        return key
    }
    private func query(_ key: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key] }
    @objc func getAppearance(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.trusted() else {
                call.reject("Appearance settings require the packaged application."); return
            }
            call.resolve([
                "platform": "ios",
                "reduceMotion": UIAccessibility.isReduceMotionEnabled,
                "reduceTransparency": UIAccessibility.isReduceTransparencyEnabled,
                "increaseContrast": UIAccessibility.isDarkerSystemColorsEnabled
            ])
        }
    }
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
              host == "api.singulancelabs.com" ? (path.hasPrefix("/auth/mobile/") || path == "/auth/session" || path == "/auth/email/config" || path.hasPrefix("/v1/")) : (path.hasPrefix("/api/") || path.hasPrefix("/plugins/") || path.hasPrefix("/assets/")) else { throw NativeError.denied }
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
    // OpenDot employee rooms are a separate web application (https://runtime-runner.singulancelabs.com) that
    // refuses to be framed by capacitor://localhost and authenticates a Control session cookie. The room
    // therefore opens in its own top-level WKWebView with an isolated data store. The cookie is Control's own
    // Set-Cookie for the stored bearer (GET /auth/session); it goes from this class to that web view and
    // never reaches JavaScript, the Keychain or the Runner cookie jar.
    private let roomHost = "runtime-runner.singulancelabs.com"
    private var room: RoomViewController?
    private func controlCookie(_ completion: @escaping (HTTPCookie?) -> Void) {
        guard let token = try? read("cpToken"), let url = URL(string: "https://api.singulancelabs.com/auth/session") else { completion(nil); return }
        var request = URLRequest(url: url)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        session.dataTask(with: request) { _, response, error in
            guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200 else { completion(nil); return }
            var fields: [String: String] = [:]
            for (key, value) in http.allHeaderFields { if let key = key as? String, let value = value as? String { fields[key] = value } }
            completion(HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).first { $0.name == "hm_cp_session" && $0.isSecure })
        }.resume()
    }
    /// Asks the existing workspace-access endpoint (feature flag plus account grant) for the signed-in account and returns only its verdict.
    @objc func workspaceAccess(_ call: CAPPluginCall) {
        guard trusted() else { call.reject("Workspace access could not be checked."); return }
        controlCookie { cookie in
            guard let cookie = cookie, let url = URL(string: "https://next.singulancelabs.com/__hivemind/account-mode-access") else { call.resolve(["status": 401]); return }
            var request = URLRequest(url: url)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.httpShouldHandleCookies = false
            for (name, value) in HTTPCookie.requestHeaderFields(with: [cookie]) { request.setValue(value, forHTTPHeaderField: name) }
            self.session.dataTask(with: request) { data, response, error in
                guard error == nil, let http = response as? HTTPURLResponse else { call.reject("Workspace access could not be checked."); return }
                let enabled = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["enabled"] as? Bool
                call.resolve(enabled == nil ? ["status": http.statusCode] : ["status": http.statusCode, "enabled": enabled!])
            }.resume()
        }
    }
    @objc func openRoom(_ call: CAPPluginCall) {
        guard trusted(), let path = call.getString("path"),
              path.range(of: "^/employees/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", options: .regularExpression) != nil,
              let url = URL(string: "https://" + roomHost + path + "?embed=hivemind") else { call.reject("Room is not allowed."); return }
        controlCookie { cookie in
            DispatchQueue.main.async {
                guard let cookie = cookie else { call.reject("Room could not open."); return }
                if let open = self.room { open.show(url, cookie: cookie); call.resolve(); return }
                guard let presenter = self.bridge?.viewController else { call.reject("Room could not open."); return }
                let controller = RoomViewController(allowedHosts: [self.roomHost, "dots.singulancelabs.com"]) { [weak self] in
                    self?.room = nil
                    self?.notifyListeners("roomClosed", data: [:])
                }
                self.room = controller
                controller.modalPresentationStyle = .fullScreen
                presenter.present(controller, animated: true) { controller.show(url, cookie: cookie); call.resolve() }
            }
        }
    }
    @objc func closeRoom(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.trusted() else { call.reject("Room could not close."); return }
            self.room?.closeSilently()
            self.room = nil
            call.resolve()
        }
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
/// Full-screen host for one OpenDot room: isolated storage, https navigation limited to the room's own hosts, no new windows.
private final class RoomViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let allowedHosts: [String]
    private let onClose: () -> Void
    private var silent = false
    private let webView: WKWebView
    init(allowedHosts: [String], onClose: @escaping () -> Void) {
        self.allowedHosts = allowedHosts
        self.onClose = onClose
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.98, green: 0.976, blue: 0.957, alpha: 1)
        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        done.accessibilityIdentifier = "room-done"
        done.addTarget(self, action: #selector(finish), for: .touchUpInside)
        done.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(done)
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            done.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            done.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            done.heightAnchor.constraint(equalToConstant: 36),
            webView.topAnchor.constraint(equalTo: done.bottomAnchor, constant: 4),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }
    func show(_ url: URL, cookie: HTTPCookie) {
        loadViewIfNeeded()
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { self.webView.load(URLRequest(url: url)) }
    }
    func closeSilently() { silent = true; webView.stopLoading(); dismiss(animated: true) }
    @objc private func finish() { webView.stopLoading(); dismiss(animated: true) { self.onClose() } }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let allowed = url.scheme == "about" || (url.scheme == "https" && url.port == nil && allowedHosts.contains(url.host ?? ""))
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
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
