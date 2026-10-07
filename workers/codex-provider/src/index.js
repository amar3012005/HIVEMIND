/** Dedicated provider ingress; the upstream Codex grant never crosses this boundary. */
const routes = new Set(['/v1/models','/v1/responses','/v1/chat/completions','/v1/web/search','/v1/images/generations','/v1/realtime/start','/v1/realtime/stop'])
const json = (status, message) => new Response(JSON.stringify({error:{message}}), {status,headers:{'content-type':'application/json','cache-control':'no-store'}})
async function authorized(header, key) {
  if (typeof key !== 'string' || key.length < 32 || !header?.startsWith('Bearer ') || header.length > 512) return false
  const encode = new TextEncoder()
  const [left,right] = await Promise.all([header.slice(7),key].map(value=>crypto.subtle.digest('SHA-256',encode.encode(value))))
  const a=new Uint8Array(left),b=new Uint8Array(right); let mismatch=0
  for(let i=0;i<a.length;i++) mismatch|=a[i]^b[i]
  return mismatch===0
}
export default {
  async fetch(request, env) {
    const url=new URL(request.url)
    if (!await authorized(request.headers.get('authorization'),env.PROVIDER_API_KEY)) return json(401,'Provider authentication required')
    if (!routes.has(url.pathname) || url.search) return json(404,'Unknown provider endpoint')
    if ((url.pathname==='/v1/models' && request.method!=='GET') || (url.pathname!=='/v1/models' && request.method!=='POST')) return json(405,'Unsupported method')
    if (typeof env.RUNNER_API_KEY!=='string' || env.RUNNER_API_KEY.length<32) return json(503,'Provider configuration unavailable')
    if (request.method==='POST' && request.headers.get('content-type')?.split(';')[0]!=='application/json') return json(400,'Use application/json')
    if (Number(request.headers.get('content-length')||0)>100000) return json(413,'Request is too large')
    const target=new URL(env.RUNNER_BASE_URL)
    if (target.protocol!=='https:' || target.host!=='next.singulancelabs.com' || target.pathname!=='/api/hivemind/provider/v1') return json(503,'Provider configuration unavailable')
    target.pathname+=url.pathname.slice(3)
    const headers=new Headers({'authorization':`Bearer ${env.RUNNER_API_KEY}`,'content-type':'application/json'})
    const nonce=request.headers.get('idempotency-key'); if(nonce) headers.set('idempotency-key',nonce)
    let size=0
    const stream=request.body?.pipeThrough(new TransformStream({transform(chunk,controller){size+=chunk.byteLength;if(size>100000)throw new Error('request_too_large');controller.enqueue(chunk)}}))
    try {
      const response=await fetch(target,{method:request.method,headers,body:stream,redirect:'error',signal:request.signal})
      const outgoing=new Headers({'cache-control':'no-store','content-type':response.headers.get('content-type')||'application/json'})
      return new Response(response.body,{status:response.status,headers:outgoing})
    } catch { return json(503,'Provider request could not complete') }
  }
}
