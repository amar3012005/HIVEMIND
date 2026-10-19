const DEFAULT = { version:1, provider:'runtime-character', character:'orbit', asset_version:'1' };
const error = (message,status) => { throw Object.assign(new Error(message),{status}); };
export function validateRuntimeAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version','provider','character','asset_version'].includes(key))
    || value.version !== 1 || value.provider !== 'runtime-character' || value.asset_version !== '1'
    || !['capsule','pebble','prism','orbit','spark','fold'].includes(value.character)) error('invalid_runtime_appearance',400);
  return {version:1,provider:'runtime-character',character:value.character,asset_version:'1'};
}

/** Workspace Runtime identity only. Employee appearance is a separate contract. */
export async function readRuntimeAppearance(db, principal) {
  const membership = await db.userOrganization.findUnique({where:{userId_orgId:{userId:principal.userId,orgId:principal.orgId}}});
  if (!membership?.isActive) error('workspace_membership_required',403);
  const can_edit = ['owner','admin'].includes(membership.role);
  {
    const org = await db.organization.findUnique({where:{id:principal.orgId},select:{companyProfile:true}});
    if (!org) error('workspace_not_found',404);
    const saved = org.companyProfile?.runtimeAppearance;
    let appearance = DEFAULT;
    try { const value = validateRuntimeAppearance(saved?.appearance); if (value?.provider === 'runtime-character') appearance = value; } catch { /* Invalid legacy visual metadata uses the product default. */ }
    return { employee_id:'runtime', appearance, revision:Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : 0, can_edit };
  }

}

/** Serialize workspace Runtime saves and preserve unrelated company-profile fields. */
export async function saveRuntimeAppearance(db, principal, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key=>!['expected_revision','appearance'].includes(key))
    || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) error('invalid_runtime_appearance_request',400);
  const appearance = validateRuntimeAppearance(input.appearance);
  if (appearance?.provider !== 'runtime-character') error('invalid_runtime_appearance_request',400);
  const access = await readRuntimeAppearance(db,principal);
  if (!access.can_edit) error('workspace_administrator_required',403);
  return db.$transaction(async tx=>{
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock',`runtime-appearance:${principal.orgId}`);
    const previous = await readRuntimeAppearance(tx,principal);
    if (!previous.can_edit) error('workspace_administrator_required',403);
    if (previous.revision !== input.expected_revision) error('runtime_appearance_revision_conflict',409);
    const revision = previous.revision+1;
    // JSONB updates only the visual preference; other company-profile fields remain concurrent-safe.
    await tx.$executeRawUnsafe("UPDATE organizations SET company_profile=jsonb_set(COALESCE(company_profile,'{}'::jsonb),'{runtimeAppearance}',$1::jsonb,true),updated_at=now() WHERE id=$2::uuid",JSON.stringify({revision,appearance}),principal.orgId);
    return {employee_id:'runtime',appearance,revision,can_edit:true};
  });
}
