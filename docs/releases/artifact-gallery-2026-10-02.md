# Shared artifact gallery and centered preview

Native source: a78c8bd5efe59c027cec5ca1de286bf5328f6af8
Runner: hivemind/harness-chat:sha-a78c8bd5ef-artifact-gallery
Digest: sha256:f545e0588887efe9105ed00cf8a3015a52f99cb307e25f68d8256167836229ae
Rollback: hivemind/harness-chat:sha-c8c678bb7b-preview-two-row

Preserves the complete current production base, including image-loading updates. Adds newest-first stack/grid artifacts, type filter, last-viewed label, exact-file native preview selection, centered preview content and removes the redundant open action. Shared sliding panel remains native.

Focused compilation and mandatory push graph check passed. Immutable image verification passed; runner cutover healthy with sibling container identities unchanged. Authenticated Sofia conversation verified: image above bottom file banner, sections above tabs, card selection opens selected file with Download only, grid toggle and last-viewed marker. Existing proof conversation has one artifact; multi-card overlap not exercised in browser.
