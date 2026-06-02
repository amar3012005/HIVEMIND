-- Post-quantum signature side-tables (FIPS 204 ML-DSA / FIPS 205 SLH-DSA).
-- Kept separate from `memories` / `audit_logs` so signing needs no ORM change.
-- Additive only.

-- Per-memory integrity signature (ML-DSA-65).
CREATE TABLE IF NOT EXISTS "memory_signatures" (
    "memory_id"     UUID NOT NULL,
    "org_id"        UUID,
    "alg"           VARCHAR(32) NOT NULL DEFAULT 'ML-DSA-65',
    "payload_hash"  VARCHAR(64) NOT NULL,            -- sha256 of the signed canonical payload
    "signature"     TEXT NOT NULL,                   -- base64 ML-DSA signature
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "memory_signatures_pkey" PRIMARY KEY ("memory_id")
);
CREATE INDEX IF NOT EXISTS "memory_signatures_org_idx" ON "memory_signatures"("org_id");

-- Hash-chained, signed audit trail (SLH-DSA). entry_hash = sha256(prev_hash + payload).
CREATE TABLE IF NOT EXISTS "audit_signatures" (
    "audit_id"    UUID NOT NULL,
    "org_id"      UUID,
    "alg"         VARCHAR(40) NOT NULL DEFAULT 'SLH-DSA-SHA2-128s',
    "prev_hash"   VARCHAR(64) NOT NULL DEFAULT '',
    "entry_hash"  VARCHAR(64) NOT NULL,
    "signature"   TEXT NOT NULL,                     -- base64 SLH-DSA signature over entry_hash
    "seq"         BIGSERIAL,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "audit_signatures_pkey" PRIMARY KEY ("audit_id")
);
CREATE INDEX IF NOT EXISTS "audit_signatures_org_seq_idx" ON "audit_signatures"("org_id", "seq" DESC);
