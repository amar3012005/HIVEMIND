# HIVE Harness Chat edge

Dedicated static-assets Worker for `chat.singulancelabs.com`. The internal
flag receipt endpoint evaluates the string Flagship flag
`hivemind_harness_chat_v1`; missing bindings, errors, invalid identities, and
unknown variations resolve to `legacy`.

Before a release, the Harness web build pipeline copies its reviewed output
into `public/`; generated assets are intentionally not committed here. A dry
run validates the Worker and binding contract without publishing it.

Secrets are configured with Wrangler and are never committed:

- `HIVE_HARNESS_EDGE_EVAL_SECRET`: authenticates control-plane flag evaluation.

The control plane separately requires `HIVE_HARNESS_TICKET_SECRET` for the
60-second HMAC-SHA256 runner admission ticket. Do not reuse a session or master
API secret for either value.
