#!/usr/bin/env node
/**
 * Backfill KnowledgeSegment evidence vectors into per-tenant org containers
 * (layer=evidence), @1024 bge-m3. Mirrors DocumentFirstIngestion._embedSegments.
 * Closes the gap left by reembed-pg-to-qdrant.mjs (memories only). Idempotent:
 * point id == segment id → upsert. Usage: ORG_ID=<uuid> node ... --commit
 */
import { PrismaClient } from "@prisma/client";
import { getEmbedService } from "/app/src/embeddings/factory.js";
import { resolveCollectionForOrg } from "/app/src/vector/container-router.js";

const COMMIT = process.argv.includes("--commit");
const ORG = process.env.ORG_ID || null;
const CONC = Number(process.env.CONCURRENCY || 8);
const QURL = process.env.QDRANT_URL, QKEY = process.env.QDRANT_API_KEY;
const prisma = new PrismaClient();
const emb = getEmbedService();

async function upsert(col, pts){
  const r = await fetch(`${QURL}/collections/${encodeURIComponent(col)}/points?wait=true`,{
    method:"PUT", headers:{"api-key":QKEY,"Content-Type":"application/json"},
    body:JSON.stringify({points:pts})});
  if(!r.ok) throw new Error(`upsert ${col} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function main(){
  const where = {};
  if (ORG) where.orgId = ORG;
  const total = await prisma.knowledgeSegment.count({ where });
  console.log(`[seg] target ${total} segments${ORG?` org ${ORG}`:" (all)"} mode=${COMMIT?"COMMIT":"DRY"}`);
  if(!COMMIT){ await prisma.$disconnect(); return; }
  const colCache = new Map();
  let off=0, done=0, ok=0, fail=0;
  const BATCH=300;
  while(off<total){
    const rows = await prisma.knowledgeSegment.findMany({ where, skip:off, take:BATCH,
      select:{id:true,content:true,documentId:true,userId:true,orgId:true,segmentType:true} });
    if(!rows.length) break;
    // group by org → collection
    for(let i=0;i<rows.length;i+=CONC){
      const chunk = rows.slice(i,i+CONC);
      const pts = await Promise.all(chunk.map(async s=>{
        try{
          const vec = await emb.embedOne(s.content);
          if(!colCache.has(s.orgId)) colCache.set(s.orgId, await resolveCollectionForOrg(s.orgId));
          return { col: colCache.get(s.orgId), pt:{ id:s.id, vector:vec, payload:{
            segment_id:s.id, document_id:s.documentId, user_id:s.userId, org_id:s.orgId,
            segment_type:s.segmentType, layer:"evidence", content_preview:(s.content||"").slice(0,200) } } };
        }catch(e){ fail++; return null; }
      }));
      // group points by collection then upsert
      const byCol={}; for(const p of pts){ if(!p)continue; (byCol[p.col]=byCol[p.col]||[]).push(p.pt); }
      for(const [col,arr] of Object.entries(byCol)){ try{ await upsert(col,arr); ok+=arr.length; }catch(e){ fail+=arr.length; console.error(e.message); } }
    }
    done+=rows.length; off+=BATCH;
    if(done % 900 === 0 || done>=total) console.log(`  …${done}/${total} ok=${ok} fail=${fail}`);
  }
  console.log(`[seg] DONE ok=${ok} fail=${fail} of ${total}`);
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
