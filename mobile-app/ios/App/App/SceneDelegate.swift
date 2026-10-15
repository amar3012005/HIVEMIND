import UIKit
import Capacitor
import SafariServices

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        #if DEBUG
        let packagedPreview = ProcessInfo.processInfo.arguments.contains("--packaged-preview")
        window?.rootViewController = packagedPreview ? SingulanceViewController() : SingulanceWebWorkspaceController()
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

/** The hosted application and its normal cookie login stay in one Apple browser.
 * The privileged packaged Capacitor bridge is deliberately not injected here.
 * Existing native implementation remains available as a separate debug preview.
 */
final class SingulanceWebWorkspaceController: UIViewController, SFSafariViewControllerDelegate {
    private var opened = false
    private let workspaceURL = URL(string: "https://next.singulancelabs.com/hivemind/m/chat")!

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
