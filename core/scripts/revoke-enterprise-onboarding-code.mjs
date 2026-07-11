import { PrismaClient } from '@prisma/client';
import { hashEnterpriseOnboardingCode } from '../src/billing/enterprise-access.js';

const [code] = process.argv.slice(2);
if (!code) throw new Error('usage: node scripts/revoke-enterprise-onboarding-code.mjs <enterprise_code>');

const prisma = new PrismaClient();
try {
  const result = await prisma.enterpriseOnboardingCode.updateMany({
    where: { codeHash: hashEnterpriseOnboardingCode(code), usedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count !== 1) throw new Error('Code was not found, was already used, or was already revoked.');
  console.log('Enterprise onboarding code revoked.');
} finally {
  await prisma.$disconnect();
}
