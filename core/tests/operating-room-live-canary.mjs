// Run inside the Control container with RUN_OPERATING_ROOM_CANARY=1.
// Creates only disposable identities; never uses a customer's session.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ControlPlaneSessionStore, getRedisClient } from '/app/src/control-plane/session-store.js';
import { closeOperatingRoomBridge } from '/app/src/operating-room/room-bridge-client.js';
import { deleteRealtimeMeeting } from '/app/src/operating-room/realtimekit-client.js';
if(process.env.RUN_OPERATING_ROOM_CANARY!=='1') throw new Error('Explicit canary opt-in required');
const prisma=new PrismaClient();
const orgId=crypto.randomUUID();const users=[];const sessions=[];let room;
const config={redisUrl:process.env.HIVEMIND_CONTROL_PLANE_REDIS_URL||process.env.REDIS_URL,redisHost:process.env.REDIS_HOST,redisPort:Number(process.env.REDIS_PORT||6379),redisPassword:process.env.REDIS_PASSWORD,sessionTtlSeconds:600};
const store=new ControlPlaneSessionStore(config);
const redis=await getRedisClient(config);if(!redis) throw new Error('Canary requires shared session store');
const base=`http://127.0.0.1:${process.env.CONTROL_PLANE_PORT||process.env.PORT||3010}`;
const call=async(i,path,body)=>{
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${sessions[i]}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
 const data=await response.json();if(!response.ok)throw Object.assign(new Error(`${response.status}:${data.error}:${data.message||''}`),{status:response.status,data});return data;
};
try{
 await prisma.organization.create({data:{id:orgId,zitadelOrgId:`room-canary-${orgId}`,name:'Disposable Operating Room canary',slug:`room-canary-${orgId}`,plan:'enterprise',hostingMode:'managed',memoryStorageMode:'hybrid'}});
 for(let i=0;i<5;i++){
  const id=crypto.randomUUID();users.push(id);
  const email=`room-canary-${id}@example.invalid`;
  await prisma.user.create({data:{id,zitadelUserId:`room-canary-${id}`,email,displayName:`Canary ${i+1}`}});
  await prisma.userOrganization.create({data:{userId:id,orgId,role:i===0?'owner':'member',roles:[i===0?'owner':'member']}});
  sessions.push(await store.createSession({userId:id,orgId,email}));
 }
 room=(await call(0,'/v1/operating-rooms',{name:'Disposable five-person voice canary',goal:'Agree a launch date and budget without inventing facts'})).room;
 for(let i=0;i<5;i++)await call(i,`/v1/operating-rooms/${room.id}/join`,{});
 await call(0,`/v1/operating-rooms/${room.id}/agenda`,{agenda:['Confirm budget','Choose launch date']});
 const speech=['I propose Monday for launch.','The confirmed budget is 700 euros.','I can prepare the launch checklist.','The date is still a proposal, not approved.','HIVEMIND, what budget did Canary 2 confirm and what is still undecided?'];
 const turns=await Promise.all(speech.map((text,i)=>call(i,`/v1/operating-rooms/${room.id}/transcript`,{text,event_id:`canary-${i}`,speaker_user_id:users[0],speaker_name:'Spoofed'})));
 for(let i=0;i<5;i++)assert.equal(turns[i].turn.speaker_user_id,users[i]);
 const retry=await call(4,`/v1/operating-rooms/${room.id}/transcript`,{text:speech[4],event_id:'canary-4'});
 assert.equal(retry.turn.id,turns[4].turn.id);
 assert.equal(await prisma.operatingRoomEvent.count({where:{roomId:room.id,orgId}}),5);
 await assert.rejects(call(0,`/v1/operating-rooms/${room.id}/respond`,{turn_id:turns[4].turn.id}),e=>e.status===404);
 const answer=await call(4,`/v1/operating-rooms/${room.id}/respond`,{turn_id:turns[4].turn.id});
 assert.equal(answer.addressed_user_id,users[4]);assert.ok(answer.speech?.spoken);assert.match(answer.answer,/700/);
 const replay=await call(4,`/v1/operating-rooms/${room.id}/respond`,{turn_id:turns[4].turn.id});assert.equal(replay.replayed,true);assert.equal(replay.answer,answer.answer);
 const projection=(await call(0,`/v1/operating-rooms/${room.id}`)).room;
 assert.equal(projection.participants.length,5);assert.deepEqual(projection.agenda,['Confirm budget','Choose launch date']);
 assert.equal(projection.recent_responses.length,1);
 console.log(JSON.stringify({ok:true,participants:5,identity_verified:true,deduplicated:true,unauthorized_speaker_rejected:true,grounded_budget:true,tara_audio:answer.speech,replay:true,room_id:room.id,answer:answer.answer}));
} finally {
 if(room){await closeOperatingRoomBridge({roomId:room.id}).catch(()=>{});await deleteRealtimeMeeting({meetingId:room.meeting_id}).catch(()=>{});await prisma.operatingRoomEvent.deleteMany({where:{roomId:room.id,orgId}});await prisma.operatingRoomParticipant.deleteMany({where:{roomId:room.id,orgId}});await prisma.hyperRoom.deleteMany({where:{id:room.id,orgId}});}
 for(const session of sessions)await redis.del(`cp:session:${session}`);
 await prisma.userOrganization.deleteMany({where:{orgId}});
 await prisma.organization.deleteMany({where:{id:orgId}});
 await prisma.user.deleteMany({where:{id:{in:users}}});
 await prisma.$disconnect();await redis.quit();
 console.log(JSON.stringify({canary_cleanup:true}));
}
