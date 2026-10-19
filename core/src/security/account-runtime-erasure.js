/** Remove owned native Runtime references before deleting their human identity. */
export async function cleanupAccountRuntimeReferences(prisma, userId, orgIds) {
  return prisma.$transaction(async tx => {
    // Shared company scheduling survives its creator; transfer only explicit
    // lifecycle ownership to an authenticated surviving member.
    const memberships=await tx.userOrganization.findMany({where:{userId},select:{orgId:true}});
    for(const {orgId} of memberships.filter(x=>!orgIds.includes(x.orgId))){
      const replacement=await tx.userOrganization.findFirst({where:{orgId,userId:{not:userId}},orderBy:{userId:'asc'}});
      if(!replacement)continue;
      for(const table of ['harness_dream_settings','harness_dream_runs','harness_dream_due','harness_dream_connector_settings','harness_dream_connector_evidence','harness_scheduled_tasks','harness_scheduled_due','harness_company_hq']){
        const columns=await tx.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='hivemind' AND table_name=$1 AND column_name IN ('org_id','user_id','actor_user_id')",table);
        const names=columns.map(x=>x.column_name);if(!names.includes('org_id'))continue;
        for(const column of names.filter(x=>x!=='org_id'))await tx.$executeRawUnsafe(`UPDATE hivemind.${table} SET ${column}=$3::uuid WHERE org_id=$2::uuid AND ${column}=$1::uuid`,userId,orgId,replacement.userId);
      }
    }
    const tables = ['harness_dream_settings','harness_dream_runs','harness_dream_due','harness_dream_connector_evidence','harness_scheduled_tasks','harness_company_hq'];
    const present = new Set();
    for (const table of tables) {
      const rows = await tx.$queryRawUnsafe('SELECT to_regclass($1)::text AS relation', `hivemind.${table}`);
      if (!rows[0]?.relation) continue;
      present.add(table);
      const column = table === 'harness_scheduled_tasks' ? 'actor_user_id' : 'user_id';
      const outside = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM hivemind.${table} WHERE ${column}=$1::uuid AND NOT(org_id=ANY($2::uuid[]))`,userId,orgIds);
      if (outside[0].count) throw Object.assign(new Error('Shared Runtime records need an ownership review before deletion.'), {code:'ERASURE_RUNTIME_SHARED_SCOPE'});
    }
    if (present.has('harness_dream_runs')) {
      for (const table of ['harness_dream_outputs','harness_dream_connector_evidence']) {
        const exists = await tx.$queryRawUnsafe('SELECT to_regclass($1)::text AS relation', `hivemind.${table}`);
        if (exists[0]?.relation) await tx.$executeRawUnsafe(`DELETE FROM hivemind.${table} WHERE run_id IN (SELECT id FROM hivemind.harness_dream_runs WHERE user_id=$1::uuid AND org_id=ANY($2::uuid[]))`,userId,orgIds);
      }
    }
    for (const table of tables.reverse()) {
      if (!present.has(table)) continue;
      const column = table === 'harness_scheduled_tasks' ? 'actor_user_id' : 'user_id';
      await tx.$executeRawUnsafe(`DELETE FROM hivemind.${table} WHERE ${column}=$1::uuid AND org_id=ANY($2::uuid[])`,userId,orgIds);
    }
  });
}
