/** Remove owned native Runtime references before deleting their human identity. */
export async function cleanupAccountRuntimeReferences(prisma, userId, orgIds) {
  return prisma.$transaction(async tx => {
    const tables = ['harness_dream_settings','harness_dream_runs','harness_dream_due','harness_dream_connector_evidence','harness_scheduled_tasks'];
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
