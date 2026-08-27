"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
    createJobTrackerGoogle,
    validateInvocation,
    SPREADSHEET_ID,
    TARGET_RANGE,
    TARGET_VALUE,
} = require("./job_tracker_google.js");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const credential = {
    client_email: "test@example.invalid",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
};
const invocation = {
    flow: "job_tracker_update",
    request_id: "REQ-NODERED-TEST-001",
    idempotency_key: "levi-request-0123456789abcdefabcd",
    payload: { value: TARGET_VALUE },
};

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(body); },
    };
}

test("fixed schema rejects alternate flows, excess fields, and noncanonical values", () => {
    assert.equal(validateInvocation(invocation).flow, "job_tracker_update");
    assert.throws(() => validateInvocation({ ...invocation, flow: "anything_else" }), /Only job_tracker_update/);
    assert.throws(() => validateInvocation({ ...invocation, url: "http://example.invalid" }), /unsupported fields/);
    assert.throws(() => validateInvocation({ ...invocation, payload: { value: "Different Header" } }), /fixed tracker header/);
});

test("new request writes only the fixed real tracker header and verifies it", async () => {
    const calls = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TARGET_RANGE, values: [["Old Header"]] }),
        response({ updatedRange: TARGET_RANGE, updatedCells: 1 }),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        fetchImpl: async (url, init) => {
            calls.push({ url: String(url), method: init.method });
            return queue.shift();
        },
    });
    const result = await adapter.invoke(invocation);
    assert.equal(result.status, "FLOW_SUCCESS");
    assert.equal(result.sheet, "Applications");
    assert.equal(result.sheet_row, 1);
    assert.equal(result.applied, true);
    assert.equal(result.replayed, false);
    assert.match(calls[2].url, new RegExp(SPREADSHEET_ID));
    assert.match(calls[2].url, /Applications/);
    assert.equal(calls[2].method, "PUT");
    assert.equal(queue.length, 0);
});

test("already-canonical real tracker header is replayed without a write", async () => {
    const methods = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        fetchImpl: async (_url, init) => {
            methods.push(init.method);
            return queue.shift();
        },
    });
    const result = await adapter.invoke(invocation);
    assert.equal(result.replayed, true);
    assert.equal(result.applied, false);
    assert.deepEqual(methods, ["POST", "GET"]);
});

test("ambiguous write failure reconciles from the exact real tracker value", async () => {
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TARGET_RANGE, values: [["Old Header"]] }),
        new Error("connection reset after write"),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        fetchImpl: async () => {
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next;
        },
    });
    const result = await adapter.invoke(invocation);
    assert.equal(result.status, "FLOW_SUCCESS");
    assert.equal(result.reconciled_after_error, true);
    assert.equal(result.applied, false);
});

test("retryable Sheets quota response uses bounded adapter-owned backoff", async () => {
    const delays = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ error: { code: 429 } }, 429),
        response({ range: TARGET_RANGE, values: [["Old Header"]] }),
        response({ updatedRange: TARGET_RANGE, updatedCells: 1 }),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        delayImpl: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async () => queue.shift(),
    });
    const result = await adapter.invoke(invocation);
    assert.equal(result.status, "FLOW_SUCCESS");
    assert.deepEqual(delays, [2000]);
    assert.equal(queue.length, 0);
});

test("all Sheets calls remain bound to the fixed spreadsheet and cell", async () => {
    const urls = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        fetchImpl: async (url, _init) => {
            urls.push(String(url));
            return queue.shift();
        },
    });
    await adapter.invoke(invocation);
    assert.equal(urls.length, 2);
    assert.match(urls[1], new RegExp(SPREADSHEET_ID));
    assert.match(urls[1], /Applications/);
    assert.doesNotMatch(urls[1], /NodeRED%20Test/);
});

test("bearer token authentication verifies valid token and rejects missing or invalid authorization", () => {
    const { bearerTokenMatches } = require("./job_tracker_google.js");
    const validSecret = "a".repeat(32);
    const validHeader = `Bearer ${validSecret}`;

    // Valid authorized request
    assert.equal(bearerTokenMatches(validHeader, validSecret), true);

    // Missing authorization header
    assert.equal(bearerTokenMatches("", validSecret), false);
    assert.equal(bearerTokenMatches(undefined, validSecret), false);
    assert.equal(bearerTokenMatches(null, validSecret), false);

    // Invalid authorization header / wrong token
    assert.equal(bearerTokenMatches("Bearer " + "b".repeat(32), validSecret), false);
    assert.equal(bearerTokenMatches("Basic abcdef", validSecret), false);
    assert.equal(bearerTokenMatches("Bearer short", validSecret), false);
});

test("malformed schema and unsupported operation fail closed", () => {
    // Missing required fields
    assert.throws(() => validateInvocation({ flow: "job_tracker_update" }), /unsupported fields/);
    assert.throws(() => validateInvocation(null), /JSON object/);
    assert.throws(() => validateInvocation([]), /JSON object/);
    assert.throws(() => validateInvocation("string"), /JSON object/);

    // Invalid request_id format
    assert.throws(
        () => validateInvocation({ ...invocation, request_id: "invalid_req" }),
        /request_id is invalid/,
    );

    // Invalid idempotency_key format
    assert.throws(
        () => validateInvocation({ ...invocation, idempotency_key: "bad-key" }),
        /idempotency_key is invalid/,
    );

    // Unsupported flow
    assert.throws(
        () => validateInvocation({ ...invocation, flow: "arbitrary_command" }),
        /Only job_tracker_update is supported/,
    );

    // Non-object or empty payload
    assert.throws(
        () => validateInvocation({ ...invocation, payload: null }),
        /payload must contain exactly value/,
    );
    assert.throws(
        () => validateInvocation({ ...invocation, payload: {} }),
        /payload must contain exactly value/,
    );
});

test("transient 503 error followed by recovery succeeds on retry", async () => {
    const delays = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ error: { code: 503 } }, 503),
        response({ range: TARGET_RANGE, values: [["Old Header"]] }),
        response({ updatedRange: TARGET_RANGE, updatedCells: 1 }),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        delayImpl: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async () => queue.shift(),
    });
    const result = await adapter.invoke(invocation);
    assert.equal(result.status, "FLOW_SUCCESS");
    assert.deepEqual(delays, [2000]);
    assert.equal(queue.length, 0);
});

test("transient retry exhaustion after maximum attempts throws terminal error", async () => {
    const delays = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ error: { code: 429 } }, 429),
        response({ error: { code: 429 } }, 429),
        response({ error: { code: 429 } }, 429),
        response({ error: { code: 429 } }, 429),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        delayImpl: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async () => queue.shift(),
    });
    await assert.rejects(
        () => adapter.invoke(invocation),
        /Google Sheets failed with HTTP 429/,
    );
    assert.deepEqual(delays, [2000, 8000, 20000]);
    assert.equal(queue.length, 0);
});

test("permanent failure is not retried and fails immediately", async () => {
    const delays = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ error: { code: 403, message: "The caller does not have permission" } }, 403),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        delayImpl: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async () => queue.shift(),
    });
    await assert.rejects(
        () => adapter.invoke(invocation),
        /Google Sheets failed with HTTP 403/,
    );
    assert.equal(delays.length, 0);
    assert.equal(queue.length, 0);
});

test("secret and private key are strictly absent from returned result and error strings", async () => {
    const queue = [
        response({ access_token: "super-secret-access-token-12345678", expires_in: 3600 }),
        response({ range: TARGET_RANGE, values: [[TARGET_VALUE]] }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        now: () => Date.parse("2026-08-25T00:00:00Z"),
        fetchImpl: async () => queue.shift(),
    });
    const result = await adapter.invoke(invocation);
    const resultStr = JSON.stringify(result);

    // Private key and OAuth tokens must not leak in result
    assert.doesNotMatch(resultStr, /BEGIN PRIVATE KEY/);
    assert.doesNotMatch(resultStr, /super-secret-access-token/);
    assert.doesNotMatch(resultStr, /test@example.invalid/);
});
