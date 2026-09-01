-- Give each channel-started Software Factory run one durable delivery intent.

UPDATE agents
SET system_prompt = system_prompt || E'\n\nThe ready intake shape above is replaced by this exact Software Factory shape: {"intake":{"status":"ready","spec":{"objective":"clear objective","acceptanceCriteria":["testable result"],"constraints":["known constraint"],"factory":{"outputMode":"downloadable"}}}}. factory.outputMode must be exactly "downloadable", "web_service", or "railway_app". Infer "downloadable" for CLIs, libraries, scripts, and source-only requests. Infer "web_service" for web apps and APIs that should be runnable as a hosted service but were not explicitly requested for Railway. Use "railway_app" only when the user explicitly requests Railway deployment. Ask one clarification question only when the requested product does not make the choice clear. A railway_app run prepares approved deployable source; never claim that deployment occurred during the factory run.'
WHERE name = 'Factory Orchestrator'
  AND system_prompt NOT LIKE E'%The ready intake shape above is replaced by this exact Software Factory shape%';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nHonor runSpec.factory.outputMode when planning. "downloadable" needs an approved source artifact only. "web_service" must include runnable build and start commands, a health path, port behavior, and required environment variable names, but no deployment. "railway_app" has the same deployable-source requirements and records a later explicit Railway publish request. Do not create a ticket that claims to deploy the app during this factory run.'
WHERE name = 'Factory Planner'
  AND system_prompt NOT LIKE E'%Honor runSpec.factory.outputMode when planning%';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nFor web_service or railway_app, create one implementation ticket that requires orbitflow.deploy.json with exactly this shape: {"schemaVersion":1,"buildCommand":"non-blank command","startCommand":"non-blank command","healthPath":"/health","port":{"environmentVariable":"PORT","default":3000},"requiredEnvironmentVariables":[],"publishIntent":"none"}. Use publishIntent "railway" only for railway_app. Name every required environment variable without including PORT. The service must bind to process.env.PORT and may use the manifest default only when PORT is absent.'
WHERE name = 'Factory Planner'
  AND system_prompt NOT LIKE E'%create one implementation ticket that requires orbitflow.deploy.json%';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nWhen the run spec output mode is web_service or railway_app, implement the ticket\'s web service and exact orbitflow.deploy.json contract. The health path must return success without contacting optional external providers. For railway_app, prepare deployable source and set publishIntent to "railway", but never claim or attempt an external deployment.'
WHERE name = 'Factory Implementer'
  AND system_prompt NOT LIKE E'%implement the ticket\'s web service and exact orbitflow.deploy.json contract%';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nFor web_service or railway_app, reject unless orbitflow.deploy.json matches the run spec, the build command succeeds, the start command binds to process.env.PORT, the health path succeeds, and every required environment variable name is listed. Source and a publishing request are not proof of deployment. Never report an external deployment as completed during this workflow.'
WHERE name = 'Factory Tester'
  AND system_prompt NOT LIKE E'%reject unless orbitflow.deploy.json matches the run spec%';
