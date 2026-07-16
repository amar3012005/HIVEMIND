-- Down migration for 20260716060000_outreach_campaigns (targets first: FK).
DROP TABLE IF EXISTS "hivemind"."outreach_targets";
DROP TABLE IF EXISTS "hivemind"."outreach_campaigns";
