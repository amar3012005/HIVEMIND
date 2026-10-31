import Foundation
import UIKit
import Security
import WebKit
import Capacitor
import AuthenticationServices
import CryptoKit

@objc(SingulanceNativePlugin)
public class SingulanceNativePlugin: CAPPlugin, CAPBridgedPlugin, URLSessionTaskDelegate, UIDocumentPickerDelegate, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "SingulanceNativePlugin"
    public let jsName = "SingulanceNative"
    public let pluginMethods: [CAPPluginMethod] = ["authenticate", "setCredential", "getCredential", "removeCredential", "request", "openStream", "closeStream", "saveFile", "getAppearance", "workspaceAccess", "openRoom", "closeRoom", "prewarmRoom", "getPreference", "setPreference", "removePreference"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
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
    /// Runtime-host session cookies (set by its session admission), held in memory apart from the Brain runner's.
    private let runtimeCookies = URLSessionConfiguration.ephemeral.httpCookieStorage
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
    /// Small non-secret settings that must survive a WebView data purge and an app reinstall (the Keychain keeps them).
    private let preferenceKeys = ["privacyChoice"]
    private func preferenceKey(_ call: CAPPluginCall) throws -> String {
        guard trusted(), let key = call.getString("key"), preferenceKeys.contains(key) else { throw NativeError.denied }
        return "preference." + key
    }
    @objc func getPreference(_ call: CAPPluginCall) {
        do { let value = try read(preferenceKey(call)); call.resolve(["value": value as Any? ?? NSNull()]) }
        catch { call.reject("Preference could not be read.") }
    }
    @objc func setPreference(_ call: CAPPluginCall) {
        do {
            let key = try preferenceKey(call)
            guard let value = call.getString("value"), value.utf8.count <= 4096 else { throw NativeError.denied }
            let q = query(key); SecItemDelete(q as CFDictionary)
            var item = q; item[kSecValueData as String] = Data(value.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw NativeError.denied }
            call.resolve()
        } catch { call.reject("Preference could not be stored.") }
    }
    @objc func removePreference(_ call: CAPPluginCall) {
        do {
            let status = SecItemDelete(query(try preferenceKey(call)) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeError.denied }
            call.resolve()
        } catch { call.reject("Preference could not be removed.") }
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
            if key == "cpToken" { prewarmLastRoom() }
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
                controlSessionLock.lock(); controlSession = nil; controlSessionLock.unlock()
                for cookie in runtimeCookies?.cookies ?? [] { runtimeCookies?.deleteCookie(cookie) }
                UserDefaults.standard.removeObject(forKey: Self.lastRoomPathKey); UserDefaults.standard.removeObject(forKey: Self.lastRoomScopeKey)
                DispatchQueue.main.async {
                    self.room?.closeSilently(forgetSession: true); self.room = nil
                    self.discardWarmRoom()
                    RoomViewController.removeStores(keeping: nil)
                    RoomViewController.removeSiteData(hosts: self.roomDataHosts)
                }
            }
            call.resolve()
        } catch { call.reject("Credential could not be removed.") }
    }
    private func allowedURL(_ value: String?) throws -> URL {
        guard let value = value, let url = URL(string: value), url.scheme == "https", url.user == nil, url.password == nil, url.fragment == nil, url.port == nil || url.port == 443,
              let host = url.host, ["api.singulancelabs.com", "next.singulancelabs.com", "runtime-runner.singulancelabs.com"].contains(host),
              let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
              !path.contains("%"), !path.contains("\\"), !path.contains(".."), !path.contains("//"),
              host == "api.singulancelabs.com" ? (path.hasPrefix("/auth/mobile/") || path == "/auth/session" || path == "/auth/email/config" || path.hasPrefix("/v1/")) : host == "runtime-runner.singulancelabs.com" ? path.hasPrefix("/api/") : (path.hasPrefix("/api/") || path.hasPrefix("/plugins/") || path.hasPrefix("/assets/")) else { throw NativeError.denied }
        return url
    }
    private func makeRequest(_ call: CAPPluginCall, controlSession: HTTPCookie? = nil) throws -> URLRequest {
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
        if url.host == roomHost {
            // Runtime-host APIs (team, Needs you, Calendar, Library) authenticate Control's session cookie, as the room does.
            guard let controlSession = controlSession else { throw NativeError.denied }
            request.setValue("https://" + roomHost, forHTTPHeaderField: "Origin")
            let admitted = (runtimeCookies?.cookies(for: url) ?? []).filter { $0.name != controlSession.name }
            for (name, value) in HTTPCookie.requestHeaderFields(with: [controlSession] + admitted) { request.setValue(value, forHTTPHeaderField: name) }
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
            if try allowedURL(call.getString("url")).host == roomHost {
                cachedControlCookie { cookie in
                    guard let cookie = cookie else { call.resolve(["status": 401, "headers": [:], "data": "{\"error\":\"signed_out\"}"]); return }
                    do { self.send(call, try self.makeRequest(call, controlSession: cookie)) } catch { call.reject("Native request is not allowed.") }
                }
                return
            }
            send(call, try makeRequest(call))
        } catch { call.reject("Native request is not allowed.") }
    }
    /// Control's session cookie for Runtime-host requests, reused until shortly before it expires (at most ten minutes).
    private var controlSession: (cookie: HTTPCookie, until: Date)?
    private let controlSessionLock = NSLock()
    private func cachedControlCookie(_ completion: @escaping (HTTPCookie?) -> Void) {
        controlSessionLock.lock(); let cached = controlSession; controlSessionLock.unlock()
        if let cached = cached, cached.until > Date() { completion(cached.cookie); return }
        controlCookie { cookie in
            if let cookie = cookie {
                let limit = Date().addingTimeInterval(600)
                let until = min(limit, cookie.expiresDate?.addingTimeInterval(-60) ?? limit)
                self.controlSessionLock.lock(); self.controlSession = (cookie, until); self.controlSessionLock.unlock()
            }
            completion(cookie)
        }
    }
    private func send(_ call: CAPPluginCall, _ request: URLRequest) {
            #if DEBUG
            let started = Date()
            #endif
            session.dataTask(with: request) { data, response, error in
                #if DEBUG
                // Debug builds only: method, host, path, status and duration; never query strings, headers or bodies.
                NSLog("[native-http] %@ %@%@ %d %dms", request.httpMethod ?? "GET", request.url?.host ?? "", request.url?.path ?? "", (response as? HTTPURLResponse)?.statusCode ?? -1, Int(Date().timeIntervalSince(started) * 1000))
                #endif
                guard error == nil, let response = response as? HTTPURLResponse, let data = data, data.count <= 20 * 1024 * 1024 else { call.reject("Native request failed."); return }
                if let url = response.url, url.host == self.roomHost {
                    var fields: [String: String] = [:]
                    for (key, value) in response.allHeaderFields { if let key = key as? String, let value = value as? String { fields[key] = value } }
                    for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) where cookie.domain == self.roomHost || cookie.domain == "." + self.roomHost { self.runtimeCookies?.setCookie(cookie) }
                }
                if let url = response.url, url.host == "next.singulancelabs.com" {
                    var fields: [String: String] = [:]
                    for (key, value) in response.allHeaderFields { if let key = key as? String, let value = value as? String { fields[key] = value } }
                    for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) where cookie.domain == "next.singulancelabs.com" || cookie.domain == ".next.singulancelabs.com" { self.cookies?.setCookie(cookie) }
                }
                var headers: [String: String] = [:]
                for name in ["Content-Type", "Content-Length", "Content-Disposition", "Retry-After"] { if let value = response.value(forHTTPHeaderField: name) { headers[name.lowercased()] = value } }
                let responseType = call.getString("responseType") ?? "text"
                guard ["text", "base64"].contains(responseType) else { call.reject("Response type is invalid."); return }
                if response.statusCode == 401, request.url?.host == self.roomHost {
                    self.controlSessionLock.lock(); self.controlSession = nil; self.controlSessionLock.unlock()
                }
                call.resolve(["status": response.statusCode, "headers": headers, "encoding": responseType, "data": responseType == "base64" ? data.base64EncodedString() : (String(data: data, encoding: .utf8) ?? "")])
            }.resume()
    }
    // OpenDot employee rooms are a separate web application (https://runtime-runner.singulancelabs.com) that
    // refuses to be framed by capacitor://localhost and authenticates a Control session cookie. The room
    // therefore opens in its own top-level WKWebView with an isolated data store. The cookie is Control's own
    // Set-Cookie for the stored bearer (GET /auth/session); it goes from this class to that web view and
    // never reaches JavaScript, the Keychain or the Runner cookie jar.
    private let roomHost = "runtime-runner.singulancelabs.com"
    private var room: RoomViewController?
    /// Path of the room on screen.
    private var roomPath: String?
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
        cachedControlCookie { cookie in
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
    private static let lastRoomPathKey = "singulance.lastRoom.path"
    private static let lastRoomScopeKey = "singulance.lastRoom.scope"
    private static let roomPathPattern = "^/employees/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    /// Hosts whose site data (service worker, caches, IndexedDB, cookies) is removed on sign-out.
    private let roomDataHosts = ["runtime-runner.singulancelabs.com", "dots.singulancelabs.com"]
    /// At most one room view is kept hidden and loaded so the last opened room opens without a load.
    private var warmRoom: RoomViewController?
    private var warmPath: String?
    private var warmScope: String?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private func roomScope(_ value: String?) -> String? { value.flatMap { $0.count <= 200 && !$0.isEmpty ? $0 : nil } }
    private func roomURL(_ path: String?) -> URL? {
        guard let path = path, path.range(of: Self.roomPathPattern, options: .regularExpression) != nil else { return nil }
        return URL(string: "https://" + roomHost + path + "?embed=hivemind")
    }
    public override func load() {
        // The warm room holds the Control session cookie in its store: release it when the app leaves the foreground and rebuild it on return.
        let center = NotificationCenter.default
        lifecycleObservers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.discardWarmRoom(forgetSession: true) })
        lifecycleObservers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.prewarmLastRoom() })
        DispatchQueue.main.async { self.prewarmLastRoom() }
    }
    /// Drops the warm room. `forgetSession` also removes the session cookie from the shared room store (backgrounding,
    /// sign-out); replacing the warm room with another one of the same store must keep it, or the new room loses it.
    private func discardWarmRoom(forgetSession: Bool = false) {
        warmRoom?.closeSilently(forgetSession: forgetSession); warmRoom = nil; warmPath = nil; warmScope = nil
    }
    private func prewarmLastRoom() {
        let defaults = UserDefaults.standard
        prewarm(path: defaults.string(forKey: Self.lastRoomPathKey), scope: roomScope(defaults.string(forKey: Self.lastRoomScopeKey)))
    }
    private func prewarm(path: String?, scope: String?, completion: (() -> Void)? = nil) {
        guard room == nil, let url = roomURL(path), let path = path, (try? read("cpToken")) != nil else { completion?(); return }
        if warmRoom != nil, warmPath == path, warmScope == scope { completion?(); return }
        cachedControlCookie { cookie in
            DispatchQueue.main.async {
                defer { completion?() }
                guard let cookie = cookie, self.room == nil else { return }
                self.discardWarmRoom()
                let controller = RoomViewController(allowedHosts: [self.roomHost, "dots.singulancelabs.com"], scope: scope) { [weak self] in
                    self?.room = nil
                    self?.notifyListeners("roomClosed", data: [:])
                }
                self.warmRoom = controller; self.warmPath = path; self.warmScope = scope
                controller.show(url, cookie: cookie)
            }
        }
    }
    /// Loads the room view for `path` hidden so a later openRoom shows it already rendered.
    @objc func prewarmRoom(_ call: CAPPluginCall) {
        guard trusted(), roomURL(call.getString("path")) != nil else { call.reject("Room is not allowed."); return }
        prewarm(path: call.getString("path"), scope: roomScope(call.getString("scope"))) { call.resolve() }
    }
    @objc func openRoom(_ call: CAPPluginCall) {
        guard trusted(), let path = call.getString("path"), let url = roomURL(path) else { call.reject("Room is not allowed."); return }
        // The signed-in company and person; rooms of one scope share one persistent store, other scopes' stores are removed.
        let scope = roomScope(call.getString("scope"))
        UserDefaults.standard.set(path, forKey: Self.lastRoomPathKey)
        if let scope = scope { UserDefaults.standard.set(scope, forKey: Self.lastRoomScopeKey) } else { UserDefaults.standard.removeObject(forKey: Self.lastRoomScopeKey) }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { call.reject("Room could not open."); return }
            // A room already rendered for this path and scope is shown at once; it already holds its session cookie.
            let warmMatches = self.warmRoom != nil && self.warmPath == path && self.warmScope == scope && self.warmRoom?.failed == false
            let controller: RoomViewController
            if let open = self.room { controller = open }
            else if let warm = self.warmRoom, self.warmScope == scope {
                controller = warm
                self.warmRoom = nil; self.warmPath = nil; self.warmScope = nil
            } else {
                self.discardWarmRoom()
                controller = RoomViewController(allowedHosts: [self.roomHost, "dots.singulancelabs.com"], scope: scope) { }
            }
            controller.onClose = { [weak self] in
                self?.room = nil; self?.roomPath = nil
                self?.notifyListeners("roomClosed", data: [:])
                self?.prewarm(path: path, scope: scope)
            }
            let load = {
                if warmMatches { return }
                self.cachedControlCookie { cookie in
                    DispatchQueue.main.async {
                        guard let cookie = cookie else { controller.closeAfterFailure(); return }
                        controller.show(url, cookie: cookie)
                    }
                }
            }
            self.roomPath = path
            if self.room === controller { load(); call.resolve(); return }
            self.room = controller
            controller.modalPresentationStyle = .fullScreen
            // Present first: the room's own loading screen (cached name and look) appears while the cookie and page arrive.
            presenter.present(controller, animated: true) { call.resolve() }
            load()
        }
    }
    @objc func closeRoom(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.trusted() else { call.reject("Room could not close."); return }
            // A page that names its room closes only that room: when the person taps another employee, the new room
            // opens before the previous page goes away, and that page must not close it.
            if let path = call.getString("path"), path != self.roomPath { call.resolve(); return }
            self.room?.closeSilently()
            self.room = nil; self.roomPath = nil
            call.resolve()
        }
    }
    /// Product pages linked by absolute URL (Brain on next., rooms on the Runtime host) stay inside the app: the page
    /// navigates to the same path at the packaged origin instead of Capacitor handing the URL to Safari.
    private let productHosts: Set<String> = ["next.singulancelabs.com", "runtime-runner.singulancelabs.com", "singulancelabs.com", "www.singulancelabs.com"]
    @objc public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, url.scheme == "https", url.port == nil, url.user == nil,
              let host = url.host, productHosts.contains(host), url.path.hasPrefix("/hivemind/"),
              navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let target = components.percentEncodedPath.removingPercentEncoding,
              !target.contains(".."), !target.contains("//") else { return nil }
        let destination = components.percentEncodedPath + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        guard let literal = try? String(data: JSONSerialization.data(withJSONObject: [destination], options: []), encoding: .utf8) else { return nil }
        DispatchQueue.main.async {
            self.bridge?.webView?.evaluateJavaScript("(function(p){if(window.__hmNativeNavigate){window.__hmNativeNavigate(p)}else{window.location.assign(p)}})(\(literal)[0])")
        }
        return true
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
private final class RoomViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let allowedHosts: [String]
    var onClose: () -> Void
    private var loadedURL: URL?
    private var silent = false
    private let webView: WKWebView
    private static let storePrefix = "singulance-room:"
    /// Identifier of the persistent room store of one scope (UUID from a SHA-256 of the scope).
    private static func storeIdentifier(_ scope: String) -> UUID {
        var bytes = Array(SHA256.hash(data: Data((storePrefix + scope).utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50; bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }
    /// Removes every persistent room store except the one of `scope` (all of them when nil): sign-out and company switch.
    static func removeStores(keeping scope: String?) {
        guard #available(iOS 17.0, *) else { return }
        let keep = scope.map(storeIdentifier)
        WKWebsiteDataStore.fetchAllDataStoreIdentifiers { identifiers in
            for identifier in identifiers where identifier != keep { WKWebsiteDataStore.remove(forIdentifier: identifier) { _ in } }
        }
    }
    init(allowedHosts: [String], scope: String?, onClose: @escaping () -> Void) {
        self.allowedHosts = allowedHosts
        self.onClose = onClose
        let configuration = WKWebViewConfiguration()
        // One persistent store per company and person keeps the room's service worker, caches and history (OpenDot
        // IndexedDB) between openings and app restarts. Without a scope, or before iOS 17, the default persistent store
        // is used; sign-out removes the room hosts' data from it.
        if #available(iOS 17.0, *), let scope = scope {
            RoomViewController.removeStores(keeping: scope)
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: RoomViewController.storeIdentifier(scope))
        } else {
            configuration.websiteDataStore = .default()
        }
        // Service workers in WKWebView require App-Bound Domains (Info.plist WKAppBoundDomains).
        configuration.limitsNavigationsToAppBoundDomains = true
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        // The room's own back control ("Back to your team") posts here because the room is not framed by HIVEMIND.
        configuration.userContentController.add(WeakRoomMessages(self), name: "hivemindRoom")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.98, green: 0.976, blue: 0.957, alpha: 1)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        // The room draws its own header (back, avatar and name) under the status bar; the web view fills the screen
        // below the top safe area so that header sits at the top, as in the app's other screens.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwipe(_:)))
        edge.edges = .left
        edge.accessibilityLabel = "room-edge-back"
        view.addGestureRecognizer(edge)
    }
    @objc private func edgeSwipe(_ gesture: UIScreenEdgePanGestureRecognizer) {
        if gesture.state == .ended, gesture.translation(in: view).x > 60 { finish() }
    }
    /// The session could not be established: close the room and report it closed.
    func closeAfterFailure() { finish() }
    func show(_ url: URL, cookie: HTTPCookie) {
        loadViewIfNeeded()
        let alreadyLoaded = loadedURL == url && !failed
        loadedURL = url
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { if !alreadyLoaded { self.webView.load(URLRequest(url: url)) } }
    }
    /// Removes service workers, caches, IndexedDB and cookies of `hosts` from the default persistent store.
    static func removeSiteData(hosts: [String]) {
        let store = WKWebsiteDataStore.default()
        store.fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { records in
            let doomed = records.filter { record in hosts.contains { record.displayName == $0 || $0.hasSuffix("." + record.displayName) } }
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: doomed) { }
        }
    }
    /// The Control session cookie is a credential: it never stays in the persistent store after the room closes.
    private func forgetSession() {
        let store = webView.configuration.websiteDataStore.httpCookieStore
        store.getAllCookies { cookies in for cookie in cookies where cookie.name == "hm_cp_session" { store.delete(cookie) } }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        #if DEBUG
        NSLog("[room-message] main=%d host=%@ body=%@", message.frameInfo.isMainFrame ? 1 : 0, message.frameInfo.request.url?.host ?? "-", String(describing: message.body))
        #endif
        guard message.frameInfo.isMainFrame, let host = message.frameInfo.request.url?.host, allowedHosts.contains(host),
              let body = message.body as? [String: Any], body["version"] as? Int == 1, body["type"] as? String == "hivemind.open-dot.back" else { return }
        finish()
    }
    /// Rooms of one company and person share one store, so closing a room keeps the session cookie for the next room;
    /// it is removed only when asked (backgrounding with a warm room, sign-out).
    func closeSilently(forgetSession forget: Bool = false) { silent = true; loadedURL = nil; webView.stopLoading(); if forget { forgetSession() }; if presentingViewController != nil { dismiss(animated: true) } }
    @objc private func finish() { webView.stopLoading(); dismiss(animated: true) { self.onClose() } }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let allowed = url.scheme == "about" || (url.scheme == "https" && url.port == nil && allowedHosts.contains(url.host ?? ""))
        decisionHandler(allowed ? .allow : .cancel)
    }
    /// The last main-frame response was an error (for example a warm load that raced its session cookie).
    private(set) var failed = false
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse { failed = http.statusCode >= 400 }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}
/// Holds the room weakly so the web view's message handler does not keep the closed room alive.
private final class WeakRoomMessages: NSObject, WKScriptMessageHandler {
    private weak var room: RoomViewController?
    init(_ room: RoomViewController) { self.room = room }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { room?.userContentController(userContentController, didReceive: message) }
}
class SingulanceViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SingulanceNativePlugin())
        // Edge swipe goes back through the page history, as Safari does on a phone.
        bridge?.webView?.allowsBackForwardNavigationGestures = true
        // The stock WK script handler can be addressed by iframes even though its
        // helper script is main-frame-only. Filter the native message boundary itself.
        if let capBridge = bridge as? CapacitorBridge, let controller = bridge?.webView?.configuration.userContentController {
            controller.removeScriptMessageHandler(forName: "bridge")
            controller.add(TrustedFrameHandler(capBridge.webViewDelegationHandler), name: "bridge")
        }
    }
}
