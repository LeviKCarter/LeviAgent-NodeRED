# LeviAgent Node-RED migration runtime

This repository is the first strangler-migration component beside LeviAgent. It does not replace the Google Sheet ingress or grant Node-RED authority over LeviAgent policy.

## Permanent authority boundary

LeviAgent remains the permanent orchestrator. It owns Requests and Queue ingress,
policy, authorization, idempotency ownership, model routing, promotion, deployment,
and durable audit. Node-RED is optional integration infrastructure: if it is absent,
only an explicitly invoked Node-RED operation fails; the worker and unrelated work
continue normally.

A flow is eligible only when LeviAgent registers its exact localhost endpoint and
the operation uses an external connector plus at least one of scheduling, bounded
retries, or credential isolation. Node-RED may own only fixed connector execution,
bounded retries, credential isolation, and response normalization for that flow.
It may never own Queue state, policy decisions, authorization, AI/model routing,
arbitrary HTTP or Google operations, arbitrary commands, promotion, or deployment.

New flows are added one at a time. Each must prove its fixed schema, idempotency,
bounded failure behavior, structured result, and durable LeviAgent audit before an
equivalent legacy integration path is disabled or removed.

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
- The only Google write surface is `Applications!A1:A1` in the Denver Job
  Application Tracker. The spreadsheet ID, tab, cell, and canonical
  `Application Tier` value are constants.

The active routes are authenticated `GET /leviagent/v1/health` and
`POST /leviagent/v1/invoke/job_tracker_update`. The latter accepts exactly one
fixed canonical value plus LeviAgent-derived request and idempotency identities. It
rejects caller-selected URLs, ranges, spreadsheets, alternate flow names,
noncanonical values, oversized bodies, and writes beyond the single fixed cell.

## Start and verify

Run `Initialize-LeviNodeRed.ps1` from a normal, non-elevated PowerShell session. It creates the local secrets if they do not already exist and starts the pinned container. Run `Test-LeviNodeRedHealth.ps1` to verify the authenticated health endpoint without printing the bearer token.

## Authority split for the first production operation

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

The dedicated `NodeRED Test` tab remains as retained pilot evidence. The first
real migrated operation is intentionally smaller than a generic tracker update:
it can only restore the canonical `Applications!A1` header. Bulk row changes,
appends, and caller-selected ranges remain outside this flow.
