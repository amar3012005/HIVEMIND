-- Down migration for 20260623010000_tara_campaigns.
-- Drops in reverse FK order. Idempotent. Used to verify reversibility on the box;
-- Prisma does not auto-apply this (no native down support) — run manually if needed.
DROP TABLE IF EXISTS hivemind.dnc_list;
DROP TABLE IF EXISTS hivemind.consent_ledger;
DROP TABLE IF EXISTS hivemind.tara_call_attempts;
DROP TABLE IF EXISTS hivemind.tara_campaign_contacts;
DROP TABLE IF EXISTS hivemind.tara_campaigns;
