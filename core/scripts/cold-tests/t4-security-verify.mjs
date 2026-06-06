/**
 * T4 — PQC integrity verification (cold).
 *   - /api/security/pqc reports keys present + status
 *   - /api/security/audit-verify confirms the SLH-DSA hash-chain is intact
 *     (signature valid, linkage intact, no tail regression vs latest checkpoint)
 *
 * Read-only. Never mutates the chain.
 */
import { api, makeReport } from './lib.mjs';

async function main() {
  const r = makeReport('T4-security-verify');

  const pqc = await api('GET', '/api/security/pqc');
  r.check('GET /api/security/pqc 2xx', pqc.ok, `status=${pqc.status}`);
  const pubkeys = pqc.json?.pubkeys || pqc.json?.public_keys || pqc.json;
  r.check('PQC public keys exposed', !!pubkeys && Object.keys(pubkeys || {}).length > 0,
    pqc.json ? Object.keys(pqc.json).join(',') : 'none');

  const av = await api('GET', '/api/security/audit-verify', null, { timeoutMs: 45000 });
  r.check('GET /api/security/audit-verify 2xx', av.ok, `status=${av.status}`);
  const te = av.json?.tamper_evident ?? av.json?.tamperEvident ?? av.json?.valid;
  r.check('audit chain tamper-evident / intact', te === true || te === 'true' || av.json?.ok === true,
    JSON.stringify(av.json || {}).slice(0, 160));

  return r.finish();
}

main().then((result) => {
  console.log(JSON.stringify(result));
  process.exit(result.green ? 0 : 1);
}).catch((e) => { console.error('T4 crashed:', e); process.exit(2); });
