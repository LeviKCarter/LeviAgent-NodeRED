# LeviAgent Node-RED migration runtime

This repository is the first strangler-migration component beside LeviAgent. It does not replace the Google Sheet ingress or grant Node-RED authority over LeviAgent policy.

## Current boundary

- Docker image is pinned by digest to Node-RED 5.0.4.
- Docker publishes port 1880 only on `127.0.0.1`.
- The Node-RED editor and Admin API are disabled.
- Every HTTP In route is protected by a randomly generated bearer token.
- Runtime secrets live in the ignored `.secrets` directory with Windows ACLs limited to the current user and SYSTEM.
- The container drops Linux capabilities, enables `no-new-privileges`, and uses a read-only root filesystem.
- `functionExternalModules` is disabled.
- The existing LeviAgent Google service-account credential is mounted read-only
  as a Docker secret. Flow functions cannot read it; only the fixed local
  `job_tracker_update` adapter can exchange it for a Sheets token.
- The only Google write surface is `NodeRED Test!A2:F20` in the LeviAgentQueue
  spreadsheet. The spreadsheet ID, tab, columns, and row bounds are constants.

The active routes are authenticated `GET /leviagent/v1/health` and
`POST /leviagent/v1/invoke/job_tracker_update`. The latter accepts exactly one
typed value plus LeviAgent-derived request and idempotency identities. It
rejects caller-selected URLs, ranges, spreadsheets, alternate flow names,
formula-leading values, oversized bodies, conflicting replays, and writes
beyond the dedicated test range.

## Start and verify

Run `Initialize-LeviNodeRed.ps1` from a normal, non-elevated PowerShell session. It creates the local secrets if they do not already exist and starts the pinned container. Run `Test-LeviNodeRedHealth.ps1` to verify the authenticated health endpoint without printing the bearer token.

## Authority split for the pilot flow

LeviAgent retains:

- Sheet request authentication and validation;
- action and workspace allowlists;
- explicit write authorization;
- idempotency-key generation;
- dispatch and outcome audit records.

Node-RED receives one typed `job_tracker_update` payload and owns only:

- the allowlisted Google Sheets request;
- bounded retry and backoff;
- response normalization;
- returning a structured success or failure record.

No real job-tracker range is reachable from this pilot. Migration of a real
operation remains gated on a successful Sheet-to-LeviAgent-to-Node-RED
round trip with matching durable audit evidence.
