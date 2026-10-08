const REPORT='mobile.ai_safety_report';
const TRIAGE='mobile.ai_safety_triage';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES=new Set(['reviewing','resolved','dismissed']);
export async function handleMobileSafetyTriage({req,res,pathname,url,prisma,getPlatformAdminSession,parseBody,jsonResponse}) {
  const root='/admin/api/platform/mobile-safety-reports';
  const match=pathname.startsWith(root+'/') ? pathname.slice(root.length+1) : null;
  if(pathname!==root && !match)return false;
  const operator=getPlatformAdminSession(req);
  if(!operator){jsonResponse(res,{error:'Unauthorized'},401);return true;}
  if(!prisma?.auditLog){jsonResponse(res,{error:'Safety report storage unavailable'},503);return true;}
  try {
    if(pathname===root && req.method==='GET') {
      const before=url.searchParams.get('before');
      if(before && !ID.test(before)){jsonResponse(res,{error:'Invalid cursor'},400);return true;}
      const reports=await prisma.auditLog.findMany({where:{eventType:REPORT},orderBy:[{createdAt:'desc'},{id:'desc'}],take:51,...before?{cursor:{id:before},skip:1}:{},select:{id:true,userId:true,createdAt:true,metadata:true}});
      const page=reports.slice(0,50);
      const latest=new Map();
      await Promise.all(page.map(async report => {
        const action=await prisma.auditLog.findFirst({where:{eventType:TRIAGE,resourceId:report.id},orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true,resourceId:true,createdAt:true,metadata:true}});
        if(action)latest.set(report.id,action);
      }));
      jsonResponse(res,{reports:page.map(report=>({...report,triage:latest.get(report.id) || null})),next_cursor:reports.length>50?page.at(-1).id:null});return true;
    }
    if(match && ID.test(match) && req.method==='POST') {
      const body=await parseBody(req);const note=typeof body.note==='string'?body.note.trim():'';
      if(!STATUSES.has(body.status)||note.length<10||note.length>2000){jsonResponse(res,{error:'Valid status and review note of 10–2000 characters required'},400);return true;}
      const report=await prisma.auditLog.findFirst({where:{id:match,eventType:REPORT},select:{id:true}});
      if(!report){jsonResponse(res,{error:'Report not found'},404);return true;}
      const receipt=await prisma.auditLog.create({data:{eventType:TRIAGE,eventCategory:'ai_safety',resourceType:'ai_safety_report',resourceId:report.id,action:body.status,actorType:'platform_admin',sessionId:operator.sessionId,metadata:{status:body.status,note,operator:operator.operator},platformType:'admin'},select:{id:true,createdAt:true}});
      jsonResponse(res,{receipt_id:receipt.id,report_id:report.id,status:body.status,recorded_at:receipt.createdAt},201);return true;
    }
    jsonResponse(res,{error:'Method or report route unavailable'},405);return true;
  } catch {jsonResponse(res,{error:'Safety report operation unavailable'},503);return true;}
}
