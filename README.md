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
- No Google credential is mounted and no Google write is enabled.

The only active flow is `GET /leviagent/v1/health`. The `job_tracker_update` flow is documentation-only and disabled. It records the future adapter boundary without claiming that the Google Sheets migration is complete.

## Start and verify

Run `Initialize-LeviNodeRed.ps1` from a normal, non-elevated PowerShell session. It creates the local secrets if they do not already exist and starts the pinned container. Run `Test-LeviNodeRedHealth.ps1` to verify the authenticated health endpoint without printing the bearer token.

## Authority split for the first future flow

LeviAgent retains:

- Sheet request authentication and validation;
- action and workspace allowlists;
- explicit write authorization;
- idempotency-key generation;
- dispatch and outcome audit records.

Node-RED may later receive one typed `job_tracker_update` payload and own only:

- the allowlisted Google Sheets request;
- bounded retry and backoff;
- response normalization;
- returning a structured success or failure record.

The disabled pilot must not be enabled until its Google credential handling, exact spreadsheet/range allowlist, idempotency behavior, and failure semantics are reviewed separately.
