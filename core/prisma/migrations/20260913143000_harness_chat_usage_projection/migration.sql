-- Project committed native Harness usage into the existing HIVE AI ledger.
-- The native session log remains authoritative; this projection is content-free,
-- tenant-attributed, and idempotent across retries, restores, and backfills.

CREATE OR REPLACE FUNCTION hivemind.record_harness_usage(
  p_session_id text,
  p_org_id uuid,
  p_user_id uuid,
  p_sequence bigint,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hivemind
AS $$
DECLARE
  usage_payload jsonb := p_payload #> '{data,usage}';
  input_tokens bigint := 0;
  output_tokens bigint := 0;
  cached_tokens bigint := 0;
  reasoning_tokens bigint := 0;
  selected_model text := 'unknown';
  selected_provider text := 'unknown';
  input_rate bigint := 0;
  output_rate bigint := 0;
  cache_rate bigint := 0;
  input_cost bigint := 0;
  output_cost bigint := 0;
  cache_cost bigint := 0;
  price_found boolean := false;
BEGIN
  IF usage_payload IS NULL OR jsonb_typeof(usage_payload) <> 'object' THEN
    RETURN;
  END IF;

  input_tokens := CASE
    WHEN COALESCE(usage_payload->>'inputTokens', usage_payload->>'input_tokens', usage_payload->>'prompt_tokens', '') ~ '^[0-9]+$'
      THEN COALESCE(usage_payload->>'inputTokens', usage_payload->>'input_tokens', usage_payload->>'prompt_tokens')::bigint
    ELSE 0
  END;
  output_tokens := CASE
    WHEN COALESCE(usage_payload->>'outputTokens', usage_payload->>'output_tokens', usage_payload->>'completion_tokens', '') ~ '^[0-9]+$'
      THEN COALESCE(usage_payload->>'outputTokens', usage_payload->>'output_tokens', usage_payload->>'completion_tokens')::bigint
    ELSE 0
  END;
  cached_tokens := CASE
    WHEN COALESCE(usage_payload->>'cachedTokens', usage_payload->>'cached_tokens', '') ~ '^[0-9]+$'
      THEN COALESCE(usage_payload->>'cachedTokens', usage_payload->>'cached_tokens')::bigint
    ELSE 0
  END;
  reasoning_tokens := CASE
    WHEN COALESCE(usage_payload->>'reasoningTokens', usage_payload->>'reasoning_tokens', '') ~ '^[0-9]+$'
      THEN COALESCE(usage_payload->>'reasoningTokens', usage_payload->>'reasoning_tokens')::bigint
    ELSE 0
  END;

  IF input_tokens + output_tokens + cached_tokens + reasoning_tokens <= 0 THEN
    RETURN;
  END IF;

  SELECT
    LEFT(COALESCE(event.payload #>> '{data,header,config,model}', 'unknown'), 160),
    LEFT(COALESCE(event.payload #>> '{data,header,config,provider}', 'unknown'), 80)
  INTO selected_model, selected_provider
  FROM harness_session_events AS event
  WHERE event.session_id = p_session_id
    AND event.org_id = p_org_id
    AND event.user_id = p_user_id
    AND event.sequence < p_sequence
    AND event.event_type = 'request/header'
  ORDER BY event.sequence DESC
  LIMIT 1;

  selected_model := COALESCE(selected_model, 'unknown');
  selected_provider := COALESCE(selected_provider, 'unknown');

  SELECT
    price.input_micros_per_million,
    price.output_micros_per_million,
    price.cache_read_micros_per_million,
    true
  INTO input_rate, output_rate, cache_rate, price_found
  FROM hivemind.ai_model_prices AS price
  WHERE price.model = selected_model
    AND price.provider IN (selected_provider, '*')
    AND price.effective_from <= now()
    AND (price.effective_to IS NULL OR price.effective_to > now())
  ORDER BY CASE WHEN price.provider = selected_provider THEN 0 ELSE 1 END,
           price.effective_from DESC
  LIMIT 1;

  input_rate := COALESCE(input_rate, 0);
  output_rate := COALESCE(output_rate, 0);
  cache_rate := COALESCE(cache_rate, 0);
  input_cost := GREATEST(input_tokens - cached_tokens, 0) * input_rate / 1000000;
  output_cost := output_tokens * output_rate / 1000000;
  cache_cost := cached_tokens * cache_rate / 1000000;

  INSERT INTO hivemind.ai_usage_events (
    idempotency_key, org_id, user_id, trace_id, use_case,
    requested_model, served_model, provider, request_count,
    prompt_tokens, completion_tokens, cached_prompt_tokens, reasoning_tokens,
    input_cost_micros, output_cost_micros, cache_cost_micros,
    total_cost_micros, pricing_source, applied_pricing, status
  ) VALUES (
    'harness:' || md5(p_session_id) || ':' || p_sequence::text,
    p_org_id, p_user_id, LEFT(p_session_id, 160), 'harness_chat',
    selected_model, selected_model, selected_provider, 1,
    input_tokens, output_tokens, cached_tokens, reasoning_tokens,
    input_cost, output_cost, cache_cost,
    input_cost + output_cost + cache_cost,
    CASE WHEN price_found THEN 'catalog' ELSE 'unpriced' END,
    jsonb_build_object(
      'input_micros_per_million', input_rate::text,
      'output_micros_per_million', output_rate::text,
      'cache_read_micros_per_million', cache_rate::text
    ),
    'completed'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION hivemind.project_harness_usage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hivemind
AS $$
BEGIN
  IF NEW.event_type = 'assistant/message' THEN
    PERFORM hivemind.record_harness_usage(
      NEW.session_id,
      NEW.org_id,
      NEW.user_id,
      NEW.sequence,
      NEW.payload
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS harness_session_events_usage_projection ON harness_session_events;
CREATE TRIGGER harness_session_events_usage_projection
AFTER INSERT ON harness_session_events
FOR EACH ROW
WHEN (NEW.event_type = 'assistant/message')
EXECUTE FUNCTION hivemind.project_harness_usage_event();

-- Reconcile successful native turns committed before this projection existed.
SELECT hivemind.record_harness_usage(
  event.session_id,
  event.org_id,
  event.user_id,
  event.sequence,
  event.payload
)
FROM harness_session_events AS event
WHERE event.event_type = 'assistant/message';

REVOKE ALL ON FUNCTION hivemind.record_harness_usage(text, uuid, uuid, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hivemind.project_harness_usage_event() FROM PUBLIC;
