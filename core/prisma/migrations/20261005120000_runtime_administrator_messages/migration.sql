CREATE TABLE hivemind.runtime_administrator_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES hivemind.users(id) ON DELETE CASCADE,
 session_id text NOT NULL,
 message_key varchar(180) NOT NULL,
 content_hash varchar(64) NOT NULL,
 message jsonb NOT NULL,
 status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','accepted','rejected','unknown')),
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (org_id,user_id,session_id,message_key)
);

ALTER TABLE hivemind.runtime_administrator_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.runtime_administrator_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY runtime_message_tenant ON hivemind.runtime_administrator_messages
 USING (org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid)
 WITH CHECK (org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);
