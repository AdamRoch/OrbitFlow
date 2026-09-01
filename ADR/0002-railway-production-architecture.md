# ADR 0002: Deploy OrbitFlow as isolated Railway services

**Status:** Accepted
**Date:** 2026-08-31
**Decision owner:** Adam
**Accepted:** 2026-08-31
**Implementation:** Not started

## Context

OrbitFlow's accepted local deployment uses Docker Compose to separate the web
application, PostgreSQL migrator, workflow engine, OpenClaw gateway, tool
broker, coding executor, and Telegram worker. That topology has useful trust
boundaries, but several containers exchange data through shared volumes and
Unix sockets.

Railway runs each service in a separate container. Its private network carries
TCP traffic, not Unix sockets, and one service cannot mount another service's
volume. Railway also does not implement Compose startup dependencies. Copying
the Compose file into Railway would therefore produce services that cannot
communicate through their production paths.

The current Railway deployment is the disposable SQLite-era application. It is
not a compatibility target. Railway Pro remains the selected hosting platform,
and the application may change to fit a sound Railway deployment.

ADR 0001 remains binding. PostgreSQL is the only durable ticket, control-plane,
message, and execution database. The workflow engine owns assignment. Agents do
not choose workflow transitions. Ambiguous provider effects fail closed.

## Decision

OrbitFlow will run as isolated Railway services connected through authenticated
private network contracts. Production code will not require shared volumes or
cross-service Unix sockets.

One Railway project will contain separate `staging` and `production`
environments. Each environment will have its own private network, PostgreSQL
database, artifact bucket, variables, credentials, and deployments. Production
will deploy only a reviewed candidate commit that passed the staging gates.

### Service boundaries

| Service | Responsibility | Credentials | Durable local volume | Exposure |
| --- | --- | --- | --- | --- |
| `web` | Next.js Monitoring, agent and workflow editors, authenticated operator APIs | PostgreSQL and operator authentication | None | Public HTTPS |
| `platform` | Message consumer, workflow dispatcher, scheduler, invocation reservation, tool authorization, artifact authority, and export authorization | PostgreSQL, artifact bucket, internal signing keys | None | Private only |
| `openclaw-runtime` | Persistent OpenClaw gateway, agent workspace synchronization, and bounded runtime invocation | OpenRouter runtime key and internal RPC key | OpenClaw state only | Private only |
| `coding-executor` | OpenCode execution in an isolated ephemeral workspace | OpenRouter coding key and internal RPC key | None | Private only |
| `telegram` | grammY long polling, sender allowlist, inbound persistence, and outbound delivery | PostgreSQL and Telegram bot token | None | No inbound public listener |
| `migrate` | Apply the exact forward-only PostgreSQL migration chain as a release operation | PostgreSQL | None | One-shot command |

PostgreSQL and the artifact bucket are Railway-provisioned project resources.
They are not built from the OrbitFlow repository.

The `platform` service combines processes that already share one trust level:
they may read authoritative workflow state and perform guarded PostgreSQL
mutations, but they receive no provider credential. Combining them does not add
a second owner for assignment, routing, tickets, or messages.

### OpenClaw runtime contract

`openclaw-runtime` will run one supervised OpenClaw gateway process in the
foreground. Railway supervises the service container. The service owns one
persistent volume containing OpenClaw configuration, gateway state, agent
workspaces, and session files. It runs one replica in v1.

The service receives a canonical invocation request through a private RPC
endpoint. The request fixes the invocation id, request hash, agent snapshot,
model, prompt, session identity, allowed tool context, and deadline. The runtime
returns only the validated output contract, completion metadata, and usage. It
has no PostgreSQL credential and cannot change workflow state.

Before calling the runtime, `platform` reserves the invocation and its request
hash in PostgreSQL and takes the existing same-agent advisory lock. A lost RPC
response, platform crash, runtime crash, or uncertain provider start does not
authorize another provider call. Recovery marks the invocation indeterminate
unless complete durable evidence proves the result. This preserves the current
fail-closed rule without giving the runtime database access.

### Tool authorization

Railway private networking is transport isolation, not caller authorization.
Every runtime tool request must carry a short-lived dispatch capability signed
by `platform`. The capability binds the run, agent, node, ticket, dispatch,
lease generation, allowed operation, request hash, and expiration.

The broker reloads the authoritative dispatch in PostgreSQL and rejects a stale,
replayed, broadened, cross-run, or cross-ticket request. The signed capability
does not replace that database check.

### Coding execution and workspace artifacts

The coding executor will not mount a shared workspace and will not receive
PostgreSQL or long-lived artifact-bucket credentials.

For each coding operation, `platform` creates an immutable input revision and
issues presigned URLs scoped to the exact input and output object keys. The
executor downloads the input into ephemeral storage, runs the bounded OpenCode
adapter under the existing run-specific Unix identity, and uploads one output
revision. It returns the object identity, byte count, SHA-256 digest, usage, and
bounded result metadata.

`platform` validates the output size, digest, archive structure, path rules,
file types, and workspace ownership before recording the revision. PostgreSQL
stores the authoritative run, owner, revision, state, object key, byte count,
and digest. The bucket stores immutable bytes only. It does not own workflow or
approval state.

Export first checks the current PostgreSQL ticket and tester verdicts, then
downloads the exact approved revision and verifies its digest again. Unknown,
unfinished, rejected, replaced, or quarantined revisions remain unexportable.

### Factory output modes

Every Software Factory run records `factory.outputMode` in its immutable run
spec. Other workflow templates omit the `factory` object and define their own
outputs:

* `downloadable` produces an approved source archive for CLIs, libraries,
  scripts, and projects Adam wants to run or publish himself.
* `web_service` produces an approved web service with its build command, start
  command, health path, port behavior, and required variable names. OrbitFlow
  does not publish it.
* `railway_app` produces the same deployable revision and records a request for
  an explicit post-approval Railway publish action.

Channel intake infers `downloadable` for CLIs, libraries, and scripts,
`web_service` for hosted web applications and APIs, and `railway_app` only when
the operator explicitly requests Railway deployment. It asks a clarification
question when the requested product does not make the choice clear.

Publishing never occurs during model execution. A later operator action must
recheck approval, select the exact recorded revision, and deploy the generated
application into a separate Railway project. Generated code never runs inside
OrbitFlow's own services or receives OrbitFlow credentials.

The storage implementation will use the S3 API and immutable object keys. This
is one storage contract, not a general multi-provider repository framework. A
Railway Bucket is the default for non-sensitive staging and demo work. Storage
of customer source code requires an explicit at-rest encryption and retention
decision before launch.

### Access boundary

The recommended v1 boundary is one authenticated operator. Every web route is
authenticated, including read routes, mutation routes, question answers,
schedules, state streams, and exports. Telegram accepts messages only from an
explicit allowlist of Adam's durable Telegram user or chat identifiers.

Multi-user accounts, tenant isolation, roles, public workflow submission, and
customer source-code storage are outside this ADR. Adding them requires a
separate authorization and tenancy decision.

### Readiness and deployment

Each persistent service has separate liveness and readiness checks. Readiness
must establish its real dependency boundary:

* `web` requires the exact PostgreSQL migration head.
* `platform` requires the exact migration head and successful consumer and
  dispatcher polling.
* `openclaw-runtime` requires the pinned gateway, valid configuration, writable
  state volume, model catalog, and authenticated RPC listener.
* `coding-executor` requires the pinned OpenCode adapter and authenticated RPC
  listener. It must not contact a provider during readiness.
* `telegram` requires valid local configuration and a successful database poll.
  Provider delivery remains runtime work rather than a startup side effect.

Railway service definitions, Dockerfiles, health paths, start commands,
variable names, and volume mount paths must live in the repository or in a
checked deployment manifest. A dashboard-only setting is not release evidence.
Every deployed service must identify the same candidate Git SHA.

The migration command remains serialized by its PostgreSQL advisory lock. A
migration with a writer-quiescence precondition requires the platform service
to stop before it runs. Service restart policy is not a substitute for ordered
release control.

### Scaling boundary

V1 is single-region and does not claim high availability.

`openclaw-runtime`, `platform`, and `telegram` each run one replica. This matches
the current scheduler and local OpenClaw session contracts. The web service may
scale after state-stream behavior is proven behind more than one replica. The
coding executor may scale after the network job contract proves claim,
idempotency, timeout, and result races.

Later horizontal scaling must continue to use PostgreSQL leases and locks for
workflow ownership. It must not add an in-memory coordinator.

## Proof required before production

The production candidate must prove all of the following:

1. Local and Railway staging use the same network RPC and object-artifact paths.
   No production behavior falls back to shared sockets or shared volumes.
2. Every service starts with only its allowed credentials. The web, platform,
   Telegram, and migrator processes receive no provider key. The runtime and
   coding executor receive no PostgreSQL credential.
3. Internal RPC rejects missing, expired, replayed, modified, cross-run,
   cross-ticket, and stale-generation capabilities.
4. Clean PostgreSQL installation, retained-data upgrade, exact migration
   readiness, and writer-quiesced migration behavior pass on the selected
   PostgreSQL major version.
5. Runtime and platform restarts before provider start, during provider work,
   after provider completion, and before result persistence never duplicate an
   ambiguous external effect.
6. Coding input and output revisions survive executor and platform restarts;
   tampering, path escape, symlinks, special files, digest mismatch, and stale
   revisions fail closed.
7. The real Telegram Software Factory demo completes its question, rejection,
   correction, approval, Monitoring, cost, and final-report path against one
   durable run.
8. The approved workspace exports by run id, passes its generated tests outside
   Railway, and matches the PostgreSQL-recorded digest.
9. An unauthenticated web request and a non-allowlisted Telegram sender cannot
   read state, mutate state, or spend provider credit.
10. Staging credentials, database rows, artifacts, and private service addresses
    cannot reach their production counterparts.

## Cutover from the current Railway deployment

The old deployment remains available only as rollback protection during the
replacement. Before removing it, retain its service and deployment identifiers,
domain settings, a recoverable volume backup, the final read-only SQLite
preflight, UTC timestamp, and candidate Git SHA.

Deploy and prove the new topology in staging first. Then create a clean
production environment, run its release migration, complete one production
smoke run, move `orbitflow.adamroch.com`, and verify health and authentication.
Only then remove the old app, PostgreSQL service, and volumes. Adam has approved
their eventual removal, but deletion is not an acceptable first deployment
step.

## Why this shape

Network contracts and immutable artifacts remove the host-filesystem assumption
that blocks Railway deployment. Each service can restart, deploy, and later
scale within a named trust boundary.

The platform keeps database authority and checks every action at the moment of
use. Provider-facing services cannot mutate workflow state. Presigned object
operations give the coding executor access to one job's bytes without handing
it the artifact store or another run's workspace.

The design also keeps the current safety rule for external effects. Durable
reservation happens before provider work, and uncertainty stops automatic
replay.

## Consequences

OrbitFlow must add authenticated RPC protocols, timeouts, request limits,
capability signing, and deterministic error contracts. Private networking alone
is insufficient.

Workspace handling changes from mutable shared directories to immutable
revisions. Local Compose and proof scripts must exercise the same object and RPC
paths as Railway rather than preserving a second local-only architecture.

The OpenClaw runtime remains a single volume-backed process in v1. Railway can
restart it, but a volume-backed redeployment has a short interruption and is
not high availability.

The service count and deployment configuration grow. In return, credentials,
failure ownership, persistence, and scaling limits become explicit.

## Rejected alternatives

### Translate Compose directly into Railway services

Rejected because Railway services cannot share the existing socket and volume
paths. A deployment that starts but cannot execute the broker path is not a
partial success.

### Put the entire execution plane in one Railway service

Rejected as the target architecture because one parent container would receive
both PostgreSQL and provider credentials, collapse the proven network boundary,
and prevent independent executor scaling. It remains a possible temporary
diagnostic, not the production design.

### Keep the Compose topology on a general-purpose virtual machine

Rejected because Railway Pro is the selected platform and Adam has authorized a
clean redesign. A virtual machine would preserve the filesystem coupling and
move operating-system, firewall, backup, and deployment ownership into this
project.

### Add Kafka, Redis, or Kubernetes

Rejected because PostgreSQL already owns durable messages, leases, locks, and
workflow transitions at the required scale. These systems would add another
failure domain without removing the current filesystem coupling.

### Make the artifact bucket authoritative

Rejected because object listings and filenames do not decide run ownership,
approval, or current revision. PostgreSQL records those facts and the exact
digest.

### Give provider-facing services a PostgreSQL credential

Rejected because it lets runtime or coding compromise bypass the broker and
mutate authoritative workflow state.

### Expose OpenClaw or internal RPC publicly

Rejected because only the operator web application needs inbound public access.
Telegram uses outbound long polling. Internal services remain on Railway's
environment-scoped private network and still authenticate each request.

## Accepted access boundary

Adam approved the recommended v1 access boundary on 2026-08-31. OrbitFlow v1
has one authenticated operator. It does not allow public or multi-tenant
workflow submission. Telegram accepts only Adam's allowlisted identifiers.

## Platform references

- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Railway environments](https://docs.railway.com/environments)
- [Railway staging and production isolation](https://docs.railway.com/guides/isolate-staging-production)
- [Railway volume behavior and limitations](https://docs.railway.com/volumes/reference)
- [Railway storage buckets](https://docs.railway.com/storage-buckets)
- [Railway build and deployment behavior](https://docs.railway.com/build-deploy)
