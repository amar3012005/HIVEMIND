/** Compatibility adapter: native Cordis owns the only Runtime attention decision. */
export const RUNTIME_ATTENTION_POLICY='runtime_attention_v3';
export async function assessRuntimeAttention({event,bridge}) {
 if(!bridge || typeof bridge.assess!=='function')return {policy:RUNTIME_ATTENTION_POLICY,action:'retain',reason:'decision_unavailable'};
 return bridge.assess(event);
}
