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
   const c=await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND column_name IN ('org_id','created_by')",table);
   if(c.length===2)await prisma.$executeRawUnsafe(`UPDATE hivemind.${table} SET created_by=$3::uuid WHERE created_by=$1::uuid AND org_id=$2::uuid`,userId,org.orgId,owner);
  }
 }
 // These rows are personal scheduling/access/state, not shared company content.
 const tables=['pending_writes','governed_composio_sessions','x_ads_oauth_states','x_ads_credentials','chatgpt_plan_oauth_attempts','chatgpt_plan_connections','proactive_user_schedules','workspace_notifications','account_admin_notifications','workspace_announcement_deliveries','hivemind_attention_subscriptions','hivemind_native_slack_attention_sources','hivemind_trigger_subscriptions','user_entity_identity_links','user_identities','user_profiles'];
 for(const table of tables){const c=await prisma.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND column_name='user_id'",table);if(c.length)await prisma.$executeRawUnsafe(`DELETE FROM hivemind.${table} WHERE user_id=$1::uuid`,userId);}
}
