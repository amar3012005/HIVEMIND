/** Versioned attention preferences, stored separately from provider subscription configuration. */
export function validateAttentionSettings(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || value.version!==1 || !Number.isInteger(value.revision) || value.revision<0) throw Error('invalid_attention_settings');
  const allowed=new Set(['version','revision','enabled','disabledActivityTypes','instructions','actions']);
  if(Object.keys(value).some(k=>!allowed.has(k)) || typeof value.enabled!=='boolean' || !Array.isArray(value.disabledActivityTypes) || value.disabledActivityTypes.length>100 || value.disabledActivityTypes.some(t=>typeof t!=='string'||!t||t.length>120) || typeof value.instructions!=='string'||value.instructions.length>4000 || !Array.isArray(value.actions)||!value.actions.length||value.actions.some(a=>!['retain','notify','wake'].includes(a)))throw Error('invalid_attention_settings');
  return value;
}
export async function saveAttentionSettings(db,scope,subscriptionId,settings) {
  validateAttentionSettings(settings);
  const member=await db.userOrganization.findUnique({where:{userId_orgId:{userId:scope.userId,orgId:scope.orgId}},select:{isActive:true,deactivatedAt:true}});
  if(!member?.isActive||member.deactivatedAt)throw Error('attention_scope_denied');
  const rows=await db.$queryRawUnsafe(`UPDATE hivemind_trigger_subscriptions SET config=jsonb_set(config,'{attention_settings}',$1::jsonb),runtime_attention_revision=runtime_attention_revision+1,updated_at=now()
    WHERE id=$2::uuid AND org_id=$3 AND user_id=$4 AND COALESCE((config->'attention_settings'->>'revision')::integer,0)=$5 RETURNING id,runtime_attention_revision`,JSON.stringify({...settings,revision:settings.revision+1}),subscriptionId,scope.orgId,scope.userId,settings.revision);
  if(!rows.length)throw Error('attention_settings_conflict_or_denied');
  return {subscriptionId,settings:{...settings,revision:settings.revision+1},consentRevision:rows[0].runtime_attention_revision};
}
/** Observed/subscribed coverage only; connection is never a guarantee of every event type. */
export async function attentionCoverage(db,scope) {
 const member=await db.userOrganization.findUnique({where:{userId_orgId:{userId:scope.userId,orgId:scope.orgId}},select:{isActive:true,deactivatedAt:true}});
 if(!member?.isActive||member.deactivatedAt)throw Error('attention_scope_denied');
 const subscriptions=await db.$queryRawUnsafe(`SELECT s.toolkit,s.slug AS activity_type,s.status,s.runtime_attention,s.runtime_attention_revision,
   s.config->'attention_settings' AS attention_settings,count(e.id)::integer AS observed_events,max(e.received_at) AS last_received_at
   FROM hivemind_trigger_subscriptions s LEFT JOIN hivemind_trigger_events e ON e.subscription_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id
   WHERE s.org_id=$1 AND s.user_id=$2 GROUP BY s.id ORDER BY s.toolkit,s.slug`,scope.orgId,scope.userId);
 return {subscriptions,universalCoverage:false,savedHiveMessages:'excluded',personalConversationIngestion:'not_enabled',coverageNote:'Only subscribed supported events can arrive; use discover to inventory provider support. Zero observations means delivery is not proved.'};
}
