-- FACT-18 reserves ordinal 0009. The existing schema needs no new state
-- tables; these AFTER triggers make committed PostgreSQL writes wake SSE
-- listeners without turning notification delivery into an authority or log.
CREATE FUNCTION orbitflow_notify_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  row_data JSONB;
  resource TEXT := TG_ARGV[0];
  action TEXT;
  run_id TEXT;
  agent_id TEXT;
  ticket_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;
  action := CASE TG_OP
    WHEN 'INSERT' THEN 'created'
    WHEN 'UPDATE' THEN 'updated'
    WHEN 'DELETE' THEN 'deleted'
  END;
  run_id := CASE
    WHEN resource = 'run' THEN row_data ->> 'id'
    ELSE row_data ->> 'run_id'
  END;
  agent_id := CASE
    WHEN resource = 'agent' THEN row_data ->> 'id'
    WHEN resource = 'ticket' THEN row_data ->> 'assignee_agent_id'
    ELSE row_data ->> 'agent_id'
  END;
  ticket_id := CASE
    WHEN resource = 'ticket' THEN row_data ->> 'id'
    ELSE row_data ->> 'ticket_id'
  END;

  PERFORM pg_notify(
    'orbitflow_state_changed',
    jsonb_build_object(
      'schemaVersion', 1,
      'type', resource || '.' || action,
      'runId', run_id,
      'agentId', agent_id,
      'ticketId', ticket_id,
      'occurredAt', clock_timestamp()
    )::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agents_90_notify_state_stream
AFTER INSERT OR UPDATE OR DELETE ON agents
FOR EACH ROW EXECUTE FUNCTION orbitflow_notify_state_change('agent');

CREATE TRIGGER workflow_runs_90_notify_state_stream
AFTER INSERT OR UPDATE OR DELETE ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION orbitflow_notify_state_change('run');

CREATE TRIGGER tickets_90_notify_state_stream
AFTER INSERT OR UPDATE OR DELETE ON tickets
FOR EACH ROW EXECUTE FUNCTION orbitflow_notify_state_change('ticket');

CREATE TRIGGER messages_90_notify_state_stream
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION orbitflow_notify_state_change('message');

CREATE TRIGGER cost_events_90_notify_state_stream
AFTER INSERT ON cost_events
FOR EACH ROW EXECUTE FUNCTION orbitflow_notify_state_change('cost');
