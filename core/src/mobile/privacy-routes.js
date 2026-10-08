// Mobile disclosures and user-submitted safety reports use the existing durable
// audit store. No model output is copied unless the reporter explicitly supplies it.
export const AI_DISCLOSURE_VERSION = '2026-10-08-v1';
export const AI_DISCLOSURE = 'AI features send your prompts, chosen attachments and relevant authorized context to the configured AI provider for processing. Depending on your selected model, providers may include OpenAI, Anthropic, Google, DeepSeek, xAI or Cloudflare. AI output can be inaccurate or inappropriate. Do not share data you are not authorized to disclose. You can withdraw permission in Settings; this stops new AI use on this mobile device, but does not recall data already processed. See the privacy policy for processing and retention details.';
const CONSENT_EVENT = 'mobile.ai_consent';
const REPORT_EVENT = 'mobile.ai_safety_report';
const CATEGORIES = new Set(['harmful','sexual','hate','violence','self_harm','illegal','privacy','misleading','other']);
export async function handleMobilePrivacyRoutes({req,res,pathname,prisma,requireSession,parseBody,jsonResponse}) {
  const consent = pathname === '/v1/mobile/privacy/ai-consent';
  const report = pathname === '/v1/mobile/safety-reports';
  if (!consent && !report) return false;
  if (!(consent && ['GET','POST'].includes(req.method)) && !(report && req.method === 'POST')) {
    jsonResponse(res,{error:'Method not allowed'},405);return true;
  }
  const current = await requireSession(req,res);if (!current) return true;
  if (!prisma?.auditLog) {jsonResponse(res,{error:'Privacy records unavailable'},503);return true;}
  const userId = current.session.userId;
  // Persist by authenticated person; never accept actor/organization from body.
  const where = {userId,eventType:CONSENT_EVENT};
  try {
    if (consent && req.method === 'GET') {
      const latest = await prisma.auditLog.findFirst({where,orderBy:{createdAt:'desc'},select:{id:true,metadata:true,createdAt:true}});
      jsonResponse(res,{version:AI_DISCLOSURE_VERSION,disclosure:AI_DISCLOSURE,granted:latest?.metadata?.version === AI_DISCLOSURE_VERSION && latest?.metadata?.granted === true,receipt_id:latest?.id || null},200);return true;
    }
    const body = await parseBody(req);
    if (consent) {
      if (body.version !== AI_DISCLOSURE_VERSION || typeof body.granted !== 'boolean') {jsonResponse(res,{error:'Current disclosure and explicit choice required'},400);return true;}
      const receipt = await prisma.auditLog.create({data:{userId,eventType:CONSENT_EVENT,eventCategory:'privacy',action:body.granted?'grant':'withdraw',resourceType:'ai_disclosure',metadata:{version:AI_DISCLOSURE_VERSION,granted:body.granted,disclosure:AI_DISCLOSURE},platformType:'mobile'},select:{id:true,createdAt:true}});
      jsonResponse(res,{granted:body.granted,version:AI_DISCLOSURE_VERSION,receipt_id:receipt.id,recorded_at:receipt.createdAt},201);return true;
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!CATEGORIES.has(body.category) || description.length<10 || description.length>4000) {jsonResponse(res,{error:'Choose a category and describe the issue in 10–4000 characters'},400);return true;}
    const messageId = typeof body.message_id === 'string' ? body.message_id.slice(0,200) : null;
    const sessionId = typeof body.session_id === 'string' ? body.session_id.slice(0,200) : null;
    const receipt = await prisma.auditLog.create({data:{userId,eventType:REPORT_EVENT,eventCategory:'ai_safety',action:'report',resourceType:'ai_output',metadata:{category:body.category,description,message_id:messageId,session_id:sessionId,status:'received'},platformType:'mobile'},select:{id:true,createdAt:true}});
    jsonResponse(res,{receipt_id:receipt.id,status:'received',recorded_at:receipt.createdAt},201);return true;
  } catch {
    jsonResponse(res,{error:'Could not save your request. Please retry.'},503);return true;
  }
}
