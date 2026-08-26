# Independent Visual Deck Probe

This probe does not invoke HyperRooms. It sends a completed Room transcript to
GPT-OSS 20B Nitro through the configured Cloudflare AI Gateway, performs a
second evidence-repair pass, and renders the resulting typed specification as
responsive interactive HTML.

```bash
PYTHONPATH=employees-service/src \
python employees-service/scripts/visual_deck/generate_visual_deck.py \
  --context /path/to/completed-room.txt \
  --hero-image /path/to/hero.png \
  --output /tmp/visual-deck
```

Required environment variables are the existing Employees inference settings:
`OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN`, and
`CLOUDFLARE_AI_GATEWAY_ENABLED=true`.

Outputs:

- `index.html`: standalone rendered artifact
- `deck-spec.json`: model-authored and deterministically validated specification
- `generation-receipt.json`: model, provider, Gateway, call count, and spec hash
