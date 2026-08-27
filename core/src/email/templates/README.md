# Transactional Email Templates

`cartesia-lifecycle.js` owns the versioned SINGULANCE email DNA: orbit logo,
SINGULANCE wordmark, `HIVEMIND · OPERATING SYSTEM` subtitle, colors, subject
convention, and responsive shells. `emailBrandLockup()` is the only brand header
that outbound templates should render.

`singulance-transactional.js` is the shared, table-based layout for transactional
mail. It consumes that lockup and remains dependable in Gmail, Outlook, Apple Mail,
and Cloudflare Email Sending previews.

Message copy remains in `../templates.json`. Set `"layout": "singulance_transactional"`
on a catalog entry to render its HTML body inside this branded shell.

`hivemind-welcome.js` is the dedicated email-safe translation of the Cartesia
HIVEMIND product tour. It uses the same lockup while retaining the longer welcome
content. Use `"layout": "hivemind_cartesia_welcome"` only for account welcome and
welcome-back journeys.

Day-0 emails deliberately ignore persisted legacy avatar URLs and use the canonical
public Humation renderer. The deck embeds its vector portrait; email references the
same generated, fully colorized portrait through the public API.
