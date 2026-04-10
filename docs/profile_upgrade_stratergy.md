PROFILE_UPGRADE_STRATEGY.md

# HIVEMIND Profile System Upgrade Strategy

## Executive Summary

The HIVEMIND profile system currently collects user facts through regex pattern matching during memory ingestion. However, this approach faces two critical challenges:

1. **Profile Pollution**: Connector ingestions (Gmail, Slack, etc.) introduce noise into user and organization profiles with content that should inform knowledge retrieval, not profile identity.
2. **Shallow Extraction**: The system only captures explicit statements ("my name is X") rather than mining the memory graph for implicit facts (50 memories about Python → user knows Python).

This document outlines a strategy to upgrade profiles to remain **dynamic over time** while preventing pollution from automated connectors.

---

## Current State: Architecture & Limitations

### Current User Profile System

**Components:**
- `ProfileStore` (251 lines): CRUD operations, extraction via regex, storage in `user_profiles` table
- `UserProfile` cache (71 lines): In-memory fast lookup for LLM injection, 5-min TTL
- **Categories**: static, dynamic, preference, goal
- **Storage**: PostgreSQL `user_profiles` table with confidence, sourceMemoryId, lastConfirmedAt, deletedAt (soft delete)
- **Injection Point**: `persisted-retrieval.js` prepends profile facts as `<user-profile>` to recall results before LLM processing

**Extraction Mechanism:**
```javascript
// Current approach: regex pattern matching only
"my name is John" → extracts: { name: "John" }
"I work at Acme Corp" → extracts: { company: "Acme Corp" }
"My timezone is UTC+2" → extracts: { timezone: "UTC+2" }
Current Limitations:

Only pattern-matched explicit statements captured (5-10% of actual user knowledge)
No organization profile system exists (only basic metadata in Organization model)
No differentiation between "profile-defining facts" and "content facts"
All ingested memories treated equally - connector ingestions pollute profiles with noise
No temporal decay or lifecycle management of profile facts
No explicit confirmation flow for auto-extracted facts from graphs
Current Organization Profile System
Current State: Does not exist

Existing Organization Model:


model Organization {
  id String @id @default(cuid())
  name String
  slug String @unique
  plan String @default("free")
  // Basic metadata only - no profile/identity tracking
}
Current Org Context Injection:

Bootstrap payload in control-plane-server.js includes org name/slug/plan
No org-specific facts, capabilities, or knowledge aggregation
Problem Statement: Profile Pollution
What Happens Today
When a user connects Gmail, Slack, or other connectors:

Ingestion Pipeline: Memories from connectors flow into the knowledge base


Gmail → "Meeting notes from Q1 planning" 
→ Memory ingested → ProfileStore.extractAndStore() runs
→ Regex patterns may match: "We discussed Q1 OKRs" 
→ Irrelevant facts stored in user profile
Profile Contamination: User profile becomes a mixed bag


Profile Should Contain:
- name: "John Smith"
- role: "Engineering Lead"
- expertise: ["Python", "Kubernetes"]

Profile Actually Contains (POLLUTED):
- name: "John Smith" ✓
- role: "Engineering Lead" ✓
- expertise: ["Python", "Kubernetes"] ✓
- recently_met: ["Alice", "Bob", "Charlie"] ← from Gmail (noise)
- project_names: ["Q1 Planning", "H2 Strategy"] ← from calendar (noise)
- timezone: "UTC+1", "UTC+2", "UTC+5" ← contradictory from emails (noise)
LLM Confusion: Injected profile context becomes a noisy haystack


Recall query: "What's the user's timezone?"
LLM sees 3 conflicting values → reduces confidence
Chat context bloated with irrelevant facts → worse reasoning
Root Cause
No gating mechanism distinguishes:

Profile-defining facts (should update profile)
Content-only facts (should inform retrieval, not profile)
Current logic: extractAndStore() runs on ALL memories regardless of source or relevance.

Proposed Solution Architecture
Phase 1: Selective Profile Marking (P0 - 2 weeks)
Concept: Mark memories at ingestion time with profile relevance

1.1 Add Profile Relevance Flag to Memory Model

model Memory {
  // ... existing fields ...
  profile_relevance {
    type: "profile_defining" | "content_only" | "neutral"
    // "profile_defining": facts that should update user/org profile
    // "content_only": useful facts but shouldn't touch profile
    // "neutral": unclassified (default, safe: exclude from profile)
  }
  profile_categories {
    // Optional: if profile_defining, which categories?
    // e.g., ["name", "role", "expertise"]
  }
}
1.2 Classify During Ingestion
For Direct User Input (web UI, /api/memories):

User explicitly confirms profile-relevance checkbox
Default: neutral (unless user checks "update my profile")
For Connector Sources (Gmail, Slack, MCP):

Default: content_only (prevents pollution)
Require explicit opt-in per connector: "Index connector data for profile extraction"
For Enterprise Uploads (documents, spreadsheets):

Default: depends on document type
Invoice: content_only (never profile-defining)
SOP/Contract: neutral (requires review)
Meeting notes: content_only (unless marked by user)
1.3 Update ProfileStore.extractAndStore()

// OLD BEHAVIOR
export async function extractAndStore(userId, memory, orgId) {
  const facts = extractViaRegex(memory.content); // RUNS ON ALL
  // Store all extracted facts
}

// NEW BEHAVIOR
export async function extractAndStore(userId, memory, orgId) {
  // GATING: Only extract if memory is profile_defining
  if (memory.profile_relevance !== "profile_defining") {
    return; // Skip extraction entirely
  }
  
  // If memory specifies categories, constrain extraction
  if (memory.profile_categories?.length) {
    const facts = extractViaRegex(memory.content, memory.profile_categories);
  } else {
    const facts = extractViaRegex(memory.content); // Full extraction
  }
  
  // Store with source tracking
  for (const [key, value] of Object.entries(facts)) {
    await createProfile({
      key, value, sourceMemoryId: memory.id,
      confidence: 0.7 // auto-extracted via regex
    });
  }
}
Result: Connector ingestions no longer pollute profiles by default.

Phase 2: Graph-Based Implicit Fact Extraction (P1 - 3 weeks)
Concept: Mine the memory graph for implicit facts instead of just regex matching

2.1 Problem with Current Regex Approach

// What we capture today
"My name is John" → { name: "John" }

// What we miss
[50 memories tagged #python, #numpy, #django]
→ Missing: { expertise: ["python", "django", "numpy"], level: "expert" }

[20 memories mentioning "team lead", "mentored", "architecture review"]
→ Missing: { role: "team-lead", seniority: "senior" }

[Memories from company domain, talking about product roadmap]
→ Missing: { company: "...", department: "..." }
2.2 Implicit Fact Extraction Pipeline
New process runs periodically (weekly) and on-demand:


FOR EACH USER:
  1. Fetch all memories with profile_relevance in ["profile_defining", "neutral"]
  2. For each category (expertise, role, company, network):
     a. Mine graph: Extract facts via NLP / frequency analysis
     b. Score confidence: based on frequency, recency, concordance
     c. Compare to existing profile: detect contradictions
     d. Queue for confirmation: if confidence < 0.8, require user approval
  3. Batch update profile with confirmed facts
2.3 Implementation: Graph Mining Rules
Rule: Expertise Extraction


// Scan memories for technical keywords + frequency
const getTechKeywords = (memories) => {
  const techTerms = new Set();
  for (const mem of memories) {
    // Count occurrences of keywords: #python, #rust, #kubernetes, etc.
    // Tag matching (already in memory object)
    // Contextual mentions: "wrote X in Python", "deployed on Kubernetes"
  }
  return [...techTerms].map(term => ({
    value: term,
    confidence: frequency / total_memories,
    recency: avg_days_since_mention
  }));
};

// Profile update
profile.expertise = getTechKeywords(userMemories)
  .filter(t => t.confidence > 0.6)
  .sort((a, b) => b.confidence - a.confidence)
  .slice(0, 10); // Top 10
Rule: Role Extraction


const getImpliedRole = (memories) => {
  const roleSignals = [];
  // Count: "led team", "mentored", "code review", "architecture" → leadership
  // Count: "frontend", "React", "CSS" → individual contributor
  // Detect seniority from decision-making language
  return aggregateSignals(roleSignals);
};
Rule: Network Extraction


const getNetwork = (memories) => {
  // From Gmail: extract frequently mentioned contacts
  // From Slack: extract frequently messaged colleagues
  // From memories: extract mentioned people
  // Group by frequency, exclude public figures
  return frequentContacts.slice(0, 20); // Top collaborators
};
2.4 Confidence Scoring & Contradiction Detection

// Confidence scoring
const scoreConfidence = (fact, sources) => {
  let score = 0.0;
  score += sources.length * 0.1; // +0.1 per source (max 0.5)
  score += recencyBonus; // Recent mentions score higher
  score += frequencyBonus; // More common in graph = higher score
  return Math.min(score, 1.0);
};

// Contradiction detection
const detectContradictions = (existingProfile, newFact) => {
  const existing = existingProfile[newFact.key];
  if (!existing) return null; // No conflict
  
  // String overlap: if very different, flag contradiction
  const similarity = wordOverlap(existing, newFact.value);
  if (similarity < 0.3 && newFact.confidence > 0.7) {
    return { type: "CONTRADICTION", severity: "HIGH" };
  }
  return null;
};
2.5 User Confirmation Flow
For auto-extracted facts with confidence < 0.8:

Queue in profile confirmation inbox
Show in Profile UI: "💡 Based on your memories, you seem to know Python. Confirm?"
User action: Confirm, Reject, or Adjust
Phase 3: Organization Profile System (P2 - 3 weeks)
Concept: Mirror user profile system at organization level

3.1 Add OrgProfile Model

model OrgProfile {
  id String @id @default(cuid())
  org_id String @db.Uuid
  
  // Same structure as UserProfile
  category String // "static" | "dynamic" | "preference" | "goal"
  key String
  value String
  confidence Float
  confirmedCount Int @default(0)
  sourceMemoryId String?
  lastConfirmedAt DateTime?
  deletedAt DateTime? // soft delete
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@unique([org_id, key])
  @@index([org_id, category])
}
3.2 Org Profile Extraction
Sources for org profiles:

Direct: Org settings page (name, industry, mission)
Inferred from user profiles: If 80%+ of users work in "fintech", org.industry = "fintech"
Inferred from documents: Enterprise uploads labeled "company handbook", "strategy doc"
Inferred from graph: Majority of memories tagged with org keywords
3.3 Org Profile Injection
Update control-plane-server.js bootstrap and persisted-retrieval.js:


// Before (control-plane-server.js)
const orgContext = {
  name: org.name,
  slug: org.slug,
  plan: org.plan
};

// After
const orgContext = {
  name: org.name,
  slug: org.slug,
  plan: org.plan,
  profile: await OrgProfileStore.getContext(org.id) // NEW
  // { industry, mission, size, products, recent_projects, shared_values }
};
Update LLM injection:


// persisted-retrieval.js
const userProfile = await userProfileCache.get(userId);
const orgProfile = await orgProfileCache.get(orgId); // NEW

let injectionText = `<user-profile>\n${userProfile}\n</user-profile>`;
injectionText += `\n<org-profile>\n${orgProfile}\n</org-profile>`; // NEW
Phase 4: Connector-Aware Ingestion Filters (P3 - 2 weeks)
Concept: Let users control which connectors feed profiles

4.1 Connector Profile Settings
New UI in Settings → Connectors:


Gmail Connector ✓
  ├─ Index for search/recall: ✓ (enabled)
  └─ Update my profile?: ○ (disabled)
     └─ If enabled, extract: ☐ role ☐ company ☐ contact_network

Slack Connector ✓
  ├─ Index for search/recall: ✓ (enabled)
  └─ Update my profile?: ○ (disabled)
     └─ If enabled, extract: ☐ role ☐ expertise ☐ team_network
4.2 Implementation: Connector Metadata
Add to Memory model during ingestion:


model Memory {
  // ... existing fields ...
  source_connector String? // "gmail", "slack", "notion", "enterprise_upload"
  connector_profile_settings {
    update_profile: boolean // Did user enable profile updates for this connector?
    allowed_categories: String[] // Categories to extract, if enabled
  }
}
Update ingestion endpoints to:

Read user's connector profile settings
Set profile_relevance = "content_only" if update_profile = false
Pass profile_categories if specified
Integration Points
1. Memory Ingestion Pipeline (server.js)
POST /api/memories (direct user input):


// Default: profile_defining (user owns this fact)
req.body.profile_relevance = "profile_defining";
POST /api/enterprise/upload/ingest (connector/enterprise):


// Default: content_only (prevent pollution)
const relevance = await getConnectorSettings(userId, source_connector);
memory.profile_relevance = relevance.update_profile ? "profile_defining" : "content_only";
memory.profile_categories = relevance.allowed_categories;
2. ProfileStore Extraction (profile-store.js)

// Add gating check
export async function extractAndStore(userId, memory, orgId) {
  if (memory.profile_relevance !== "profile_defining") {
    logger.debug(`Skipping profile extraction for memory ${memory.id} (relevance=${memory.profile_relevance})`);
    return;
  }
  // ... existing extraction logic ...
}
3. Graph Mining Scheduler
New cron job or on-demand endpoint:


POST /api/admin/profiles/refresh (internal)
→ For each user: run graph mining pipeline
→ Queue confirmation inbox items
→ Update profiles with high-confidence facts

Runs: Weekly at off-peak hours (Sunday 2 AM UTC)
Or: On-demand when user visits Profile page
4. Profile UI Updates (Profile.jsx)
Add "Confirmation Inbox" tab: shows pending auto-extracted facts
Add "Profile Source" pill: shows if auto-extracted vs user-confirmed vs from graph
Add "Suggestion frequency": "Based on 47 memories" indicator
Add source visualization: timeline of where each fact came from
5. Settings → Connectors
Add profile control UI for each connected service.

Migration Strategy
Step 1: Add Profile Relevance Flag (Non-Breaking)

// Update Memory schema in Prisma
// Old memories get default: profile_relevance = "neutral" (safe)
// This prevents accidental pollution of existing profiles
Step 2: Update Ingestion Logic (Non-Breaking)
All connectors → profile_relevance = "content_only" by default
Existing extraction suspended for connector sources
Direct user inputs still auto-extract (profile_defining)
No data loss: existing profile facts remain, new ones controlled
Step 3: Launch Settings UI
Let users opt-in: "Update my profile from [Connector]"
Users choose which categories to extract
Step 4: Deploy Graph Mining (Opt-In)
Available as experimental feature
Requires user opt-in on Profile page
Weekly refresh or on-demand
Step 5: Org Profiles (Optional)
Deploy OrgProfile model and UI
Start mining from user memori shared_org_context
Success Metrics
Metric	Target	How to Measure
Profile Pollution Reduction	80% fewer contradictions	Compare before/after contradiction detection logs
Extraction Accuracy	90% precision (user-confirmed)	% of suggested facts user confirms
Graph Mining Coverage	10x more facts extracted	Compare regex-only vs graph-mining fact counts
Org Profile Adoption	50%+ of users with org profiles	% of orgs with > 5 profile facts
Profile Freshness	70% of facts < 3 months old	Avg lastConfirmedAt recency
LLM Injection Quality	+15% answer accuracy	A/B test with/without profile injection
Timeline & Phases
Phase	Duration	Priority	Deliverables
Phase 1	2 weeks	P0	Profile relevance flag, connector defaults, gating logic
Phase 2	3 weeks	P1	Graph mining engine, confidence scoring, confirmation UI
Phase 3	3 weeks	P2	OrgProfile model, org extraction, org injection
Phase 4	2 weeks	P3	Connector settings UI, per-connector controls
Total	10 weeks		Complete profile upgrade
Open Questions & Considerations
Backward Compatibility: Should we soft-delete existing connector-derived profile facts?

Proposal: Tag them with source, let users review and decide to keep/discard
Graph Mining Latency: Weekly refresh might miss real-time updates

Proposal: Offer on-demand refresh button + background weekly job
Confidence Thresholds: What should trigger user confirmation (0.7? 0.8?)?

Proposal: Start at 0.8, adjust based on user feedback
Org Inference: If 3 out of 10 users work in "fintech", should org profile say "industry: fintech"?

Proposal: Require 70%+ consensus, require admin review before publishing
Privacy: Should org profiles include individual names/contacts?

Proposal: No. Org profile: industry, mission, size. NOT individual network names.
Conclusion
This upgrade transforms HIVEMIND profiles from noisy, shallow, and polluted to clean, deep, and intentional.

By adding profile relevance gating, graph-based extraction, and user controls, we ensure that:

✓ User profiles stay focused on identity, not noise
✓ Org profiles emerge naturally from collective memory
✓ Connector integrations enrich knowledge retrieval without poisoning identity
✓ Facts are backed by evidence and user intent
The 10-week timeline balances speed (P0 blocking pollution in 2 weeks) with depth (P1-P3 enabling intelligence).


