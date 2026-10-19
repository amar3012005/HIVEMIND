/** Scoped lifecycle calls; never pass provider tokens back to the browser. */
export async function eraseNativeAccount({operationId,workerId},fetcher=fetch) {
 const endpoint=process.env.ACCOUNT_ERASURE_NATIVE_URL,token=process.env.ACCOUNT_ERASURE_NATIVE_TOKEN;
 if(!endpoint||!token)throw Object.assign(new Error('Native account erasure is not configured'),{code:'NATIVE_ERASURE_UNAVAILABLE'});
 const response=await fetcher(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operationId,workerId}),signal:AbortSignal.timeout(90000)});
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result?.verified||result.operationId!==operationId||!result.credentialsRemoved||!result.computersRemoved)throw Object.assign(new Error('Native cleanup is not verified'),{code:/^[a-z_]{3,80}$/.test(result?.error||'')?`NATIVE_${result.error.toUpperCase()}`:'NATIVE_ERASURE_INCOMPLETE'});
 return result;
}
