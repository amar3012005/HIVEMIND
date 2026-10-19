import {eraseExclusiveVisualAssets} from './account-visual-erasure.js';
/** Explicit ownership policies for non-cascading active account records. Audit receipts retain policy. */
export async function erasePrivateConnectorGrants(prisma,userId,orgIds,{eraseComposio,eraseNango}) {
 await eraseComposio(userId,orgIds);
 for(const row of await prisma.nangoConnection.findMany({where:{userId}})){
  const other=await prisma.nangoConnection.count({where:{userId:{not:userId},providerKey:row.providerKey,connectionId:row.connectionId}});
  if(!other)await eraseNango(row.providerKey,row.connectionId);
 }
 await prisma.nangoConnection.deleteMany({where:{userId}});
}
export async function cleanupPrivateAccountRows(prisma,userId,orgs) {
 const shared=orgs.filter(x=>x.disposition==='retain_shared');
 // Created company objects remain available to the surviving company owner.
 for(const org of shared){
  const owner=org.remainingMembers.slice().sort((a,b)=>(a.role==='owner'?0:1)-(b.role==='owner'?0:1)||a.userId.localeCompare(b.userId))[0]?.userId;
  if(!owner)continue;
  for(const table of ['digital_employees','projects','teams','app_runtime_apps','app_runtime_versions','app_runtime_records','audience_contacts','campaign_plan_versions','org_invites','hyper_approval_rules','workspace_announcements','zernio_org_profiles','webhook_subscriptions']){
   const c=await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND EXISTS(SELECT 1 FROM information_schema.tables t WHERE t.table_schema='hivemind' AND t.table_name=$1 AND t.table_type='BASE TABLE') AND column_name IN ('org_id','created_by')",table);
   if(c.length===2)await prisma.$executeRawUnsafe(`UPDATE hivemind.${table} SET created_by=$3::uuid WHERE created_by::text=$1::text AND org_id::text=$2::text`,userId,org.orgId,owner);
  }
  for(const [table,column] of [['tara_turns','user_id'],['tara_insights','user_id'],['tara_calls','user_id'],['hq_runtimes','owner_user_id'],['hyper_rooms','user_id'],['task_outcome','user_id'],['contacts','user_id'],['meetings','user_id'],['outreach_campaigns','user_id'],['tara_campaigns','user_id'],['visual_generation_jobs','user_id'],['visual_intelligence_runs','user_id'],['web_intel_jobs','user_id'],['campaigns','owner_user_id'],['growth_goals','owner_user_id']]){
   const c=await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND EXISTS(SELECT 1 FROM information_schema.tables t WHERE t.table_schema='hivemind' AND t.table_name=$1 AND t.table_type='BASE TABLE') AND column_name IN ('org_id',$2)",table,column);
   if(c.length===2)await prisma.$executeRawUnsafe(`UPDATE hivemind.${table} SET ${column}=$3::uuid WHERE ${column}::text=$1::text AND org_id::text=$2::text`,userId,org.orgId,owner);
  }
 }
 // Company execution records without user FKs must be explicitly removed from
 // exclusive companies. Shared company records were reassigned above; never erase
 // an unrecognized company record merely because its author is being deleted.
 const exclusive=orgs.filter(x=>x.disposition==='delete_exclusive').map(x=>x.orgId);
 if(exclusive.length && prisma.visualGenerationJob)await eraseExclusiveVisualAssets(prisma,userId,exclusive);
 for(const [table,column] of [['org_invites','created_by'],['tara_turns','user_id'],['tara_insights','user_id'],['tara_calls','user_id'],['task_outcome','user_id'],['contacts','user_id'],['meetings','user_id'],['outreach_campaigns','user_id'],['tara_campaigns','user_id'],['visual_generation_jobs','user_id'],['visual_intelligence_runs','user_id'],['web_intel_jobs','user_id'],['hq_runtimes','owner_user_id']]){
  const c=await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND EXISTS(SELECT 1 FROM information_schema.tables t WHERE t.table_schema='hivemind' AND t.table_name=$1 AND t.table_type='BASE TABLE') AND column_name IN ('org_id',$2)",table,column);
  if(c.length!==2)continue;
  await prisma.$executeRawUnsafe(`DELETE FROM hivemind.${table} WHERE ${column}::text=$1::text AND org_id::text=ANY($2::text[])`,userId,exclusive);
 }
 // These rows are personal scheduling/access/state, not shared company content.
 const tables=['tara_voice_sessions','pending_writes','governed_composio_sessions','x_ads_oauth_states','x_ads_credentials','chatgpt_plan_oauth_attempts','chatgpt_plan_connections','proactive_user_schedules','workspace_notifications','account_admin_notifications','workspace_announcement_deliveries','system_email_deliveries','hivemind_attention_subscriptions','hivemind_native_slack_attention_sources','hivemind_trigger_events','hivemind_trigger_subscriptions','user_entity_identity_links','user_identities','user_profiles','activation_lifecycles','cluster_index','working_sets','durable_chat_continuations','durable_chat_turns','memory_save_operations','connector_sync_jobs','account_ingestion_leases'];
 for(const table of tables){const c=await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND EXISTS(SELECT 1 FROM information_schema.tables t WHERE t.table_schema='hivemind' AND t.table_name=$1 AND t.table_type='BASE TABLE') AND column_name='user_id'",table);if(c.length)await prisma.$executeRawUnsafe(`DELETE FROM hivemind.${table} WHERE user_id::text=$1::text`,userId);}
}
