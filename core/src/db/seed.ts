/**
 * HIVE-MIND Database Seed Script
 * 
 * Seeds the PostgreSQL database with development data for testing.
 * Creates sample users, organizations, memories, and platform integrations.
 * 
 * Usage: 
 *   npm run db:seed
 *   npx ts-node src/db/seed.ts
 * 
 * Compliance: GDPR, NIS2, DORA
 * Data Residency: EU (DE/FR/FI)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ==========================================
// SEED DATA
// ==========================================

const seedData = {
  organizations: [
    {
      zitadelOrgId: 'org_dev_001',
      name: 'HIVE-MIND Development',
      slug: 'hivemind-dev',
      dataResidencyRegion: 'eu-central',
      complianceFlags: ['GDPR', 'NIS2', 'DORA'],
      hsmProvider: 'ovhcloud',
    },
    {
      zitadelOrgId: 'org_dev_002',
      name: 'Test Organization',
      slug: 'test-org',
      dataResidencyRegion: 'eu-west',
      complianceFlags: ['GDPR'],
      hsmProvider: 'ovhcloud',
    },
  ],

  users: [
    {
      zitadelUserId: 'user_dev_001',
      email: 'admin@hivemind.dev',
      displayName: 'Admin User',
      timezone: 'Europe/Berlin',
      locale: 'en',
    },
    {
      zitadelUserId: 'user_dev_002',
      email: 'developer@hivemind.dev',
      displayName: 'Developer User',
      timezone: 'Europe/Paris',
      locale: 'en',
    },
    {
      zitadelUserId: 'user_dev_003',
      email: 'tester@hivemind.dev',
      displayName: 'Test User',
      timezone: 'UTC',
      locale: 'de',
    },
  ],

  platformIntegrations: [
    {
      platformType: 'chatgpt',
      platformUserId: 'chatgpt_user_001',
      platformDisplayName: 'ChatGPT Integration',
      authType: 'oauth2',
      oauthScopes: ['memory:read', 'memory:write', 'session:read'],
      isActive: true,
      syncStatus: 'idle',
    },
    {
      platformType: 'claude',
      platformUserId: 'claude_user_001',
      platformDisplayName: 'Claude Integration',
      authType: 'api_key',
      isActive: true,
      syncStatus: 'idle',
    },
  ],

  memories: [
    {
      content: 'User prefers TypeScript for backend development',
      memoryType: 'preference',
      title: 'Backend Language Preference',
      tags: ['programming', 'typescript', 'backend'],
      sourcePlatform: 'chatgpt',
      strength: 0.9,
      importanceScore: 0.8,
      visibility: 'private',
    },
    {
      content: 'User is building HIVE-MIND, a cross-platform context preservation system',
      memoryType: 'fact',
      title: 'Project: HIVE-MIND',
      tags: ['project', 'hivemind', 'context'],
      sourcePlatform: 'claude',
      strength: 1.0,
      importanceScore: 1.0,
      visibility: 'organization',
    },
    {
      content: 'Use PostgreSQL 15 with Apache AGE for graph-based memory storage',
      memoryType: 'decision',
      title: 'Database Architecture Decision',
      tags: ['database', 'postgresql', 'architecture'],
      sourcePlatform: 'chatgpt',
      strength: 0.95,
      importanceScore: 0.9,
      visibility: 'private',
    },
    {
      content: 'EU data sovereignty is critical for compliance (GDPR, NIS2, DORA)',
      memoryType: 'lesson',
      title: 'Compliance Requirements',
      tags: ['compliance', 'gdpr', 'eu'],
      sourcePlatform: 'claude',
      strength: 0.85,
      importanceScore: 0.95,
      visibility: 'organization',
    },
    {
      content: 'Implement HYOK (Hold Your Own Key) encryption pattern with OVHcloud HSM',
      memoryType: 'goal',
      title: 'Encryption Strategy',
      tags: ['security', 'encryption', 'hyok'],
      sourcePlatform: 'chatgpt',
      strength: 0.8,
      importanceScore: 0.85,
      visibility: 'private',
    },
  ],

  sessions: [
    {
      platformType: 'chatgpt',
      platformSessionId: 'session_chatgpt_001',
      title: 'HIVE-MIND Architecture Discussion',
      messageCount: 25,
      tokenCount: 15000,
      contextWindowUsed: 12000,
    },
    {
      platformType: 'claude',
      platformSessionId: 'session_claude_001',
      title: 'Database Schema Design',
      messageCount: 18,
      tokenCount: 12000,
      contextWindowUsed: 10000,
    },
  ],
};

// ==========================================
// SEED FUNCTIONS
// ==========================================

/**
 * Seed organizations
 */
async function seedOrganizations() {
  console.log('Seeding organizations...');
  
  const createdOrgs = [];
  
  for (const orgData of seedData.organizations) {
    const org = await prisma.organization.upsert({
      where: { slug: orgData.slug },
      update: orgData,
      create: orgData,
    });
    createdOrgs.push(org);
    console.log(`  Created organization: ${org.name} (${org.slug})`);
  }
  
  return createdOrgs;
}

/**
 * Seed users and assign to organizations
 */
async function seedUsers(organizations: any[]) {
  console.log('Seeding users...');
  
  const createdUsers = [];
  
  for (const userData of seedData.users) {
    const user = await prisma.user.upsert({
      where: { email: userData.email },
      update: userData,
      create: userData,
    });
    createdUsers.push(user);
    console.log(`  Created user: ${user.displayName} (${user.email})`);
    
    // Assign user to first organization with admin role
    if (organizations.length > 0) {
      await prisma.userOrganization.upsert({
        where: {
          userId_orgId: {
            userId: user.id,
            orgId: organizations[0].id,
          },
        },
        update: {
          role: userData.email.includes('admin') ? 'owner' : 'member',
          joinedAt: new Date(),
        },
        create: {
          userId: user.id,
          orgId: organizations[0].id,
          role: userData.email.includes('admin') ? 'owner' : 'member',
          joinedAt: new Date(),
        },
      });
      console.log(`    Assigned to organization: ${organizations[0].name}`);
    }
  }
  
  return createdUsers;
}

/**
 * Seed platform integrations for users
 */
async function seedPlatformIntegrations(users: any[]) {
  console.log('Seeding platform integrations...');
  
  const createdIntegrations = [];
  
  // Assign integrations to first user (admin)
  const adminUser = users[0];
  
  for (const integrationData of seedData.platformIntegrations) {
    const integration = await prisma.platformIntegration.upsert({
      where: {
        userId_platformType: {
          userId: adminUser.id,
          platformType: integrationData.platformType as any,
        },
      },
      update: integrationData,
      create: {
        ...integrationData,
        userId: adminUser.id,
      },
    });
    createdIntegrations.push(integration);
    console.log(`  Created integration: ${integration.platformDisplayName}`);
  }
  
  return createdIntegrations;
}

/**
 * Seed memories with relationships
 */
async function seedMemories(users: any[], organizations: any[]) {
  console.log('Seeding memories...');
  
  const createdMemories = [];
  const adminUser = users[0];
  const org = organizations[0];
  
  for (const memoryData of seedData.memories) {
    const memory = await prisma.memory.create({
      data: {
        ...memoryData,
        userId: adminUser.id,
        orgId: memoryData.visibility === 'organization' ? org.id : null,
        documentDate: new Date(),
      },
    });
    createdMemories.push(memory);
    console.log(`  Created memory: ${memory.title || memory.content.substring(0, 50)}...`);
  }
  
  // Create relationships between memories
  if (createdMemories.length >= 2) {
    // Create an "Extends" relationship
    await prisma.relationship.create({
      data: {
        fromId: createdMemories[1].id, // HIVE-MIND fact
        toId: createdMemories[0].id,   // TypeScript preference
        type: 'Extends',
        confidence: 0.9,
        createdBy: 'system',
      },
    });
    console.log('  Created relationship: Extends');
    
    // Create a "Derives" relationship
    await prisma.relationship.create({
      data: {
        fromId: createdMemories[3].id, // Compliance lesson
        toId: createdMemories[1].id,   // HIVE-MIND fact
        type: 'Derives',
        confidence: 0.85,
        createdBy: 'system',
      },
    });
    console.log('  Created relationship: Derives');
  }
  
  return createdMemories;
}

/**
 * Seed sessions
 */
async function seedSessions(users: any[]) {
  console.log('Seeding sessions...');
  
  const createdSessions = [];
  const adminUser = users[0];
  
  for (const sessionData of seedData.sessions) {
    const session = await prisma.session.create({
      data: {
        ...sessionData,
        userId: adminUser.id,
        startedAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000), // Random time in last week
      },
    });
    createdSessions.push(session);
    console.log(`  Created session: ${session.title}`);
  }
  
  return createdSessions;
}

/**
 * Seed vector embeddings metadata
 */
async function seedVectorEmbeddings(memories: any[]) {
  console.log('Seeding vector embeddings...');
  
  const createdEmbeddings = [];
  
  for (const memory of memories) {
    const embedding = await prisma.vectorEmbedding.create({
      data: {
        memoryId: memory.id,
        qdrantCollection: 'hivemind_memories',
        qdrantPointId: memory.id,
        syncStatus: 'synced',
      },
    });
    createdEmbeddings.push(embedding);
  }
  
  console.log(`  Created ${createdEmbeddings.length} vector embeddings`);
  return createdEmbeddings;
}

/**
 * Main seed function
 */
async function main() {
  console.log('🌱 Starting HIVE-MIND database seed...\n');
  
  try {
    // Check database connection
    await prisma.$connect();
    console.log('✅ Connected to database\n');
    
    // Seed in dependency order
    const organizations = await seedOrganizations();
    console.log();
    
    const users = await seedUsers(organizations);
    console.log();
    
    const integrations = await seedPlatformIntegrations(users);
    console.log();
    
    const memories = await seedMemories(users, organizations);
    console.log();
    
    const sessions = await seedSessions(users);
    console.log();
    
    await seedVectorEmbeddings(memories);
    console.log();
    
    // Summary
    console.log('✅ Database seeded successfully!\n');
    console.log('Summary:');
    console.log(`  - Organizations: ${organizations.length}`);
    console.log(`  - Users: ${users.length}`);
    console.log(`  - Platform Integrations: ${integrations.length}`);
    console.log(`  - Memories: ${memories.length}`);
    console.log(`  - Relationships: 2`);
    console.log(`  - Sessions: ${sessions.length}`);
    console.log(`  - Vector Embeddings: ${memories.length}`);
    console.log('\n⚠️  Note: This is development seed data. Do not use in production.');
    
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run seed
main();
