// Per-Salesforce-object-type enrichment prompt templates. Each emits a
// strict JSON object with object-appropriate fields. graph-engine's
// enrichMemoryStructured dispatches via `metadata.salesforce_object_type`.
//
// Output JSON is persisted at source_metadata.metadata.enrichment and
// distilled into tags (urgency:*, stage:*, forecast:*, ...).

const COMMON_SUFFIX = (todayIso, title, text) => `

Today is ${todayIso}. Resolve relative dates against it. Keep names in original script.

TITLE: ${String(title || '').slice(0, 200)}

MEMORY:
${text}

OUTPUT JSON only.`;

const buildAccount = ({ todayIso, title, text }) => `You enrich a Salesforce Account memory with enterprise-grade structured fields. Emit STRICT JSON:

{
  "summary": "2-3 sentence executive abstract of this account, current state, strategic importance.",
  "tier": "strategic|enterprise|midmarket|smb|prospect",
  "health_score": "healthy|at_risk|critical|unknown",
  "strategic_importance": "high|medium|low",
  "vertical": "real_estate|saas|financial_services|...|unknown",
  "memory_kind": "fact",
  "urgency": "low|medium|high|critical",
  "key_relationships": [
    { "person": "name", "role": "decision_maker|champion|blocker|user", "tenure_signal": "stable|new|departing|unknown" }
  ],
  "recent_signals": [
    { "signal": "...", "implication": "..." }
  ],
  "open_risks": [
    { "risk": "...", "severity": "high|medium|low" }
  ],
  "canonical_entities": {
    "<slug>": { "display": "Acme Real Estate GmbH", "kind": "org", "emails": ["..."], "aliases": ["..."] }
  }
}` + COMMON_SUFFIX(todayIso, title, text);

const buildContact = ({ todayIso, title, text }) => `You enrich a Salesforce Contact memory. Emit STRICT JSON:

{
  "summary": "2-3 sentence executive abstract of this contact's role + relationship strength.",
  "role_type": "decision_maker|champion|blocker|user|gatekeeper|influencer|unknown",
  "decision_authority": "final|recommend|veto|none|unknown",
  "communication_preferences": { "channel": "email|slack|phone|inperson|unknown", "cadence": "weekly|biweekly|monthly|adhoc|unknown" },
  "relationship_strength": "strong|moderate|weak|stale|unknown",
  "tenure_signal": "long_tenured|stable|new|likely_departing|unknown",
  "memory_kind": "fact",
  "urgency": "low|medium|high|critical",
  "last_engagement_note": "what we last did with them",
  "canonical_entities": {
    "<slug>": { "display": "John Schmidt", "kind": "person", "emails": ["..."], "aliases": ["..."] }
  }
}` + COMMON_SUFFIX(todayIso, title, text);

const buildOpportunity = ({ todayIso, title, text }) => `You enrich a Salesforce Opportunity memory with CRM-aware structured fields. Emit STRICT JSON:

{
  "summary": "2-3 sentence executive abstract: who, deal size, stage, what's next.",
  "deal_stage": "prospecting|qualification|needs_analysis|value_proposition|proposal|negotiation|closed_won|closed_lost",
  "forecast_category": "pipeline|best_case|commit|closed|omitted|unknown",
  "mrr_impact": "expansion|retention|new_logo|churn_prevention|downsell|unknown",
  "competitor_mentioned": "competitor name | null",
  "blockers": [
    { "what": "...", "who_blocks": "person|team|null", "since": "YYYY-MM-DD|null" }
  ],
  "next_step": "concrete action + owner + when",
  "win_probability_signals": [
    { "signal": "...", "direction": "+|-" }
  ],
  "stakeholders": [
    { "name": "...", "role": "economic_buyer|champion|technical_buyer|user|blocker" }
  ],
  "urgency": "low|medium|high|critical",
  "memory_kind": "fact",
  "action_items": [
    { "task": "...", "owner": "...", "deadline": "YYYY-MM-DD|null", "status": "open|done|blocked" }
  ],
  "canonical_entities": {
    "<slug>": { "display": "Acme Renewal 2026", "kind": "product|org|person|place", "emails": ["..."], "aliases": ["..."] }
  }
}` + COMMON_SUFFIX(todayIso, title, text);

const buildCase = ({ todayIso, title, text }) => `You enrich a Salesforce Case (support ticket) memory. Emit STRICT JSON:

{
  "summary": "2-3 sentence abstract of the issue + status.",
  "severity": "p0_critical|p1_high|p2_medium|p3_low",
  "root_cause_hypothesis": "best guess at root cause | null",
  "resolution_status": "open|in_progress|pending_customer|resolved|escalated",
  "sla_status": "within_sla|breaching|breached|unknown",
  "impact_on_renewal": "high|medium|low|none",
  "customer_sentiment": "positive|neutral|frustrated|angry|at_risk|unknown",
  "memory_kind": "issue",
  "urgency": "low|medium|high|critical",
  "action_items": [
    { "task": "...", "owner": "...", "deadline": "YYYY-MM-DD|null", "status": "open|done|blocked" }
  ],
  "canonical_entities": {
    "<slug>": { "display": "...", "kind": "person|org|product", "emails": ["..."], "aliases": ["..."] }
  }
}` + COMMON_SUFFIX(todayIso, title, text);

const buildActivity = ({ todayIso, title, text }) => `You enrich a Salesforce activity (Task/Event/EmailMessage). Emit STRICT JSON:

{
  "summary": "1-2 sentence what happened, with whom, outcome.",
  "memory_kind": "event",
  "urgency": "low|medium|high|critical",
  "engagement_type": "email|call|meeting|demo|note|other",
  "sentiment": "positive|neutral|negative|unknown",
  "outcome": "advanced|stalled|blocked|unknown",
  "action_items": [
    { "task": "...", "owner": "...", "deadline": "YYYY-MM-DD|null", "status": "open|done|blocked" }
  ],
  "canonical_entities": {
    "<slug>": { "display": "...", "kind": "person|org|product", "emails": ["..."], "aliases": ["..."] }
  }
}` + COMMON_SUFFIX(todayIso, title, text);

export const SALESFORCE_ENRICHMENT_SCHEMA = {
  Account:            { buildPrompt: buildAccount },
  Contact:            { buildPrompt: buildContact },
  Opportunity:        { buildPrompt: buildOpportunity },
  OpportunityHistory: { buildPrompt: buildOpportunity }, // same schema, history adds time dimension
  Case:               { buildPrompt: buildCase },
  CaseComment:        { buildPrompt: buildCase },
  Task:               { buildPrompt: buildActivity },
  Event:              { buildPrompt: buildActivity },
  EmailMessage:       { buildPrompt: buildActivity },
};

export function pickSalesforceSchema(objectType) {
  if (!objectType) return null;
  return SALESFORCE_ENRICHMENT_SCHEMA[objectType] || null;
}
