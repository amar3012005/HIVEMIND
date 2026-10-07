# SINGULANCE Codex provider

Dedicated bearer-authenticated Cloudflare ingress for the native runner provider facade.

- Public base URL: `https://codex-api.singulancelabs.com/v1`.
- AI Gateway custom-provider base URL: `https://codex-api.singulancelabs.com`.
- Provider-specific Gateway requests append the complete `v1/...` path.
- Worker secrets: `PROVIDER_API_KEY` and separate `RUNNER_API_KEY`.
- Native fixed owner, membership checks, session authorization and credentials remain in the runner.
- Supported routes: models, chat completions, Responses, web search, one-image generations, and native realtime start/stop.
- Text supports string messages and input, not arbitrary tool execution or the complete OpenAI API surface.
- Images require a stable `Idempotency-Key`; output is base64. Voice uses the existing session/SDP call protocol, not speech synthesis.
- No cookie or Codex OAuth grant is forwarded to the client. No request body or authorization value is logged.

Deployment does not establish capability readiness: enable the matching runner configuration and verify real authenticated requests before announcing availability. Changes to the default reasoning provider are outside this service.
