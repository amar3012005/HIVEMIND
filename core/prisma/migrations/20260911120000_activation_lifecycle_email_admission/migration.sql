-- One active pre-Day-0 lifecycle is allowed per recipient.  Invitation and
-- direct-signup paths converge on this key, so reminders cannot duplicate when
-- a recipient arrives through more than one admission route.
--
-- Preserve history rather than deleting legacy duplicate campaigns.  Only the
-- newest active row remains eligible to send; stopped rows retain audit data.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY email_hash
           ORDER BY updated_at DESC, created_at DESC, id ASC
         ) AS position
    FROM hivemind.activation_lifecycles
   WHERE stopped_at IS NULL
)
UPDATE hivemind.activation_lifecycles AS lifecycle
   SET stopped_at = CURRENT_TIMESTAMP,
       stop_reason = 'superseded_duplicate',
       updated_at = CURRENT_TIMESTAMP
  FROM ranked
 WHERE lifecycle.id = ranked.id
   AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS activation_lifecycles_active_email_uq
  ON hivemind.activation_lifecycles (email_hash)
  WHERE stopped_at IS NULL;
