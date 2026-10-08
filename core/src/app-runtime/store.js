/** Opt-in AppSpec runtime. Uses an injected existing pg pool; never opens a new pool. */
import { randomUUID, createHash } from 'node:crypto';
import { effectiveRoles } from '../auth/permissions.js';
import { AppRuntimeError, validateAppSpec, validateRecordData } from './contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ = new Set(['org_owner','org_admin','team_lead','member','viewer','compliance_admin']);
const WRITE = new Set(['org_owner','org_admin','team_lead','member']);
const MANAGE = new Set(['org_owner','org_admin']);
export function fail(code, message, details = {}) { throw new AppRuntimeError(code, message, details); }
function uuid(value, name) { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_arguments', `${name} must be a UUID`); return value; }
function version(value) { if (!Number.isSafeInteger(value) || value < 1) fail('invalid_arguments','expectedVersion must be a positive integer'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function projectApp(row) { return {id:row.id,version:row.current_version,publishedVersion:row.published_version,spec:row.spec,createdAt:row.created_at,updatedAt:row.updated_at}; }
function projectRecord(row) { return {id:row.id,appId:row.app_id,entityId:row.entity_id,version:row.version,data:row.data,createdAt:row.created_at,updatedAt:row.updated_at}; }

export class AppRuntimeStore {
  constructor({pool,transactionRunner}) {
    if (!pool?.connect && typeof transactionRunner !== 'function') throw new TypeError('An existing pool or transaction runner is required');
    this.pool = pool; this.transactionRunner = transactionRunner;
  }
  async transaction(principal, capability, body) {
    uuid(principal?.orgId,'authenticated orgId'); uuid(principal?.userId,'authenticated userId');
    const execute = async (client) => {
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",[principal.orgId,principal.userId]);
      const {rows:[membership]} = await client.query('SELECT role,roles,is_active FROM hivemind.app_runtime_lock_membership($1::uuid,$2::uuid)',[principal.orgId,principal.userId]);
      const allowed = capability === 'manage' ? MANAGE : capability === 'write' ? WRITE : READ;
      const roles = membership?.roles??[];
      const legacyKnown = ['owner','admin','org_owner','org_admin','team_lead','member','viewer','compliance_admin'].includes(membership?.role);
      const resolvedRoles = roles.length ? effectiveRoles(membership) : [{owner:'org_owner',admin:'org_admin'}[membership?.role]??membership?.role];
      if (!membership?.is_active || (roles.length ? roles.some(role=>!READ.has(role)) : !legacyKnown) || !resolvedRoles.some(role => allowed.has(role))) fail('forbidden','Active organization membership with the required role is needed');
      return body(client,principal);
    };
    if (this.transactionRunner) return this.transactionRunner(principal, execute);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); const result = await execute(client);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async mutate(principal,capability,action,input,body) {
    if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(input.operationId)) fail('invalid_arguments','operationId must be a stable identifier (1–180 characters)');
    const hash = createHash('sha256').update(JSON.stringify(canonical({action,...input}))).digest('hex');
    return this.transaction(principal,capability,async (db,p) => {
      // Serialize equal operation IDs, then return the committed receipt verbatim.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock',[`${p.orgId}:${p.userId}:${input.operationId}`]);
      const {rows:[receipt]} = await db.query('SELECT request_hash,result FROM hivemind.app_runtime_operations WHERE org_id=$1::uuid AND user_id=$2::uuid AND operation_id=$3',[p.orgId,p.userId,input.operationId]);
      if (receipt) { if (receipt.request_hash !== hash) fail('idempotency_conflict','operationId was already used with a different request'); return receipt.result; }
      const result = await body(db,p);
      await db.query('INSERT INTO hivemind.app_runtime_operations(org_id,user_id,operation_id,request_hash,result) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb)',[p.orgId,p.userId,input.operationId,hash,JSON.stringify(result)]);
      return result;
    });
  }
  async readApp(db,p,appId,{lock=false,published=false}={}) {
    uuid(appId,'appId');
    // Acquire the app lock before reading its immutable version. Under READ
    // COMMITTED, a joined SELECT FOR UPDATE can recheck an updated app pointer
    // after waiting while its original snapshot cannot see the new version row.
    // A second statement gets the post-lock snapshot and reports version_conflict.
    if (lock) {
      const {rows:[locked]} = await db.query('SELECT id FROM hivemind.app_runtime_apps WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE',[p.orgId,appId]);
      if (!locked) fail('not_found','Application not found');
    }
    const {rows:[row]} = await db.query(`SELECT a.*,v.spec FROM hivemind.app_runtime_apps a JOIN hivemind.app_runtime_versions v ON v.org_id=a.org_id AND v.app_id=a.id AND v.version=${published?'a.published_version':'a.current_version'} WHERE a.org_id=$1::uuid AND a.id=$2::uuid`,[p.orgId,appId]);
    if (row && published) row.current_version = row.published_version;
    if (!row) fail('not_found',published?'Published application not found':'Application not found'); return row;
  }
  async audit(db,p,appId,input,action,subjectId,details={}) {
    await db.query('INSERT INTO hivemind.app_runtime_audit(org_id,app_id,user_id,operation_id,action,subject_id,details) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb)',[p.orgId,appId,p.userId,input.operationId,action,subjectId,JSON.stringify(details)]);
  }
  async insertVersion(db,p,appId,n,spec) {
    await db.query('INSERT INTO hivemind.app_runtime_versions(org_id,app_id,version,spec,created_by) VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid)',[p.orgId,appId,n,JSON.stringify(spec),p.userId]);
    for (const entity of spec.entities) await db.query('INSERT INTO hivemind.app_runtime_entities(org_id,app_id,entity_id) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT DO NOTHING',[p.orgId,appId,entity.id]);
  }
  createDraft(principal,input) {
    const spec = validateAppSpec(input.spec);
    return this.mutate(principal,'manage','draft',{...input,spec},async(db,p)=>{
      const id=randomUUID(); await db.query('INSERT INTO hivemind.app_runtime_apps(id,org_id,created_by,current_version) VALUES($1::uuid,$2::uuid,$3::uuid,1)',[id,p.orgId,p.userId]);
      await this.insertVersion(db,p,id,1,spec); await this.audit(db,p,id,input,'draft',id,{version:1});
      return {app:projectApp(await this.readApp(db,p,id))};
    });
  }
  get(principal,appId) { return this.transaction(principal,'read',async(db,p)=>({app:projectApp(await this.readApp(db,p,appId))})); }
  getPublished(principal,appId) { return this.transaction(principal,'read',async(db,p)=>({app:projectApp(await this.readApp(db,p,appId,{published:true}))})); }
  queryWorkflowReceipts(principal,appId) { return this.transaction(principal,'read',async(db,p)=>{
    await this.readApp(db,p,appId,{published:true});
    const {rows}=await db.query("SELECT id,title,status,graph_version,started_at,completed_at,created_at FROM hivemind.hq_workflows WHERE org_id=$1::uuid AND context->'app_runtime'->>'app_id'=$2 ORDER BY created_at DESC,id LIMIT 51",[p.orgId,appId]);
    return {workflows:rows.slice(0,50).map(row=>({id:row.id,title:row.title,status:row.status,graphVersion:row.graph_version,startedAt:row.started_at,completedAt:row.completed_at,createdAt:row.created_at})),truncated:rows.length>50};
  }); }
  list(principal,{published=false,limit,after=null,query}={}) {
    const paged=limit!==undefined||after!==null||query!==undefined;
    const size=limit??25;
    if(paged&&(!Number.isInteger(size)||size<1||size>25)) fail('invalid_arguments','limit must be 1–25');
    if(after!==null) uuid(after,'after');
    if(query!==undefined&&(typeof query!=='string'||!query.trim()||query.trim().length>120)) fail('invalid_arguments','query must be 1–120 characters');
    // Discovery is an admin authoring capability; legacy published UI lists retain read access.
    return this.transaction(principal,paged?'manage':'read',async(db,p)=>{
      const sql=`SELECT a.id,a.current_version,a.published_version,a.created_at,a.updated_at,v.spec->>'name' AS name FROM hivemind.app_runtime_apps a JOIN hivemind.app_runtime_versions v ON v.org_id=a.org_id AND v.app_id=a.id AND v.version=${published?'a.published_version':'a.current_version'} WHERE a.org_id=$1::uuid`;
      const {rows}=paged
        ? await db.query(`${sql} AND ($2::uuid IS NULL OR a.id>$2::uuid) AND ($3::text IS NULL OR strpos(lower(v.spec->>'name'),lower($3::text))>0) ORDER BY a.id LIMIT $4`,[p.orgId,after,query?.trim()??null,size+1])
        : await db.query(`${sql} ORDER BY a.updated_at DESC,a.id LIMIT 101`,[p.orgId]);
      const selected=rows.slice(0,paged?size:100);
      const apps=selected.map(row=>({id:row.id,name:row.name,version:published?row.published_version:row.current_version,publishedVersion:row.published_version,createdAt:row.created_at,updatedAt:row.updated_at}));
      const truncated=rows.length>selected.length;
      return {apps,truncated,...(paged?{nextCursor:truncated?selected.at(-1)?.id??null:null}:{})};
    });
  }
  patch(principal,appId,input) {
    version(input.expectedVersion); const spec=validateAppSpec(input.spec);
    return this.mutate(principal,'manage','patch',{appId,...input,spec},async(db,p)=>{
      const app=await this.readApp(db,p,appId,{lock:true});
      if(app.current_version!==input.expectedVersion) fail('version_conflict','Application changed; reload before editing',{currentVersion:app.current_version});
      // Records are organization-wide published data. Draft changes requiring a
      // backfill cannot be published through v1. Explicit migration is future work.
      await this.checkCompatibility(db,p,appId,app.spec,spec);
      const next=app.current_version+1; await this.insertVersion(db,p,appId,next,spec);
      await db.query('UPDATE hivemind.app_runtime_apps SET current_version=$3,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid',[p.orgId,appId,next]);
      await this.audit(db,p,appId,input,'patch',appId,{version:next}); return {app:projectApp(await this.readApp(db,p,appId))};
    });
  }
  async checkCompatibility(db,p,appId,oldSpec,spec) {
    const {rows:[{count}]}=await db.query('SELECT count(*)::int AS count FROM hivemind.app_runtime_records WHERE org_id=$1::uuid AND app_id=$2::uuid',[p.orgId,appId]);
    if(!count) return;
    // Reject destructive edits once data exists. Scan existing rows in bounded
    // pages to detect required/enum changes, without loading the entire CRM.
    for(const oldEntity of oldSpec.entities) {
      const next=spec.entities.find(e=>e.id===oldEntity.id);
      if(!next) fail('migration_required','Removing an entity requires an explicit data migration',{entityId:oldEntity.id});
      for(const f of oldEntity.fields) {
        const nf=next.fields.find(x=>x.id===f.id);
        if(!nf || nf.type!==f.type || nf.targetEntityId!==f.targetEntityId || JSON.stringify(nf.source??{type:'local'})!==JSON.stringify(f.source??{type:'local'})) fail('migration_required','Removing/changing an existing field requires an explicit data migration',{entityId:oldEntity.id,fieldId:f.id});
      }
    }
    let after=null;
    do {
      const {rows}=await db.query('SELECT id,entity_id,data FROM hivemind.app_runtime_records WHERE org_id=$1::uuid AND app_id=$2::uuid AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 250',[p.orgId,appId,after]);
      for(const record of rows) { try { validateRecordData(spec,record.entity_id,record.data); } catch(error) { fail('migration_required','Existing records do not satisfy this definition',{recordId:record.id,cause:error.code}); } }
      after=rows.length===250?rows[rows.length-1].id:null;
    } while(after);
  }
  validate(principal,appId) { return this.transaction(principal,'read',async(db,p)=>({valid:true,spec:validateAppSpec((await this.readApp(db,p,appId)).spec)})); }
  publish(principal,appId,input) {
    version(input.expectedVersion);
    return this.mutate(principal,'manage','publish',{appId,...input},async(db,p)=>{
      const app=await this.readApp(db,p,appId,{lock:true});
      if(app.current_version!==input.expectedVersion) fail('version_conflict','Application changed; review the current version',{currentVersion:app.current_version});
      const spec=validateAppSpec(app.spec);
      if(app.published_version) {const prior=await this.readApp(db,p,appId,{published:true}); await this.checkCompatibility(db,p,appId,prior.spec,spec);}
      await db.query('UPDATE hivemind.app_runtime_apps SET published_version=current_version,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid',[p.orgId,appId]);
      await this.audit(db,p,appId,input,'publish',appId,{version:app.current_version}); return {app:projectApp(await this.readApp(db,p,appId))};
    });
  }
  queryRecords(principal,appId,{entityId,limit=25,after=null}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>100) fail('invalid_arguments','limit must be 1–100'); if(after) uuid(after,'after');
    return this.transaction(principal,'read',async(db,p)=>{
      const app=await this.readApp(db,p,appId,{published:true});
      if(!app.spec.entities.some(e=>e.id===entityId)) fail('invalid_arguments','Unknown entityId');
      const {rows}=await db.query('SELECT * FROM hivemind.app_runtime_records WHERE org_id=$1::uuid AND app_id=$2::uuid AND entity_id=$3 AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT $5',[p.orgId,appId,entityId,after,limit+1]);
      const records=[]; let bytes=0;
      for(const row of rows.slice(0,limit)) {
        const record=projectRecord(row); const size=Buffer.byteLength(JSON.stringify(record),'utf8');
        if(records.length&&bytes+size>512*1024) break;
        records.push(record);bytes+=size;
      }
      return {records,nextCursor:rows.length>records.length?records.at(-1)?.id??null:null};
    });
  }
  async references(db,p,appId,spec,entityId,recordId,data) {
    const entity=spec.entities.find(e=>e.id===entityId);
    await db.query('DELETE FROM hivemind.app_runtime_record_relations WHERE org_id=$1::uuid AND app_id=$2::uuid AND from_record_id=$3::uuid',[p.orgId,appId,recordId]);
    for(const field of entity.fields.filter(f=>f.type==='reference')) {
      const target=data[field.id]; if(target===undefined||target===null) continue; uuid(target,field.id);
      const {rows:[row]}=await db.query('SELECT id FROM hivemind.app_runtime_records WHERE org_id=$1::uuid AND app_id=$2::uuid AND entity_id=$3 AND id=$4::uuid FOR KEY SHARE',[p.orgId,appId,field.targetEntityId,target]);
      if(!row) fail('invalid_reference','Reference must target an existing record in this organization, application and entity',{fieldId:field.id});
      await db.query('INSERT INTO hivemind.app_runtime_record_relations(org_id,app_id,from_record_id,field_id,to_record_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid)',[p.orgId,appId,recordId,field.id,target]);
    }
  }
  writeRecord(principal,appId,input,recordId=null) {
    if(recordId) {uuid(recordId,'recordId'); version(input.expectedVersion);}
    return this.mutate(principal,'write',recordId?'record.update':'record.create',{appId,recordId,...input},async(db,p)=>{
      // Serialize against publication so a write cannot validate against a stale schema.
      const app=await this.readApp(db,p,appId,{published:true,lock:true});
      let existing;
      if(recordId) {
        ({rows:[existing]}=await db.query('SELECT * FROM hivemind.app_runtime_records WHERE org_id=$1::uuid AND app_id=$2::uuid AND id=$3::uuid FOR UPDATE',[p.orgId,appId,recordId]));
        if(!existing) fail('not_found','Record not found'); if(existing.version!==input.expectedVersion) fail('version_conflict','Record changed; reload before editing',{currentVersion:existing.version});
      }
      const entityId=existing?.entity_id??input.entityId;
      const entity=app.spec.entities.find(e=>e.id===entityId); if(!entity) fail('invalid_arguments','Unknown entityId');
      for(const field of entity.fields) if(field.source && field.source.type!=='local' && Object.hasOwn(input.data??{},field.id)) fail('read_only_field','External and derived fields require a governed integration',{fieldId:field.id});
      const data=validateRecordData(app.spec,entityId,{...(existing?.data??{}),...validateRecordData(app.spec,entityId,input.data,{partial:Boolean(existing)})});
      const id=recordId??randomUUID();
      if(existing) await db.query('UPDATE hivemind.app_runtime_records SET data=$4::jsonb,version=version+1,updated_by=$5::uuid,updated_at=now() WHERE org_id=$1::uuid AND app_id=$2::uuid AND id=$3::uuid',[p.orgId,appId,id,JSON.stringify(data),p.userId]);
      else await db.query('INSERT INTO hivemind.app_runtime_records(id,org_id,app_id,entity_id,data,created_by,updated_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::uuid,$6::uuid)',[id,p.orgId,appId,entityId,JSON.stringify(data),p.userId]);
      await this.references(db,p,appId,app.spec,entityId,id,data);
      await this.audit(db,p,appId,input,existing?'record.update':'record.create',id,{entityId,version:(existing?.version??0)+1});
      const {rows:[row]}=await db.query('SELECT * FROM hivemind.app_runtime_records WHERE org_id=$1::uuid AND app_id=$2::uuid AND id=$3::uuid',[p.orgId,appId,id]); return {record:projectRecord(row)};
    });
  }
}
