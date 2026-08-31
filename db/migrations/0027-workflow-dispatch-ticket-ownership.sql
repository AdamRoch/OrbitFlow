CREATE UNIQUE INDEX workflow_dispatches_run_node_ticket_active_unique
  ON workflow_dispatches (run_id, node_id, ticket_id)
  WHERE ticket_id IS NOT NULL
    AND status IN ('pending', 'dispatching', 'reconciling', 'active');
