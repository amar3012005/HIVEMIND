// Explicit, idempotent repair. Only the named organization's provenance-tagged
// company onboarding is shared; personal chat memories are never candidates.
import { PrismaClient } from '@prisma/client';
import { getQdrantClient } from '../src/vector/qdrant-client.js';
const orgId=process.argv[2]; const apply=process.argv.includes('--apply');
if(!/^[a-f0-9-]{36}$/i.test(orgId||''))throw new Error('Exact org UUID required');
const p=new PrismaClient();
try{
const org=await p.organization.findUnique({where:{id:orgId}});
if(!org || org.hostingMode==='self_hosted')throw new Error('Organization unavailable or requires remote repair');
const memories=await p.memory.findMany({where:{orgId,sourcePlatform:'hyperagents-onboarding',deletedAt:null},select:{id:true,userId:true,scope:true,visibility:true}});
const rooms=await p.$queryRawUnsafe("SELECT DISTINCT user_id::text FROM hivemind.hyper_rooms WHERE org_id=$1::uuid AND archived_at IS NULL AND agent_connectors ? '_company'",orgId);
const users=rooms.map(r=>r.user_id);
const facts=await p.userProfile.findMany({where:{orgId,userId:{in:users},deletedAt:null,OR:[{key:'company'},{key:{startsWith:'company:'}}]},orderBy:{lastConfirmedAt:'desc'}});
const receipt={orgId,apply,memoryCandidates:memories.length,companyFactCandidates:facts.length,changedMemories:0,createdOrganizationFacts:0,retiredCompanyPersonaFacts:0,vectorUpdates:0};
if(apply){
await p.$transaction(async tx=>{
const seen=new Set();for(const f of facts){const key=f.key==='company'?'company.name':f.key.replace('company:','company.');if(seen.has(key))continue;seen.add(key);
const existing=await tx.organizationProfile.findUnique({where:{orgId_key:{orgId,key}}});
if(!existing){await tx.organizationProfile.create({data:{orgId,key,value:f.value,category:'identity',updatedByUserId:f.userId}});receipt.createdOrganizationFacts++;}}
receipt.retiredCompanyPersonaFacts=(await tx.userProfile.updateMany({where:{id:{in:facts.map(f=>f.id)}},data:{deletedAt:new Date()}})).count;
// Remove only the synthetic HQ location, never a user's stated location.
await tx.userProfile.updateMany({where:{orgId,userId:{in:users},key:'location',value:{startsWith:'Company HQ:'},deletedAt:null},data:{deletedAt:new Date()}});
receipt.changedMemories=(await tx.memory.updateMany({where:{id:{in:memories.map(m=>m.id)},orgId,scope:'personal'},data:{scope:'organization',visibility:'organization'}})).count;
});
const q=getQdrantClient();for(const m of memories){await q.updateMemoryPayload(m.id,{scope:'organization',visibility:'organization'},{orgId});receipt.vectorUpdates++;}
}
console.log(JSON.stringify(receipt));
}finally{await p.$disconnect()}
