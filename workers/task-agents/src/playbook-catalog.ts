export interface CatalogPlaybook { id: string; name: string; description: string; scope: "global"; version: number; body: string; }
export const GLOBAL_PLAYBOOKS: readonly CatalogPlaybook[] = [
  {
    "id": "campaign.awareness-to-learning",
    "name": "Awareness campaign to learning",
    "description": "A governed Campaign Intelligence lifecycle that prepares a complete multi-channel campaign before checking launch capabilities, then preserves it across connection, authority, observation and review.",
    "scope": "global",
    "version": 6,
    "body": "Version 6.\nA governed Campaign Intelligence lifecycle that prepares a complete multi-channel campaign before checking launch capabilities, then preserves it across connection, authority, observation and review.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- prepare_campaign_contract: \n- inspect_campaign_contract: \n- wait_for_campaign_repair: \n- wait_for_campaign_visuals: \n- preflight_campaign_channels: \n- wait_for_campaign_channels: \n- launch_campaign: \n- observe_campaign: \n- evaluate_campaign: "
  },
  {
    "id": "marketing.strategy-to-growth-brief",
    "name": "Marketing strategy to first-life program",
    "description": "One Marketing Room execution turns retained company evidence into one complete strategy and its executable first-life portfolio; deterministic materialization follows without another Room turn.",
    "scope": "global",
    "version": 9,
    "body": "Version 9.\nOne Marketing Room execution turns retained company evidence into one complete strategy and its executable first-life portfolio; deterministic materialization follows without another Room turn.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- form_strategy_program: \n- materialize_strategy_program: "
  },
  {
    "id": "operations.admin-call-to-decision",
    "name": "Administrator call to recorded decision",
    "description": "Resolve an administrator contact, obtain exact manual authority, place one governed call, and retain the resulting decision without mutating lead records.",
    "scope": "global",
    "version": 1,
    "body": "Version 1.\nResolve an administrator contact, obtain exact manual authority, place one governed call, and retain the resulting decision without mutating lead records.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- resolve_admin_phone: \n- request_admin_phone: \n- prepare_admin_call: \n- prepare_admin_contract: \n- place_admin_call: \n- observe_admin_call: \n- analyze_admin_call: \n- record_admin_decision: "
  },
  {
    "id": "operations.browser-admin-checkin-to-status",
    "name": "Browser administrator check-in to current status",
    "description": "An internal, user-initiated browser conversation that records current company status before first-life planning.",
    "scope": "global",
    "version": 1,
    "body": "Version 1.\nAn internal, user-initiated browser conversation that records current company status before first-life planning.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- offer_admin_checkin: \n- capture_admin_choice: \n- observe_browser_session: \n- analyze_current_status: \n- record_current_status: "
  },
  {
    "id": "outreach.direct-message",
    "name": "Direct message delivery",
    "description": "Prepare and govern one or more messages for exact recipients already supplied by the operator, without prospect rediscovery.",
    "scope": "global",
    "version": 2,
    "body": "Version 2.\nPrepare and govern one or more messages for exact recipients already supplied by the operator, without prospect rediscovery.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- prepare_message: \n- prepare_provider_drafts: \n- deliver_message: "
  },
  {
    "id": "outreach.prospect-to-conversation",
    "name": "Prospect to conversation",
    "description": "A recipient-isolated outreach lifecycle from evidence-backed prospecting through governed delivery, replies, follow-ups and explicit conversation outcomes.",
    "scope": "global",
    "version": 13,
    "body": "Version 13.\nA recipient-isolated outreach lifecycle from evidence-backed prospecting through governed delivery, replies, follow-ups and explicit conversation outcomes.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- prepare_outreach_bundle: \n- prepare_provider_drafts: \n- deliver_outreach: \n- observe_responses: \n- handle_response: \n- prepare_follow_up: \n- prepare_follow_up_drafts: \n- deliver_follow_up: \n- observe_follow_up: \n- evaluate_conversation: "
  },
  {
    "id": "outreach.voice-call-to-outcome",
    "name": "Outreach voice call to governed outcome",
    "description": "Prepare, authorize, place, observe, analyze, and complete the evidence-backed next action for one outbound TARA call.",
    "scope": "global",
    "version": 2,
    "body": "Version 2.\nPrepare, authorize, place, observe, analyze, and complete the evidence-backed next action for one outbound TARA call.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- prepare_call_brief: \n- prepare_call_contract: \n- place_call: \n- observe_call: \n- analyze_call: \n- record_lead_outcome: \n- request_summary_recipient: \n- prepare_summary: \n- prepare_summary_draft: \n- deliver_summary: "
  },
  {
    "id": "outreach.voice-cohort-to-outcomes",
    "name": "Sequential outreach call cohort",
    "description": "Prepare an ordered call cohort and complete one analyzed child call at a time under one parent execution.",
    "scope": "global",
    "version": 1,
    "body": "Version 1.\nPrepare an ordered call cohort and complete one analyzed child call at a time under one parent execution.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- prepare_cohort: \n- evaluate_cohort: \n- dispatch_next_call: "
  },
  {
    "id": "research.evidence-to-decision",
    "name": "Evidence to decision",
    "description": "A preparation-only Research Room lifecycle for a bounded source-backed decision.",
    "scope": "global",
    "version": 1,
    "body": "Version 1.\nA preparation-only Research Room lifecycle for a bounded source-backed decision.\nStages are the lifecycle boundary. The employee still chooses the actions inside a stage.\n- research_decision: "
  }
];
