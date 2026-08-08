# Transactional Email Templates

`singulance-transactional.js` is the shared, table-based layout for transactional
mail. It intentionally uses inline styles only so it remains dependable in Gmail,
Outlook, Apple Mail, and Cloudflare Email Sending previews.

Message copy remains in `../templates.json`. Set `"layout": "singulance_transactional"`
on a catalog entry to render its HTML body inside this branded shell.

