function getPath(value, path) {
  return String(path || '').split('.').filter(Boolean)
    .reduce((current, part) => current == null ? undefined : current[part], value);
}

function referencesAt(artifacts, paths) {
  return artifacts.flatMap((artifact) => paths.map((path) => String(getPath(artifact, path) || '').trim())).filter(Boolean);
}

export function createTenantRecordsAdapter({ prisma } = {}) {
  if (!prisma) throw new Error('runtime_tenant_records_prisma_required');
  return {
    id: 'tenant-records',
    name: 'Tenant records',
    description: 'Verifies that claimed durable records and source artifacts exist inside the current organization.',
    async verify(input, context) {
      const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
      const config = input.config && typeof input.config === 'object' ? input.config : {};
      const recordPaths = Array.isArray(config.record_paths) && config.record_paths.length
        ? config.record_paths.map(String)
        : ['data.persistence_ref'];
      const sourcePaths = Array.isArray(config.source_artifact_paths) ? config.source_artifact_paths.map(String) : [];
      const references = [...new Set(referencesAt(artifacts, recordPaths))];
      if (references.length !== artifacts.length * recordPaths.length) {
        return { passed: false, evidence: [], unmet: [{ predicate: 'record_exists', reason: 'durable_record_reference_missing' }] };
      }
      const rows = await prisma.memory.findMany({
        where: { id: { in: references }, orgId: context.orgId, deletedAt: null, isLatest: true },
        select: { id: true },
      });
      const found = new Set(rows.map((row) => row.id));
      const missing = references.filter((reference) => !found.has(reference));

      const sourceReferences = [...new Set(referencesAt(artifacts, sourcePaths))];
      let sourceRows = [];
      if (sourcePaths.length && sourceReferences.length === artifacts.length * sourcePaths.length) {
        sourceRows = await prisma.sourceArtifact.findMany({
          where: { id: { in: sourceReferences }, orgId: context.orgId },
          select: { id: true },
        });
      }
      const foundSources = new Set(sourceRows.map((row) => row.id));
      const missingSources = sourcePaths.length
        ? sourceReferences.filter((reference) => !foundSources.has(reference))
        : [];
      if (sourcePaths.length && sourceReferences.length !== artifacts.length * sourcePaths.length) {
        missingSources.push('source_artifact_reference_missing');
      }
      return {
        passed: missing.length === 0 && missingSources.length === 0,
        evidence: [
          ...rows.map((row) => ({ type: 'tenant_record', id: row.id })),
          ...sourceRows.map((row) => ({ type: 'source_artifact', id: row.id })),
        ],
        unmet: [
          ...missing.map((reference) => ({ predicate: 'record_exists', reason: `record_not_found:${reference}` })),
          ...missingSources.map((reference) => ({ predicate: 'source_artifact_exists', reason: `source_artifact_not_found:${reference}` })),
        ],
      };
    },
  };
}
