// Internal company-setup writer. Callers must already enforce workspace admin access.
// Personal identity and preferences never enter this organization projection.
export async function saveCompanyProfileFacts(prisma, { orgId, userId, facts }) {
  if (!orgId || !userId) throw new Error('Company profile requires organization and actor');
  return prisma.$transaction(async tx => {
    for (const fact of facts) {
      if (fact.key !== 'company' && !fact.key.startsWith('company:')) throw new Error('Not a company fact');
      const key = fact.key === 'company' ? 'company.name' : fact.key.replace('company:', 'company.');
      const value = String(fact.value || '').trim().slice(0, fact.key === 'company:operating_context' ? 2400 : 900);
      if (!value) {
        await tx.organizationProfile.updateMany({ where: { orgId, key, deletedAt: null }, data: { deletedAt: new Date(), updatedByUserId: userId, version: { increment: 1 } } });
        continue;
      }
      await tx.organizationProfile.upsert({
        where: { orgId_key: { orgId, key } },
        create: { orgId, key, value, category: 'identity', updatedByUserId: userId },
        update: { value, deletedAt: null, version: { increment: 1 }, updatedByUserId: userId },
      });
    }
  });
}
