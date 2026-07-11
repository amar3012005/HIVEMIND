import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashEnterpriseOnboardingCode } from '../src/billing/enterprise-access.js';

const [label, hostingMode = 'managed', days = '14'] = process.argv.slice(2);
const validDays = Number(days);
if (!label || !['managed', 'self_host', 'any'].includes(hostingMode) || !Number.isInteger(validDays) || validDays < 1 || validDays > 90) {
  throw new Error('usage: node scripts/issue-enterprise-onboarding-code.mjs <label> <managed|self_host|any> <days>');
}
const code = crypto.randomBytes(32).toString('hex');
const prisma = new PrismaClient();
try {
  await prisma.enterpriseOnboardingCode.create({
    data: { codeHash: hashEnterpriseOnboardingCode(code), label, hostingMode: hostingMode === 'any' ? null : hostingMode, expiresAt: new Date(Date.now() + validDays * 86400000) },
  });
  console.log(`https://enterprise.singulancelabs.com/hivemind/login?create=1#enterprise_code=${code}`);
} finally {
  await prisma.$disconnect();
}
