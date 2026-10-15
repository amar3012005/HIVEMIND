import UIKit
import Capacitor
import SafariServices
import WebKit
import AVFAudio

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        #if DEBUG
        let packagedPreview = ProcessInfo.processInfo.arguments.contains("--packaged-preview")
        let embeddedPreview = ProcessInfo.processInfo.arguments.contains("--embedded-web-preview")
        window?.rootViewController = packagedPreview ? SingulanceViewController() : embeddedPreview ? SingulanceEmbeddedWorkspaceController() : SingulanceWebWorkspaceController()
        #else
        window?.rootViewController = SingulanceWebWorkspaceController()
        #endif
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Hosted React UI with app-owned viewport. No remote page receives a Capacitor bridge.
/// Separate preview until normal web login and authenticated app flows pass acceptance.
final class SingulanceEmbeddedWorkspaceController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let workspaceURL = URL(string: "https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness")!
    private let appHosts: Set<String> = ["runtime-runner.singulancelabs.com", "next.singulancelabs.com"]
    private var browser: WKWebView!
    private var signingIn = false
    private let retry = UIButton(type: .system)
    private let loading = UIActivityIndicatorView(style: .medium)
    private var downloads: [ObjectIdentifier: URL] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 250/255, green: 249/255, blue: 246/255, alpha: 1)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Scope layout adaptation to the actual app shell. Preserve document previews,
        // login scrolling and the existing chat viewport/history implementation.
        configuration.userContentController.addUserScript(WKUserScript(source: Self.layoutScript,
            injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        browser = WKWebView(frame: .zero, configuration: configuration)
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.isOpaque = false
        browser.backgroundColor = view.backgroundColor
        browser.scrollView.contentInsetAdjustmentBehavior = .never
        browser.scrollView.bounces = false
        browser.scrollView.alwaysBounceVertical = false
        browser.scrollView.alwaysBounceHorizontal = false
        browser.scrollView.keyboardDismissMode = .interactive
        browser.allowsBackForwardNavigationGestures = true
        #if DEBUG
        if #available(iOS 16.4, *) { browser.isInspectable = true }
        #endif
        browser.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(browser)
        NSLayoutConstraint.activate([
            browser.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            browser.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            browser.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            browser.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        loading.accessibilityLabel = "Opening your workspace"
        loading.translatesAutoresizingMaskIntoConstraints = false
        loading.hidesWhenStopped = true
        view.addSubview(loading)
        NSLayoutConstraint.activate([
            loading.centerXAnchor.constraint(equalTo: browser.centerXAnchor),
            loading.centerYAnchor.constraint(equalTo: browser.centerYAnchor)
        ])
        loading.startAnimating()
        retry.setTitle("Connection interrupted. Tap to retry", for: .normal)
        retry.backgroundColor = view.backgroundColor
        retry.titleLabel?.font = .preferredFont(forTextStyle: .callout)
        retry.titleLabel?.adjustsFontForContentSizeCategory = true
        retry.translatesAutoresizingMaskIntoConstraints = false
        retry.addTarget(self, action: #selector(retryPage), for: .touchUpInside)
        retry.isHidden = true
        view.addSubview(retry)
        NSLayoutConstraint.activate([
            retry.topAnchor.constraint(equalTo: browser.topAnchor),
            retry.leadingAnchor.constraint(equalTo: browser.leadingAnchor),
            retry.trailingAnchor.constraint(equalTo: browser.trailingAnchor),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        browser.load(URLRequest(url: workspaceURL))
    }

    @objc private func retryPage() {
        retry.isHidden = true
        if browser.url == nil { browser.load(URLRequest(url: workspaceURL)) }
        else { browser.reload() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        guard action.targetFrame?.isMainFrame != false else { decisionHandler(.allow); return }
        let ownPage = url.scheme == "https" && url.user == nil && url.password == nil &&
            (url.port == nil || url.port == 443) && appHosts.contains(url.host ?? "")
        let blobOrigin = url.scheme == "blob" ? URL(string: String(url.absoluteString.dropFirst(5))) : nil
        let ownedDownload = blobOrigin?.scheme == "https" && appHosts.contains(blobOrigin?.host ?? "") &&
            blobOrigin?.user == nil && blobOrigin?.password == nil &&
            (blobOrigin?.port == nil || blobOrigin?.port == 443)
        if action.shouldPerformDownload && (ownPage || ownedDownload) {
            decisionHandler(.download)
            return
        }
        if ownPage {
            if url.path == "/hivemind/login" { signingIn = true }
            if signingIn && url.path.hasPrefix("/hivemind/app/") {
                signingIn = false
                if url.path.hasPrefix("/hivemind/app/overview") {
                    decisionHandler(.cancel)
                    webView.load(URLRequest(url: workspaceURL))
                    return
                }
            }
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if url.scheme == "https", url.host == "api.singulancelabs.com", url.path == "/auth/google" {
            // Do not run Google OAuth inside WebKit or transfer browser bearer tokens.
            let alert = UIAlertController(title: "Sign in", message: "Use email sign-in to keep your workspace in this app. Google can open the browser workspace, which uses a separate session.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Use email in app", style: .cancel))
            alert.addAction(UIAlertAction(title: "Open browser workspace", style: .default) { [weak self] _ in
                guard let self else { return }
                let web = SFSafariViewController(url: self.workspaceURL)
                web.modalPresentationStyle = .fullScreen
                self.present(web, animated: true)
            })
            present(alert, animated: true)
        } else if ["https", "mailto", "tel"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading.stopAnimating()
        retry.isHidden = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { loading.stopAnimating(); retry.isHidden = false }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { loading.stopAnimating(); retry.isHidden = false }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // An explicit retry avoids silently replacing a draft or repeating a task.
        retry.isHidden = false
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = String(URL(fileURLWithPath: suggestedFilename).lastPathComponent.prefix(180))
            let destination = directory.appendingPathComponent(filename.isEmpty || filename == "." || filename == ".." ? "Artifact" : filename)
            downloads[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch { completionHandler(nil); retry.isHidden = false }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        loading.stopAnimating()
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        present(sheet, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        loading.stopAnimating()
        retry.isHidden = false
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard type == .microphone, frame.isMainFrame, origin.protocol == "https",
              appHosts.contains(origin.host), origin.port == 0 || origin.port == 443,
              webView.url?.host == origin.host else { decisionHandler(.deny); return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetoothHFP])
            decisionHandler(.prompt)
        } catch { decisionHandler(.deny) }
    }

    private static let layoutScript = """
    (() => {
      if (!['runtime-runner.singulancelabs.com', 'next.singulancelabs.com'].includes(location.hostname)) return;
      const style = document.createElement('style');
      style.textContent = `
        html:has([data-hivemind-app-shell]), html:has([data-hivemind-app-shell]) body {
          height:100%; overflow:hidden; overscroll-behavior:none;
        }
        [data-hivemind-app-shell]:not([data-native-chat-shell]) {
          position:fixed; inset:0; height:100%; min-height:0; overflow:hidden;
        }
        [data-hivemind-app-shell]:not([data-native-chat-shell]) > div:has(> main) {
          display:flex; flex-direction:column; height:100%; min-height:0;
        }
        [data-hivemind-app-shell]:not([data-native-chat-shell]) > div > main {
          flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain;
        }
      `;
      document.head.appendChild(style);
    })();
    """
}

/** The hosted application and its normal cookie login stay in one Apple browser.
 * The privileged packaged Capacitor bridge is deliberately not injected here.
 * Existing native implementation remains available as a separate debug preview.
 */
final class SingulanceWebWorkspaceController: UIViewController, SFSafariViewControllerDelegate {
    private var opened = false
    private let workspaceURL = URL(string: "https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness")!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 250/255, green: 249/255, blue: 246/255, alpha: 1)
        let title = UILabel()
        title.text = "SINGULANCE"
        title.font = .preferredFont(forTextStyle: .title1)
        title.adjustsFontForContentSizeCategory = true
        title.textAlignment = .center
        let button = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Open your workspace"
        configuration.baseBackgroundColor = UIColor(red: 17/255, green: 125/255, blue: 1, alpha: 1)
        configuration.cornerStyle = .large
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 24, bottom: 14, trailing: 24)
        button.configuration = configuration
        button.addTarget(self, action: #selector(openWorkspace), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, button])
        stack.axis = .vertical
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !opened else { return }
        opened = true
        openWorkspace()
    }

    @objc private func openWorkspace() {
        guard presentedViewController == nil else { return }
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        configuration.barCollapsingEnabled = true
        let browser = SFSafariViewController(url: workspaceURL, configuration: configuration)
        browser.delegate = self
        browser.modalPresentationStyle = .fullScreen
        browser.preferredBarTintColor = UIColor(red: 250/255, green: 249/255, blue: 246/255, alpha: 1)
        browser.preferredControlTintColor = UIColor(red: 17/255, green: 125/255, blue: 1, alpha: 1)
        present(browser, animated: false)
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        controller.dismiss(animated: true)
    }
}
