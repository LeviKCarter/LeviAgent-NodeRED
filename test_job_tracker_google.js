"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
    createJobTrackerGoogle,
    validateInvocation,
    TEST_READ_RANGE,
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
    payload: { value: "NODE_RED_ROUNDTRIP_OK" },
};

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(body); },
    };
}

function rowFor(input) {
    return [[
        input.idempotency_key,
        input.request_id,
        input.flow,
        input.payload.value,
        "2026-08-25T00:00:00.000Z",
        "applied",
    ]];
}

test("fixed schema rejects alternate flows, excess fields, and formula values", () => {
    assert.equal(validateInvocation(invocation).flow, "job_tracker_update");
    assert.throws(() => validateInvocation({ ...invocation, flow: "anything_else" }), /Only job_tracker_update/);
    assert.throws(() => validateInvocation({ ...invocation, url: "http://example.invalid" }), /unsupported fields/);
    assert.throws(() => validateInvocation({ ...invocation, payload: { value: "=IMPORTXML()" } }), /formula prefix/);
});

test("new request writes one fixed test row and verifies it", async () => {
    const calls = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TEST_READ_RANGE, values: [] }),
        response({ updatedRange: "'NodeRED Test'!A2:F2", updatedCells: 6 }),
        response({ range: TEST_READ_RANGE, values: rowFor(invocation) }),
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
    assert.equal(result.sheet, "NodeRED Test");
    assert.equal(result.sheet_row, 2);
    assert.equal(result.applied, true);
    assert.equal(result.replayed, false);
    assert.match(calls[2].url, /NodeRED%20Test/);
    assert.equal(calls[2].method, "PUT");
    assert.equal(queue.length, 0);
});

test("existing idempotency record is replayed without a second write", async () => {
    const methods = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TEST_READ_RANGE, values: rowFor(invocation) }),
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

test("ambiguous write failure reconciles from the exact idempotency record", async () => {
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TEST_READ_RANGE, values: [] }),
        new Error("connection reset after write"),
        response({ range: TEST_READ_RANGE, values: rowFor(invocation) }),
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
        response({ range: TEST_READ_RANGE, values: [] }),
        response({ updatedRange: "'NodeRED Test'!A2:F2", updatedCells: 6 }),
        response({ range: TEST_READ_RANGE, values: rowFor(invocation) }),
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

test("a full dedicated range fails closed without an out-of-range write", async () => {
    const fullRows = Array.from({ length: 19 }, (_, index) => [
        `levi-request-${String(index).padStart(20, "0")}`,
        `REQ-FILL-${String(index).padStart(3, "0")}`,
        "job_tracker_update",
        `value-${index}`,
        "2026-08-25T00:00:00.000Z",
        "applied",
    ]);
    const methods = [];
    const queue = [
        response({ access_token: "x".repeat(32), expires_in: 3600 }),
        response({ range: TEST_READ_RANGE, values: fullRows }),
    ];
    const adapter = createJobTrackerGoogle({
        credential,
        fetchImpl: async (_url, init) => {
            methods.push(init.method);
            return queue.shift();
        },
    });
    await assert.rejects(adapter.invoke(invocation), /test range is full/);
    assert.deepEqual(methods, ["POST", "GET"]);
});
