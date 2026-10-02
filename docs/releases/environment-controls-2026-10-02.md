# Embedded Environment controls

Scope: native Harness client UI only. Brain and HyperAgents retain the native session/runtime behavior.

The toolbar retains Environment and the preview panel toggle. Existing background-job, schedule, calendar and export controls are composed inside Environment by the existing header owner. The activity indicator reads the session job mirror and marks only running/stopping work. Selected agent identity is read from the durable HyperAgent owner projection.

Initial release: Harness b7057e1b79f259993f176ba7acba7b02eb95e7cd, image hivemind/harness-chat:sha-b7057e1b79-environment, digest sha256:a2472724555db713cfdb4780bfe00dd1310020bb527ff6428081756ed44a27a7.

Preserved base: hivemind/harness-chat:sha-d24122cb51-progress. Runner cutover was healthy; sibling identities remained unchanged. Browser verification confirmed the two-control toolbar and functioning Automation tasks and Company calendar actions. Screenshot: /tmp/environment-consolidated.png.

Final refinement: Harness 5c9bdcedaad9ea004d510dbe8e99d27c264fc30c, image hivemind/harness-chat:sha-5c9bdcedaa-environment-refine, digest sha256:62933d1fba286cac2e1ddb7f93b43ca9d3bd84ffe3695bff3653c051cf3d812a.

Preserved latest base: b0dd3fcf026b4734a3eac77e9e0c3ca88474e623 (image-ratio progress update). Mandatory client compilation passed. Runner is healthy and sibling identities unchanged. Embedded HyperAgents disables its legacy dock so the shared Environment has sole ownership, retaining the preview toggle. Active jobs appear first, completed records are expandable when available, and Calendar/Automated tasks are under More.

Authenticated production browser verification confirmed one Environment panel with Sofia's identity in HyperAgents, no legacy duplicate, No active jobs on cold restoration, and Automation tasks/Company calendar inside expanded More. Completed-history behavior was not exercised because the restored job mirror had no retained completed jobs. Screenshot: /tmp/environment-single-live.png.
