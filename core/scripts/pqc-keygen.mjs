#!/usr/bin/env node
/**
 * Generate PQC signing keypairs and print env lines.
 *   node scripts/pqc-keygen.mjs   →   PQC_MEMORY_SK/PK (ML-DSA-65), PQC_AUDIT_SK/PK (SLH-DSA)
 *
 * Append the printed lines to the server env (NOT git). Public keys may be
 * published; secret keys MUST stay server-side, separate from the database.
 */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { slh_dsa_sha2_128s } from '@noble/post-quantum/slh-dsa.js';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const mem = ml_dsa65.keygen();
const aud = slh_dsa_sha2_128s.keygen();

console.log(`PQC_MEMORY_SK=${b64(mem.secretKey)}`);
console.log(`PQC_MEMORY_PK=${b64(mem.publicKey)}`);
console.log(`PQC_AUDIT_SK=${b64(aud.secretKey)}`);
console.log(`PQC_AUDIT_PK=${b64(aud.publicKey)}`);
