import Foundation

/// Serves the release-pinned Runtime web client (`/plugins/*`, `/assets/*`) from the app bundle.
///
/// `scripts/package-runtime.mjs` writes `public/runtime/manifest.json` and content-addressed files.
/// A request is answered locally only when its exact `path + query` is listed. Those URLs carry
/// content or boot-graph revisions, so a new Runtime release produces unlisted URLs that fall
/// through to the network. Credentials, `/api/*` data and sockets never pass through this type.
struct RuntimeBundle {
    struct Resource { let data: Data; let type: String }
    private struct Entry { let file: String; let type: String }
    let release: String
    private let entries: [String: Entry]
    private let files: URL

    /// Reads `<root>/manifest.json`; returns nil when the app was packaged without Runtime code.
    init?(root: URL) {
        guard let bytes = try? Data(contentsOf: root.appendingPathComponent("manifest.json")),
              let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              json["format"] as? Int == 1, let release = json["release"] as? String,
              let raw = json["entries"] as? [String: [String: Any]] else { return nil }
        var parsed: [String: Entry] = [:]
        for (key, value) in raw {
            guard let file = value["file"] as? String, file.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  let type = value["type"] as? String else { continue }
            parsed[key] = Entry(file: file, type: type)
        }
        self.release = release; self.entries = parsed; self.files = root.appendingPathComponent("files", isDirectory: true)
    }

    /// The manifest key for a runner URL: `pathname` plus `?query`, exactly as the Worker keys it.
    static func key(for url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
    }

    func resource(for url: URL) -> Resource? {
        guard url.host == "next.singulancelabs.com", let key = RuntimeBundle.key(for: url), let entry = entries[key],
              let data = try? Data(contentsOf: files.appendingPathComponent(entry.file)) else { return nil }
        return Resource(data: data, type: entry.type)
    }

    /// The bundle shipped inside the application, loaded once.
    static let shipped: RuntimeBundle? = Bundle.main.resourceURL.flatMap { RuntimeBundle(root: $0.appendingPathComponent("public/runtime", isDirectory: true)) }
}
