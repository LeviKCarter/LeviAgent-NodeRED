"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { createJobTrackerGoogle } = require("/data/lib/job_tracker_google.js");

function readRequiredSecret(path, minimumLength) {
    const value = fs.readFileSync(path, "utf8").trim();
    if (value.length < minimumLength) {
        throw new Error(`Required Node-RED secret at ${path} is missing or too short`);
    }
    return value;
}

const credentialSecret = readRequiredSecret(
    "/run/secrets/nodered_credential_secret",
    32,
);
const gatewayToken = readRequiredSecret(
    "/run/secrets/leviagent_gateway_token",
    32,
);
const jobTrackerGoogle = createJobTrackerGoogle({
    credentialPath: "/run/secrets/google_service_account",
});

function bearerTokenMatches(request) {
    const header = String(request.headers.authorization || "");
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) {
        return false;
    }
    const supplied = Buffer.from(header.slice(prefix.length), "utf8");
    const expected = Buffer.from(gatewayToken, "utf8");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = {
    uiHost: "0.0.0.0",
    uiPort: 1880,
    flowFile: "flows.json",
    flowFilePretty: true,

    // The editor and Admin API are intentionally absent in the bootstrap release.
    // This is stricter than exposing an unauthenticated editor on localhost.
    httpAdminRoot: false,
    disableEditor: true,

    httpNodeRoot: "/leviagent",
    httpNodeMiddleware(request, response, next) {
        if (!bearerTokenMatches(request)) {
            response.status(401).json({
                status: "UNAUTHORIZED",
                error: "A valid LeviAgent gateway bearer token is required",
            });
            return;
        }
        next();
    },

    credentialSecret,
    functionGlobalContext: {
        // This object exposes only one fixed, schema-checked operation. Flow
        // functions never receive the Google service-account private key.
        jobTrackerGoogle,
    },
    functionExternalModules: false,
    exportGlobalContextKeys: false,
    contextStorage: {
        default: {
            module: "localfilesystem",
        },
    },
    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: true,
        },
    },
};
