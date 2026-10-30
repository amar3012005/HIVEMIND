/** Scoped lifecycle calls; never pass provider tokens back to the browser. */
/**
 * Request to the OpenDot controller. Contract 2 (sent whenever the operation's ownership snapshot is known) carries the account and its
 * organizations, so the controller reads nothing from this database; a controller that only knows contract 1 ignores the extra
 * fields and reads the operation itself. The receipt fields Core verifies (`verified`, `operationId`, `credentialsRemoved`,
 * `computersRemoved`) are the same for both contracts; contract 2 adds `contract: 2`.
 */
export function nativeErasureRequest({operationId,workerId,userId,scope}) {
 const organizations=Array.isArray(scope?.organizations)?scope.organizations.map(x=>({orgId:x.orgId,disposition:x.disposition})):null;
 return organizations&&typeof userId==='string'&&userId?{contract:2,operationId,workerId,userId,organizations}:{operationId,workerId};
}
export async function eraseNativeAccount({operationId,workerId,userId,scope},fetcher=fetch) {
 const endpoint=process.env.ACCOUNT_ERASURE_NATIVE_URL,token=process.env.ACCOUNT_ERASURE_NATIVE_TOKEN;
 if(!endpoint||!token)throw Object.assign(new Error('Native account erasure is not configured'),{code:'NATIVE_ERASURE_UNAVAILABLE'});
 const response=await fetcher(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(nativeErasureRequest({operationId,workerId,userId,scope})),signal:AbortSignal.timeout(90000)});
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result?.verified||result.operationId!==operationId||!result.credentialsRemoved||!result.computersRemoved)throw Object.assign(new Error('Native cleanup is not verified'),{code:/^[a-z_]{3,80}$/.test(result?.error||'')?`NATIVE_${result.error.toUpperCase()}`:'NATIVE_ERASURE_INCOMPLETE'});
 return result;
}
