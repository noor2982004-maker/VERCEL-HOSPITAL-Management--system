// Tests for /api/ai (routes/aiRoutes.js + controllers/aiController.js + the real `protect`
// middleware) against a mock of the Modal AI service. No MongoDB, no Modal, no GPU.
// Run: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";

import express from "express";
import jwt from "jsonwebtoken";

import BlacklistedToken from "../models/blacklistedToken.js";
import AIRouter from "../routes/aiRoutes.js";
import { ErrorHandler } from "../utils/ErrorHandler.js";

process.env.JWT_SECRET = "test-jwt-secret";

// Same stack as index.js around the AI router: JSON body, /api/ai, 404, ErrorHandler.
const app = express();
app.use(express.json());
app.use("/api/ai", AIRouter);
app.use((req, res, next) => next({ message: `Route not found: ${req.originalUrl}`, statusCode: 404 }));
app.use(ErrorHandler);

const MODAL_TOKEN = "test-modal-token-never-leaks";
const JOB = "fc-01K8TESTTESTTESTTESTTESTTE";

const DOCTOR_RESULT = {
  request_id: "r1",
  status: "success",
  intent: "doctor_search",
  language: "ar",
  content: { summary: "أنت تبحث عن طبيب قلب.", explanation: "شرح.", advice: [], red_flags: [], when_to_seek_care: null },
  medical: { symptoms: [], duration: null, urgency: "low", emergency: false },
  follow_up: { needed: false, questions: [] },
  specialty: { id: "cardiology", reason: null },
  recommended_doctors: [
    {
      doctor_id: "6ad7bdb0d9fcbbf45429fc55",
      name: "Nour Mahmoud Mohamed",
      specialty_id: "cardiology",
      specialty_name: "Cardiology",
      title: "TESTDR",
      rating: 0.0,
      consultation_fee: 200.0,
      image: null,
      location: { governorate: "Cairo", area: null },
      available: null,
    },
  ],
};
const EMERGENCY_RESULT = {
  ...DOCTOR_RESULT,
  intent: "medical_emergency",
  content: {
    summary: "الأعراض المذكورة قد تحتاج إلى رعاية طبية عاجلة.",
    explanation: "هذه رسالة سلامة تلقائية وليست تشخيصًا طبيًا.",
    advice: [],
    red_flags: [],
    when_to_seek_care: "فورًا.",
  },
  medical: { symptoms: [], duration: null, urgency: "critical", emergency: true },
  specialty: null,
  recommended_doctors: [],
};

// --- database stub: protect() checks the logout blacklist ------------------------------
const revoked = new Set();
BlacklistedToken.exists = async ({ token }) => revoked.has(token);

// --- mock Modal AI service (mirrors deploy/async_jobs.py) ---------------------------
let modal;
let modalUrl;
let handler; // per-test: (req, body) => [status, body, contentType?]
let calls; // requests received by the mock
const jobOwners = new Map(); // job id -> sha256(owner)
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Default behaviour: emergency inline, everything else queued; polls answer by owner.
function defaultModal(req, body) {
  if (req.headers.authorization !== `Bearer ${MODAL_TOKEN}`) return [401, { detail: "Unauthorized" }];
  const owner = req.headers["x-devora-owner"];
  if (req.method === "POST" && req.url === "/chat/async") {
    if (body.message.includes("ألم في الصدر")) {
      return [200, { status: "complete", job_id: null, result: EMERGENCY_RESULT }];
    }
    jobOwners.set(JOB, owner ? sha256(owner) : null);
    return [202, { status: "pending", job_id: JOB, request_id: "r1" }];
  }
  if (req.method === "GET" && req.url === `/chat/async/${JOB}`) {
    const expected = jobOwners.get(JOB);
    if (expected === undefined) return [404, { detail: { code: "JOB_NOT_FOUND" } }];
    if (expected && (!owner || sha256(owner) !== expected)) return [404, { detail: { code: "JOB_NOT_FOUND" } }];
    return [200, { status: "complete", job_id: JOB, result: DOCTOR_RESULT }];
  }
  return [404, { detail: "Not Found" }];
}

// --- the backend under test ---------------------------------------------------------
let api;
let apiUrl;

before(async () => {
  modal = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = handler(req, body);
      if (reply === "hang") return; // never answer: exercises the call timeout
      const [status, payload, type = "application/json"] = reply;
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => modal.listen(0, "127.0.0.1", resolve));
  modalUrl = `http://127.0.0.1:${modal.address().port}`;

  api = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => api.once("listening", resolve));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

after(() => {
  modal.closeAllConnections();
  modal.close();
  api.close();
});

beforeEach(() => {
  calls = [];
  jobOwners.clear();
  handler = defaultModal;
  process.env.DEVORA_AI_URL = `${modalUrl}/`;
  process.env.DEVORA_AI_TOKEN = MODAL_TOKEN;
  process.env.DEVORA_AI_WAIT_MS = "0";
});

// Each test uses its own user so the per-user rate limits never interfere.
let userCounter = 0;
const newUser = () => `6ad7bdb0d9fcbbf4542${String(++userCounter).padStart(5, "0")}`;
const tokenFor = (id, options = { expiresIn: "1h" }) => jwt.sign({ id, role: "patient" }, process.env.JWT_SECRET, options);

async function request(method, path, { token, body, raw, headers = {} } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
}
const chat = (token, body) => request("POST", "/api/ai/chat", { token, body });
const poll = (token, jobId = JOB) => request("GET", `/api/ai/chat/${jobId}`, { token });

// --- routes & authentication ----------------------------------------------------------

test("both AI routes are registered under /api/ai", async () => {
  assert.equal((await request("POST", "/api/ai/chat")).status, 401);
  assert.equal((await request("GET", `/api/ai/chat/${JOB}`)).status, 401);
  assert.equal((await request("GET", "/api/ai/unknown")).status, 404);
});

test("missing JWT is rejected before the AI is called", async () => {
  const res = await chat(null, { message: "عايز دكتور قلب" });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { success: false, message: "Not authenticated" });
  assert.equal(calls.length, 0);
});

test("invalid, expired, wrongly signed and revoked JWTs are rejected", async () => {
  const id = newUser();
  const bad = [
    "not-a-jwt",
    tokenFor(id, { expiresIn: -60 }),
    jwt.sign({ id, role: "patient" }, "some-other-secret"),
    MODAL_TOKEN, // the Modal bearer token is not an application JWT
  ];
  const revokedToken = tokenFor(id);
  revoked.add(revokedToken);
  for (const token of [...bad, revokedToken]) {
    const res = await chat(token, { message: "عايز دكتور قلب" });
    assert.equal(res.status, 401, `token should be rejected: ${token.slice(0, 12)}…`);
    assert.equal(res.json.success, false);
  }
  assert.equal(calls.length, 0);
});

// --- request validation --------------------------------------------------------------------

test("invalid bodies return 400 and never reach the AI", async () => {
  const token = tokenFor(newUser());
  for (const body of [{}, { message: "" }, { message: "   " }, { message: 42 }, { message: "x".repeat(5001) },
    { message: "hi", history: "nope" }, { message: "hi", history: [{ role: "system", content: "x" }] },
    { message: "hi", request_id: "bad id with spaces" }]) {
    const res = await chat(token, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(res.json.message, "Please enter a message");
  }
  const noContentType = await request("POST", "/api/ai/chat", { token, headers: { "Content-Type": "text/plain" } });
  assert.equal(noContentType.status, 400);
  assert.equal(calls.length, 0);
});

test("validation runs before configuration, so a bad body is 400 even when unconfigured", async () => {
  delete process.env.DEVORA_AI_TOKEN;
  const res = await chat(tokenFor(newUser()), {});
  assert.equal(res.status, 400);
});

// --- configuration & upstream failures -----------------------------------------------

test("missing Modal configuration fails closed with 503 and logs only variable names", async () => {
  const token = tokenFor(newUser());
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    for (const name of ["DEVORA_AI_URL", "DEVORA_AI_TOKEN"]) {
      process.env.DEVORA_AI_URL = `${modalUrl}/`;
      process.env.DEVORA_AI_TOKEN = MODAL_TOKEN;
      delete process.env[name];
      const res = await chat(token, { message: "عايز دكتور قلب" });
      assert.equal(res.status, 503);
      assert.deepEqual(res.json, { success: false, status: "error", message: "AI service is temporarily unavailable" });
    }
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 0);
  assert.ok(logged.some((line) => line.includes("missing DEVORA_AI_URL")));
  assert.ok(logged.some((line) => line.includes("missing DEVORA_AI_TOKEN")));
  assert.ok(!logged.join("\n").includes(MODAL_TOKEN));
});

test("a wrong Modal token (401 upstream) becomes a fixed 503 and leaks nothing", async () => {
  handler = () => [401, { detail: `bad token ${MODAL_TOKEN}` }];
  const res = await chat(tokenFor(newUser()), { message: "عايز دكتور قلب" });
  assert.equal(res.status, 503);
  assert.ok(!res.text.includes(MODAL_TOKEN));
  assert.ok(!res.text.includes("bad token"));
});

test("plain-text 500, a full queue (503) and an unreachable service all become 503", async () => {
  const token = tokenFor(newUser());
  handler = () => [500, "modal-http: internal error", "text/plain"];
  assert.equal((await chat(token, { message: "صداع" })).status, 503);
  handler = () => [503, { detail: { code: "MODEL_UNAVAILABLE" } }];
  assert.equal((await chat(token, { message: "صداع" })).status, 503);
  process.env.DEVORA_AI_URL = "http://127.0.0.1:1"; // nothing listens here
  const res = await chat(token, { message: "صداع" });
  assert.equal(res.status, 503);
  assert.equal(res.json.message, "AI service is temporarily unavailable");
});

test("an upstream that never answers is cut off by the call timeout (15 s) with 503", { timeout: 30_000 }, async () => {
  handler = () => "hang";
  const started = Date.now();
  const res = await chat(tokenFor(newUser()), { message: "صداع" });
  assert.equal(res.status, 503);
  assert.ok(Date.now() - started < 20_000);
});

// --- Scenario A: immediate completion ------------------------------------------------------

test("chest-pain emergency: HTTP 200 inline, job_id null accepted, no polling, critical, no doctors", async () => {
  const res = await chat(tokenFor(newUser()), { message: "عندي ألم في الصدر من الصبح" });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.status, "complete");
  assert.equal(res.json.ai.intent, "medical_emergency");
  assert.equal(res.json.ai.medical.urgency, "critical");
  assert.equal(res.json.ai.medical.emergency, true);
  assert.deepEqual(res.json.ai.recommended_doctors, []);
  assert.deepEqual(res.json.ai, EMERGENCY_RESULT); // structured JSON preserved untouched
  assert.ok(res.json.reply.includes("فورًا."));
  assert.equal(res.json.job_id, undefined);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /chat/async"]);
});

test("immediate completion is not polled even with a wait budget", async () => {
  process.env.DEVORA_AI_WAIT_MS = "25000";
  const started = Date.now();
  const res = await chat(tokenFor(newUser()), { message: "عندي ألم في الصدر من الصبح" });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 1_500);
  assert.equal(calls.length, 1);
});

// --- Scenario B: pending job + polling -------------------------------------------------------

test("doctor search: 202 pending with a job id, then polling returns the full doctor list", async () => {
  const token = tokenFor(newUser());
  const started = await chat(token, { message: "عايز دكتور قلب" });
  assert.equal(started.status, 202);
  assert.deepEqual(started.json, {
    success: true,
    status: "pending",
    job_id: JOB,
    reply: "جاري تحليل رسالتك، يرجى الانتظار قليلًا.",
  });

  handler = (req, body) => (req.method === "GET" && calls.filter((c) => c.method === "GET").length === 1
    ? [202, { status: "pending", job_id: JOB }]
    : defaultModal(req, body));
  const first = await poll(token);
  assert.equal(first.status, 202);
  assert.equal(first.json.status, "pending");
  assert.equal(first.json.job_id, JOB);

  const done = await poll(token);
  assert.equal(done.status, 200);
  assert.equal(done.json.status, "complete");
  assert.equal(done.json.ai.intent, "doctor_search");
  assert.equal(done.json.ai.specialty.id, "cardiology");
  assert.deepEqual(done.json.ai.recommended_doctors, DOCTOR_RESULT.recommended_doctors);
  assert.equal(done.json.reply, "أنت تبحث عن طبيب قلب.\n\nشرح.");
});

test("English messages get an English pending reply", async () => {
  const res = await chat(tokenFor(newUser()), { message: "I need a cardiologist" });
  assert.equal(res.status, 202);
  assert.equal(res.json.reply, "Your message is being analysed. Please wait a moment.");
});

test("a job that finishes inside DEVORA_AI_WAIT_MS is answered by the POST itself", async () => {
  process.env.DEVORA_AI_WAIT_MS = "2500"; // one 2 s poll fits
  const res = await chat(tokenFor(newUser()), { message: "عايز دكتور قلب" });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "complete");
  assert.equal(res.json.ai.recommended_doctors.length, 1);
  assert.deepEqual(calls.map((c) => c.method), ["POST", "GET"]);
});

test("only known fields are forwarded; coordinates and client owner headers are dropped", async () => {
  await request("POST", "/api/ai/chat", {
    token: tokenFor(newUser()),
    headers: { "X-Devora-Owner": "attacker-chosen" },
    body: {
      message: "  كنت نايم عليه  ",
      request_id: "req_124",
      conversation_id: "conv_1",
      user_id: "spoofed",
      history: [{ role: "user", content: "دراعي منمل" }, { role: "assistant", content: "التنميل بدأ فجأة؟" }],
      location: { city: "Cairo", area: "Nasr City", latitude: 30.1, longitude: 31.3 },
    },
  });
  const sent = calls[0];
  assert.equal(sent.headers.authorization, `Bearer ${MODAL_TOKEN}`);
  assert.notEqual(sent.headers["x-devora-owner"], "attacker-chosen");
  assert.deepEqual(sent.body, {
    message: "كنت نايم عليه",
    request_id: "req_124",
    conversation_id: "conv_1",
    history: [{ role: "user", content: "دراعي منمل" }, { role: "assistant", content: "التنميل بدأ فجأة؟" }],
    location: { city: "Cairo", area: "Nasr City" },
  });
});

// --- ownership -----------------------------------------------------------------------------

test("submit and poll send the same HMAC owner, never the raw user id", async () => {
  const id = newUser();
  const token = tokenFor(id);
  await chat(token, { message: "عايز دكتور قلب" });
  await poll(token);
  const [submit, polled] = calls;
  assert.match(submit.headers["x-devora-owner"], /^[0-9a-f]{64}$/);
  assert.equal(polled.headers["x-devora-owner"], submit.headers["x-devora-owner"]);
  assert.ok(!submit.headers["x-devora-owner"].includes(id));
});

test("patient B cannot read patient A's job (looks like an expired job)", async () => {
  const tokenA = tokenFor(newUser());
  const tokenB = tokenFor(newUser());
  assert.equal((await chat(tokenA, { message: "عايز دكتور قلب" })).status, 202);
  const stolen = await poll(tokenB);
  assert.equal(stolen.status, 404);
  assert.equal(stolen.json.status, "expired");
  assert.ok(!stolen.text.includes("Nour"));
  assert.equal((await poll(tokenA)).status, 200);
});

// --- polling errors ----------------------------------------------------------------------

test("malformed job ids are rejected with 400 and never reach the AI", async () => {
  const token = tokenFor(newUser());
  for (const jobId of ["123", "fc-short", "fc-../../health", "xx-01K8TESTTESTTESTTESTTESTTE", "fc-01K8TEST%20TEST"]) {
    const res = await poll(token, jobId);
    assert.equal(res.status, 400, jobId);
    assert.equal(res.json.message, "Invalid job id");
  }
  assert.equal(calls.length, 0);
});

test("unknown or expired job returns 404 status expired", async () => {
  const res = await poll(tokenFor(newUser()), "fc-01K8UNKNOWNUNKNOWNUNKNOWN");
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, {
    success: false,
    status: "expired",
    message: "This AI request has expired. Please send your message again.",
  });
});

test("a failed job (model error / model timeout) returns 502 status failed", async () => {
  const token = tokenFor(newUser());
  for (const [code, status] of [["MODEL_ERROR", 502], ["MODEL_TIMEOUT", 504]]) {
    handler = () => [status, { status: "error", job_id: JOB, error: { code, message: "internal detail" } }];
    const res = await poll(token);
    assert.equal(res.status, 502);
    assert.equal(res.json.status, "failed");
    assert.ok(!res.text.includes("internal detail"));
  }
});

test("a job that fails while the POST is waiting returns 502 status failed", async () => {
  process.env.DEVORA_AI_WAIT_MS = "2500";
  handler = (req, body) => (req.method === "GET"
    ? [502, { status: "error", job_id: JOB, error: { code: "MODEL_ERROR" } }]
    : defaultModal(req, body));
  const res = await chat(tokenFor(newUser()), { message: "عايز دكتور قلب" });
  assert.equal(res.status, 502);
  assert.equal(res.json.status, "failed");
});

test("polling while Modal is down returns 503 status error (retryable)", async () => {
  handler = () => [500, "modal-http: internal error", "text/plain"];
  const res = await poll(tokenFor(newUser()));
  assert.equal(res.status, 503);
  assert.equal(res.json.status, "error");
});

// --- privacy & limits ---------------------------------------------------------------------

test("the user's message and the Modal token never appear in logs", async () => {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = console.error = (...args) => lines.push(args.join(" "));
  try {
    handler = () => [500, "boom", "text/plain"];
    await chat(tokenFor(newUser()), { message: "سر طبي خاص 123" });
  } finally {
    Object.assign(console, original);
  }
  const output = lines.join("\n");
  assert.ok(!output.includes("سر طبي خاص"));
  assert.ok(!output.includes(MODAL_TOKEN));
  assert.ok(output.includes("[ai-gateway] start failed: status=500"));
});

test("per-user rate limit on submissions (20/min) returns 429 without calling the AI", async () => {
  const token = tokenFor(newUser());
  for (let i = 0; i < 20; i++) assert.equal((await chat(token, {})).status, 400);
  const limited = await chat(token, { message: "عايز دكتور قلب" });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.success, false);
  assert.equal(calls.length, 0);
  // Another user is unaffected.
  assert.equal((await chat(tokenFor(newUser()), { message: "عندي ألم في الصدر من الصبح" })).status, 200);
});
