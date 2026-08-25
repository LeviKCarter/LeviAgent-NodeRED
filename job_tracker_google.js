"use strict";

const crypto = require("crypto");
const fs = require("fs");

const FLOW_NAME = "job_tracker_update";
const SPREADSHEET_ID = "1exmmZXT7_D07HKRCat0nmL3WI7xnqHw_seIblvF51Ug";
const TEST_SHEET = "NodeRED Test";
const TEST_START_ROW = 2;
const TEST_END_ROW = 20;
const TEST_READ_RANGE = `'${TEST_SHEET}'!A${TEST_START_ROW}:F${TEST_END_ROW}`;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values`;
const MAX_REQUEST_BYTES = 2048;
const MAX_RESPONSE_BYTES = 16384;
const MAX_VALUE_CHARS = 256;

class FlowPolicyError extends Error {
    constructor(message, code = "FLOW_POLICY_REJECTED") {
        super(message);
        this.name = "FlowPolicyError";
        this.code = code;
    }
}

function base64Url(value) {
    return Buffer.from(value).toString("base64url");
}

function stableJsonBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateInvocation(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new FlowPolicyError("Request body must be a JSON object");
    }
    if (stableJsonBytes(input) > MAX_REQUEST_BYTES) {
        throw new FlowPolicyError("Request body exceeds the fixed byte limit");
    }
    const keys = Object.keys(input).sort();
    const expected = ["flow", "idempotency_key", "payload", "request_id"];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new FlowPolicyError("Request body contains unsupported fields");
    }
    if (input.flow !== FLOW_NAME) {
        throw new FlowPolicyError("Only job_tracker_update is supported");
    }
    if (typeof input.request_id !== "string" ||
        !/^REQ-[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(input.request_id)) {
        throw new FlowPolicyError("request_id is invalid");
    }
    if (typeof input.idempotency_key !== "string" ||
        !/^levi-request-[0-9a-f]{20}$/.test(input.idempotency_key)) {
        throw new FlowPolicyError("idempotency_key is invalid");
    }
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload) ||
        Object.keys(input.payload).length !== 1 || !("value" in input.payload)) {
        throw new FlowPolicyError("payload must contain exactly value");
    }
    const value = input.payload.value;
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE_CHARS) {
        throw new FlowPolicyError(`payload.value must contain 1-${MAX_VALUE_CHARS} characters`);
    }
    if (/^[=+\-@]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new FlowPolicyError("payload.value contains a prohibited formula prefix or control character");
    }
    return {
        flow: FLOW_NAME,
        request_id: input.request_id,
        idempotency_key: input.idempotency_key,
        value,
    };
}

function parseCredential(path) {
    const raw = fs.readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
        throw new Error("Google credential file exceeds its fixed size limit");
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== "service_account" ||
        typeof parsed.client_email !== "string" ||
        typeof parsed.private_key !== "string") {
        throw new Error("Google credential file is not a service-account credential");
    }
    return Object.freeze({
        client_email: parsed.client_email,
        private_key: parsed.private_key,
    });
}

function createJobTrackerGoogle(options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    const now = options.now || (() => Date.now());
    const credential = options.credential || parseCredential(
        options.credentialPath || "/run/secrets/google_service_account",
    );
    let cachedToken = null;
    let cachedTokenExpiresAt = 0;

    async function boundedJson(response, label) {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
            throw new Error(`${label} response exceeded its fixed byte limit`);
        }
        let body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch (_error) {
            throw new Error(`${label} returned invalid JSON`);
        }
        if (!response.ok) {
            const code = body && body.error && body.error.code;
            throw new Error(`${label} failed with HTTP ${response.status}${code ? ` (${code})` : ""}`);
        }
        return body;
    }

    async function accessToken() {
        const nowMs = now();
        if (cachedToken && nowMs + 60_000 < cachedTokenExpiresAt) {
            return cachedToken;
        }
        const issuedAt = Math.floor(nowMs / 1000);
        const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const claims = base64Url(JSON.stringify({
            iss: credential.client_email,
            scope: GOOGLE_SCOPE,
            aud: TOKEN_URL,
            iat: issuedAt,
            exp: issuedAt + 3600,
        }));
        const unsigned = `${header}.${claims}`;
        const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), credential.private_key)
            .toString("base64url");
        const assertion = `${unsigned}.${signature}`;
        const response = await fetchImpl(TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion,
            }).toString(),
            signal: AbortSignal.timeout(10_000),
        });
        const body = await boundedJson(response, "Google OAuth");
        if (typeof body.access_token !== "string" || body.access_token.length < 20) {
            throw new Error("Google OAuth returned no usable access token");
        }
        cachedToken = body.access_token;
        cachedTokenExpiresAt = nowMs + Math.min(Number(body.expires_in || 3600), 3600) * 1000;
        return cachedToken;
    }

    async function sheetsRequest(range, init = {}) {
        const token = await accessToken();
        const url = `${SHEETS_BASE}/${encodeURIComponent(range)}${init.query || ""}`;
        const response = await fetchImpl(url, {
            method: init.method || "GET",
            headers: {
                authorization: `Bearer ${token}`,
                ...(init.body ? { "content-type": "application/json" } : {}),
            },
            body: init.body ? JSON.stringify(init.body) : undefined,
            signal: AbortSignal.timeout(10_000),
        });
        return boundedJson(response, "Google Sheets");
    }

    async function readTestRows() {
        const body = await sheetsRequest(TEST_READ_RANGE);
        return Array.isArray(body.values) ? body.values : [];
    }

    function locate(rows, invocation) {
        const matches = [];
        let firstEmptyRow = null;
        for (let offset = 0; offset <= TEST_END_ROW - TEST_START_ROW; offset += 1) {
            const row = Array.isArray(rows[offset]) ? rows[offset] : [];
            const key = String(row[0] || "");
            if (!key && firstEmptyRow === null) {
                firstEmptyRow = TEST_START_ROW + offset;
            }
            if (key === invocation.idempotency_key) {
                matches.push({ sheet_row: TEST_START_ROW + offset, row });
            }
        }
        if (matches.length > 1) {
            throw new FlowPolicyError("Duplicate idempotency records exist in the test range", "FLOW_IDEMPOTENCY_CONFLICT");
        }
        if (matches.length === 1) {
            const match = matches[0];
            if (String(match.row[1] || "") !== invocation.request_id ||
                String(match.row[2] || "") !== FLOW_NAME ||
                String(match.row[3] || "") !== invocation.value ||
                String(match.row[5] || "") !== "applied") {
                throw new FlowPolicyError("Existing idempotency record does not match this request", "FLOW_IDEMPOTENCY_CONFLICT");
            }
            return { existing: match, firstEmptyRow };
        }
        return { existing: null, firstEmptyRow };
    }

    async function invoke(rawInput) {
        const invocation = validateInvocation(rawInput);
        const before = locate(await readTestRows(), invocation);
        if (before.existing) {
            return {
                status: "FLOW_SUCCESS",
                flow: FLOW_NAME,
                request_id: invocation.request_id,
                idempotency_key: invocation.idempotency_key,
                sheet: TEST_SHEET,
                sheet_row: before.existing.sheet_row,
                applied: false,
                replayed: true,
                reconciled_after_error: false,
            };
        }
        if (before.firstEmptyRow === null) {
            throw new FlowPolicyError("Dedicated test range is full", "FLOW_RANGE_FULL");
        }
        const sheetRow = before.firstEmptyRow;
        const writtenAt = new Date(now()).toISOString();
        const values = [[
            invocation.idempotency_key,
            invocation.request_id,
            FLOW_NAME,
            invocation.value,
            writtenAt,
            "applied",
        ]];
        let writeError = null;
        try {
            await sheetsRequest(`'${TEST_SHEET}'!A${sheetRow}:F${sheetRow}`, {
                method: "PUT",
                query: "?valueInputOption=RAW",
                body: { range: `'${TEST_SHEET}'!A${sheetRow}:F${sheetRow}`, majorDimension: "ROWS", values },
            });
        } catch (error) {
            writeError = error;
        }

        const after = locate(await readTestRows(), invocation);
        if (!after.existing || after.existing.sheet_row !== sheetRow) {
            if (writeError) {
                throw new Error(`Google Sheets write failed and could not be reconciled: ${writeError.message}`);
            }
            throw new Error("Google Sheets post-write verification did not find the exact record");
        }
        return {
            status: "FLOW_SUCCESS",
            flow: FLOW_NAME,
            request_id: invocation.request_id,
            idempotency_key: invocation.idempotency_key,
            sheet: TEST_SHEET,
            sheet_row: sheetRow,
            applied: writeError === null,
            replayed: false,
            reconciled_after_error: writeError !== null,
        };
    }

    return Object.freeze({ invoke });
}

module.exports = {
    FLOW_NAME,
    SPREADSHEET_ID,
    TEST_SHEET,
    TEST_READ_RANGE,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    MAX_VALUE_CHARS,
    FlowPolicyError,
    validateInvocation,
    createJobTrackerGoogle,
};
