/** Bounded technical diagnostics only; never accepts logs, credentials or arbitrary recipient fields. */
const evidenceKinds = new Set(['tool_result','task_receipt','schema_validation','coverage_gap']);
const fields = ['owner','agent_index','tool','expected','observed','recovery','prevention','evidence','functional_area','task_context','impact','proposed_fix'];
const unsafe = /(?:\b(?:bearer|basic)\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:https?|postgres(?:ql)?|redis):\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b)/i;
function fail(){const error=new Error('unsafe_or_invalid_support_detail');error.status=400;throw error;}
export function validateTechnicalDetails(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k))||!['runtime','hyperagent'].includes(value.owner))fail();
 if(value.owner==='hyperagent'&&(!Number.isInteger(value.agent_index)||value.agent_index<1||value.agent_index>1000))fail();
 if(value.owner==='runtime'&&value.agent_index!==undefined)fail();
 if(value.tool!==undefined&&(typeof value.tool!=='string'||!/^[a-z][a-z0-9_.:-]{0,119}$/.test(value.tool)))fail();
 const result={owner:value.owner};
 if(value.functional_area!==undefined){if(!['marketing','finance','sales','operations','product','engineering','hr','support','other'].includes(value.functional_area))fail();result.functional_area=value.functional_area;}
 if(value.agent_index!==undefined)result.agent_index=value.agent_index;
 if(value.tool!==undefined)result.tool=value.tool;
 for(const key of ['expected','observed','recovery','prevention','task_context','impact','proposed_fix']){
  if(['task_context','impact','proposed_fix'].includes(key)&&value[key]===undefined)continue;
  const text=value[key];if(typeof text!=='string'||!text.trim()||text!==text.trim()||text.length>1200||/[\u0000-\u001f\u007f]/.test(text)||unsafe.test(text))fail();result[key]=text;
 }
 if(!Array.isArray(value.evidence)||value.evidence.length<1||value.evidence.length>5)fail();
 result.evidence=value.evidence.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['kind','turn','sequence'].includes(k))||!evidenceKinds.has(item.kind))fail();
  const out={kind:item.kind};for(const key of ['turn','sequence'])if(item[key]!==undefined){if(!Number.isInteger(item[key])||item[key]<1||item[key]>10000000)fail();out[key]=item[key];}return out;
 });return result;
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderRuntimeSupportReport(report,organizationName){
 const greeting=`Hi admin, this is Runtime from ${organizationName}`;
 const reviewNote=report.coverage.missing>0
  ?'Some employee reviews are missing. Findings below cover the available evidence; unreviewed work may have additional issues.'
  :report.coverage.expected===0?'No employee reviews were available for this occurrence. Findings below cover Runtime’s available evidence.'
  :'All expected employee reviews were inspected. Findings below describe the evidenced issues and proposed improvements.';
 const lines=[greeting,`Nightly report · ${report.occurrence}`,reviewNote];
 const cards=report.issues.map((issue,index)=>{
  const label=value=>value.replaceAll('_',' ');
  const head=`${index+1}. ${label(issue.capability)} — ${label(issue.code)}`;lines.push('',head,`Severity: ${issue.severity}`,`Cause assessment: ${issue.cause}`);
  const d=issue.details;if(!d){lines.push('Detailed technical evidence was not supplied.');return `<section><h2>${escape(head)}</h2><p>Severity: ${escape(issue.severity)} · Cause assessment: ${escape(issue.cause)}</p><p>Detailed technical evidence was not supplied.</p></section>`;}
  const owner=d.owner==='runtime'?'Runtime':`HyperAgent ${d.agent_index}`;
  const rows=[['Severity',issue.severity],['Cause assessment',issue.cause],['Reporter',owner],...(d.functional_area?[['Functional area',d.functional_area]]:[]),...(d.task_context?[['Work context / blockage',d.task_context]]:[]),...(d.impact?[['Impact',d.impact]]:[]),...(d.proposed_fix?[['Proposed fix',d.proposed_fix]]:[]),...(d.tool?[['Tool',d.tool]]:[]),['Expected',d.expected],['Observed',d.observed],['Recovery',d.recovery],['Prevention',d.prevention],['Evidence',d.evidence.map(e=>`${e.kind}${e.turn?` · turn ${e.turn}`:''}${e.sequence?` · sequence ${e.sequence}`:''}`).join('; ')]];
  for(const [key,value]of rows)lines.push(`${key}: ${value}`);
  return `<section style="margin:24px 0;padding:20px;border:1px solid #dbe4ef;border-radius:12px"><h2 style="font-size:18px">${escape(head)}</h2><dl>${rows.map(([key,value])=>`<dt style="font-weight:700;margin-top:12px">${escape(key)}</dt><dd style="margin:4px 0;white-space:pre-wrap">${escape(value)}</dd>`).join('')}</dl></section>`;
 }).join('');
 if(!report.issues.length)lines.push('', 'No failures or blockers were evidenced in the inspected work. This does not establish that unreviewed work is error-free.');
 return {subject:`${organizationName} · Nightly report`,text:lines.join('\n'),html:`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f5f7fb;color:#17243b"><main style="max-width:760px;margin:24px auto;padding:28px;background:white;border-radius:16px"><p>${escape(greeting)}</p><h1>Nightly report</h1><p>Original occurrence: ${escape(report.occurrence)}</p><p>${escape(reviewNote)}</p>${cards||'<p>No failures or blockers were evidenced in the inspected work. This does not establish that unreviewed work is error-free.</p>'}<p>Technical findings are evidence for review, not authority to execute repairs. Delivery is not acknowledgment.</p></main></body></html>`};
}
