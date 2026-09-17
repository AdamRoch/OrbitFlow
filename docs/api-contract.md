# Local API contract

Same-origin JSON API on /api. Types in src/shared/types.ts. Errors are {error:string} with non-2xx status. POST/PATCH bodies are JSON. IDs generated server-side for create.

- GET /api/agents -> Agent[]; POST /api/agents (Agent without id) -> Agent; PUT /api/agents/:id (Agent) -> Agent; DELETE /api/agents/:id -> {ok:true}. Reject referenced agents.
- GET /api/schedules -> ScheduleStatus[] with each agent's enabled state and persisted next wake. A scheduled workflow must contain the scheduling agent; scheduled request messages use `schedule:<agentId>` provenance.
- GET /api/workflows -> Workflow[]; POST /api/workflows (Workflow without id) -> Workflow; PUT /api/workflows/:id -> Workflow; DELETE /api/workflows/:id -> {ok:true}.
- GET /api/templates -> Workflow[]; POST /api/templates/:id/load -> Workflow (editable independent copy, with copied agents).
- GET /api/runs -> Run[]; POST /api/runs {workflowId?:string,agentId?:string,prompt:string,parentRunId?:string} -> Run. Exactly one workflow or agent. parentRunId supplies an approved application revision to improve and is mandatory when workflow.requiresSource is true.
- GET /api/runs/:id -> RunDetail, including approvalToken while approval is pending and the immutable agent/workflow execution snapshot; POST /api/runs/:id/cancel -> Run; POST /api/runs/:id/resume -> Run for a failed run with reconciled cost, continuing from its retained node and snapshot; POST /api/runs/:id/usage-reconciliation {totalRunCostUsd:number,inputTokens?:number,outputTokens?:number,note:string} -> Run for an inactive unknown-cost run, using an explicit provider receipt rather than an inferred charge; POST /api/runs/:id/approval {approved:boolean,feedback?:string,approvalToken:string} -> Run. The exact pending token is required so a stale action cannot approve a later turn or revision.
- GET /api/revisions/:id/source -> {files:{path:string,content:string}[]}; GET /api/revisions/:id/preview -> {url:string} (separate local origin).
- GET /api/settings -> Settings (no secrets). Provider credentials and Telegram credentials are server environment configuration; UI shows setup instructions/status.
- GET /api/events is SSE, data contains an Event, event type 'update'; clients refetch relevant state. Also heartbeat comments.

Statuses: queued, running, awaiting_approval, completed, failed, cancelled. User approval applies before an agent turn when approval=always and to preview release when any participating agent approval=publish. Rejection records feedback and returns to agent for revision. Each workflow node declares `terminalOutcomes`. Resolution checks an exact edge, then an explicit terminal outcome, then a `*` edge. Any other outcome fails the run while retaining its result and artifact revision for inspection.

UI must expose every Agent field, visual draggable nodes and editable edges/conditions (including loops), two loadable templates, runs/messages/tool events and approval/cancel, source and staged/approved preview. Use no secret inputs in UI. Proposed server 4310, Vite 4311, preview 4312 bound loopback.
