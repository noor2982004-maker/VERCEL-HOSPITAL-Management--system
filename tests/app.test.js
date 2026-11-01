// Tests for the Vercel entry point (index.js) around /api/ai: mounting, the per-request DB
// middleware and the invalid-JSON handler. No MongoDB, no Modal. Run: npm test
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// Isolate from the developer's real .env before the app is imported.
process.env.DOTENV_CONFIG_PATH = "tests/.env.does-not-exist";
process.env.VERCEL = "1"; // index.js must not listen or start cron jobs
process.env.JWT_SECRET = "test-jwt-secret";
const PLACEHOLDER_MONGO_URI = "mongodb://never-dialed.invalid/test"; // readyState is stubbed to 1
process.env.MONGO_URI = PLACEHOLDER_MONGO_URI;

const { default: jwt } = await import("jsonwebtoken");
const { default: mongoose } = await import("mongoose");
const { default: BlacklistedToken } = await import("../models/blacklistedToken.js");
const { default: app } = await import("../index.js");

let dbUp = true;
Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => (dbUp ? 1 : 0) });
BlacklistedToken.exists = async () => false;

let api;
let apiUrl;
before(async () => {
  api = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => api.once("listening", resolve));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());

const token = jwt.sign({ id: "6ad7bdb0d9fcbbf454299999", role: "patient" }, process.env.JWT_SECRET, { expiresIn: "1h" });

async function call(method, path, { auth = true, body } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  return { status: response.status, json: await response.json() };
}

test("index.js mounts both AI routes under /api/ai behind auth", async () => {
  assert.equal((await call("POST", "/api/ai/chat", { auth: false, body: "{}" })).status, 401);
  assert.equal((await call("GET", "/api/ai/chat/fc-01K8TESTTESTTESTTESTTESTTE", { auth: false })).status, 401);
  // Authenticated, invalid input: reaches the controller (400), not the 404 handler.
  assert.equal((await call("POST", "/api/ai/chat", { body: "{}" })).status, 400);
  assert.equal((await call("GET", "/api/ai/chat/not-a-job")).status, 400);
  assert.equal((await call("GET", "/api/ai/unknown")).status, 404);
});

test("health check reports the database state", async () => {
  const res = await call("GET", "/health", { auth: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok", db: "connected" });
});

test("a database outage returns the existing 503 before auth or the AI", async () => {
  dbUp = false;
  delete process.env.MONGO_URI; // connectDB() then fails at once instead of dialing
  try {
    const res = await call("POST", "/api/ai/chat", { body: JSON.stringify({ message: "عايز دكتور قلب" }) });
    assert.equal(res.status, 503);
    assert.equal(res.json.message, "Database is temporarily unavailable");
  } finally {
    dbUp = true;
    process.env.MONGO_URI = PLACEHOLDER_MONGO_URI;
  }
});

test("malformed JSON gets the existing 400 'Invalid JSON format'", async () => {
  const res = await call("POST", "/api/ai/chat", { body: '{"message": ' });
  assert.equal(res.status, 400);
  assert.equal(res.json.message, "Invalid JSON format");
});
