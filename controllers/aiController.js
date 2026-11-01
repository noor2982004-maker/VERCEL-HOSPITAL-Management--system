/**
 * Devora AI gateway — drop-in replacement for the backend's controllers/aiController.js.
 *
 * Owned by the backend team. Supplied by the AI service owner; this file is not
 * deployed from the AI repository.
 *
 * What it changes:
 *   - Replaces the old Hugging Face Gradio client (`client.predict("/predict")`) with
 *     server-to-server HTTPS calls to the Devora medical AI on Modal.
 *   - Keeps `POST /api/ai/chat` and the `{ "message": "..." }` body, and keeps
 *     `{ success, reply }` in the response, adding the full structured answer as `ai`.
 *   - Stops returning `error.message` to clients and stops logging it.
 *
 * Why it is asynchronous:
 *   When the AI's GPU has scaled to zero, one answer takes ~7-8 minutes. A Vercel
 *   function stops at 300 s on Hobby (also the Pro default), so a synchronous call
 *   would fail exactly then. Instead the AI accepts the job in ~1 s; this handler waits
 *   up to DEVORA_AI_WAIT_MS (default 25 s) and returns the answer if it is ready,
 *   otherwise `202 { status: "pending", job_id }`, which the app polls via
 *   `GET /api/ai/chat/:jobId`. Warm answers (~15-35 s) usually need one poll at most.
 *   Emergencies are answered immediately and are never queued.
 *
 * Routes (routes/aiRoutes.js), both behind `protect` and a per-user rate limit:
 *   POST /api/ai/chat          -> 200 complete | 202 pending | 400 | 401 | 502 failed | 503
 *   GET  /api/ai/chat/:jobId   -> 200 complete | 202 pending | 400 | 401 | 404 expired | 502 failed | 503
 *
 * Environment (Vercel project settings; never commit values):
 *   DEVORA_AI_URL      https://mahmoudbadr238--devora-medical-ai-api.us-east.modal.run
 *   DEVORA_AI_TOKEN    bearer token from the AI owner. Server-side only: never send it to
 *                      the React Native app or a browser.
 *   DEVORA_AI_WAIT_MS  optional, default 25000. Keep well under the function's maxDuration.
 *
 * Privacy:
 *   - The user's message is never logged; logs carry a stage and an HTTP status only.
 *   - Coordinates are not forwarded: the AI uses only `location.city` / `location.area`.
 *   - Staging is for synthetic messages only until a health-data privacy, security and
 *     clinical review approves real patient use.
 *
 * Per-user isolation:
 *   Put both routes behind the app's auth middleware (`protect`). When `req.user` exists, this
 *   sends an HMAC of the user id (never the id itself) as `X-Devora-Owner`, and the AI returns
 *   a completed answer only to the same user. Without auth, the unguessable job id is the only
 *   credential, so anyone holding a job id could read that answer.
 *
 * Requires Node 18+ (global fetch). No new dependencies.
 */

import { createHmac } from "node:crypto";

const JOB_ID = /^fc-[A-Za-z0-9]{8,64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE = 5000;
const MAX_HISTORY = 20;
const MAX_PLACE = 100;
const CALL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

// Fixed public messages: nothing from the AI service or an exception reaches a client.
// `status` tells the app what to do next: "error" = retry later, "failed"/"expired" = stop
// polling and ask the user to send the message again.
const INVALID = { success: false, status: "error", message: "Please enter a message" };
const INVALID_JOB = { success: false, status: "error", message: "Invalid job id" };
const UNAVAILABLE = { success: false, status: "error", message: "AI service is temporarily unavailable" };
const FAILED = {
  success: false,
  status: "failed",
  message: "The AI could not answer this message. Please send it again.",
};
const EXPIRED = {
  success: false,
  status: "expired",
  message: "This AI request has expired. Please send your message again.",
};
const PENDING_REPLY = {
  ar: "جاري تحليل رسالتك، يرجى الانتظار قليلًا.",
  en: "Your message is being analysed. Please wait a moment.",
};

function config() {
  const wait = Number.parseInt(process.env.DEVORA_AI_WAIT_MS ?? "", 10);
  return {
    url: (process.env.DEVORA_AI_URL ?? "").replace(/\/+$/, ""),
    token: process.env.DEVORA_AI_TOKEN ?? "",
    waitMs: Number.isFinite(wait) ? Math.min(Math.max(wait, 0), 240_000) : 25_000,
    pollMs: POLL_INTERVAL_MS,
  };
}

const isText = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;

/** The AI request body, or null if the input is invalid. Only known fields are copied. */
function buildPayload(body) {
  if (!body || !isText(body.message, MAX_MESSAGE)) return null;
  const payload = { message: body.message.trim() };

  if (body.request_id !== undefined) {
    if (typeof body.request_id !== "string" || !SAFE_ID.test(body.request_id)) return null;
    payload.request_id = body.request_id;
  }
  if (body.conversation_id !== undefined && body.conversation_id !== null) {
    if (typeof body.conversation_id !== "string" || !SAFE_ID.test(body.conversation_id)) return null;
    payload.conversation_id = body.conversation_id;
  }
  if (body.history !== undefined) {
    if (!Array.isArray(body.history) || body.history.length > MAX_HISTORY) return null;
    const history = [];
    for (const turn of body.history) {
      if (!turn || !["user", "assistant"].includes(turn.role) || !isText(turn.content, MAX_MESSAGE)) {
        return null;
      }
      history.push({ role: turn.role, content: turn.content.trim() });
    }
    payload.history = history;
  }
  if (body.location && typeof body.location === "object") {
    const location = {};
    for (const key of ["city", "area"]) {
      if (isText(body.location[key], MAX_PLACE)) location[key] = body.location[key].trim();
    }
    if (Object.keys(location).length) payload.location = location;
  }
  return payload;
}

/** Plain-text answer for clients that still read `reply`. */
function buildReply(result) {
  const content = result?.content ?? {};
  const parts = [content.summary];
  parts.push(result?.medical?.emergency ? content.when_to_seek_care : content.explanation);
  return parts.filter((part) => typeof part === "string" && part.trim()).join("\n\n");
}

const complete = (result) => ({ success: true, status: "complete", reply: buildReply(result), ai: result });

const pending = (jobId, language) => ({
  success: true,
  status: "pending",
  job_id: jobId,
  reply: PENDING_REPLY[language] ?? PENDING_REPLY.ar,
});

/** Opaque per-user value for X-Devora-Owner: an HMAC of the app user id, or null when anonymous. */
function ownerFor(req, cfg) {
  const id = req.user?._id ?? req.user?.id;
  if (id === undefined || id === null || id === "") return null;
  return createHmac("sha256", cfg.token).update(String(id)).digest("hex");
}

async function callAI(cfg, method, path, body, owner = null) {
  const response = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(owner ? { "X-Devora-Owner": owner } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  // A Modal infrastructure error (e.g. a preempted container) is plain text, not JSON.
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logFailure = (stage, status) => console.error(`[ai-gateway] ${stage} failed: status=${status ?? "none"}`);

/** True when configured; otherwise logs the missing variable names (never values). */
function checkConfig(cfg) {
  const missing = [!cfg.url && "DEVORA_AI_URL", !cfg.token && "DEVORA_AI_TOKEN"].filter(Boolean);
  if (missing.length) console.error(`[ai-gateway] config failed: missing ${missing.join(", ")}`);
  return missing.length === 0;
}

// The AI answers a failed job with { status: "error" } and a 5xx code.
const jobFailed = (polled) => polled.status >= 500 && polled.json?.status === "error";

function guessLanguage(message) {
  return /[؀-ۿ]/.test(message) ? "ar" : "en";
}

/** POST /api/ai/chat */
export const chatWithAI = async (req, res) => {
  const payload = buildPayload(req.body);
  if (!payload) return res.status(400).json(INVALID);
  const cfg = config();
  if (!checkConfig(cfg)) return res.status(503).json(UNAVAILABLE);
  const owner = ownerFor(req, cfg);

  try {
    const started = await callAI(cfg, "POST", "/chat/async", payload, owner);
    if (started.status === 200 && started.json?.status === "complete") {
      return res.status(200).json(complete(started.json.result));
    }
    if (started.status === 422) return res.status(400).json(INVALID);
    if (started.status !== 202 || !JOB_ID.test(started.json?.job_id ?? "")) {
      logFailure("start", started.status);
      return res.status(503).json(UNAVAILABLE);
    }

    const jobId = started.json.job_id;
    const deadline = Date.now() + cfg.waitMs;
    while (Date.now() + cfg.pollMs <= deadline) {
      await sleep(cfg.pollMs);
      const polled = await callAI(cfg, "GET", `/chat/async/${jobId}`, null, owner);
      if (polled.status === 202) continue;
      if (polled.status === 200 && polled.json?.status === "complete") {
        return res.status(200).json(complete(polled.json.result));
      }
      logFailure("job", polled.status);
      return jobFailed(polled) ? res.status(502).json(FAILED) : res.status(503).json(UNAVAILABLE);
    }
    return res.status(202).json(pending(jobId, guessLanguage(payload.message)));
  } catch {
    logFailure("request", null);
    return res.status(503).json(UNAVAILABLE);
  }
};

/** GET /api/ai/chat/:jobId */
export const getChatResult = async (req, res) => {
  const jobId = req.params?.jobId ?? "";
  if (!JOB_ID.test(jobId)) return res.status(400).json(INVALID_JOB);
  const cfg = config();
  if (!checkConfig(cfg)) return res.status(503).json(UNAVAILABLE);

  try {
    const polled = await callAI(cfg, "GET", `/chat/async/${jobId}`, null, ownerFor(req, cfg));
    if (polled.status === 200 && polled.json?.status === "complete") {
      return res.status(200).json(complete(polled.json.result));
    }
    if (polled.status === 202) return res.status(202).json(pending(jobId));
    // Unknown, expired and another user's job all look the same, by design.
    if (polled.status === 404) return res.status(404).json(EXPIRED);
    logFailure("result", polled.status);
    return jobFailed(polled) ? res.status(502).json(FAILED) : res.status(503).json(UNAVAILABLE);
  } catch {
    logFailure("result", null);
    return res.status(503).json(UNAVAILABLE);
  }
};

// Exported for tests only.
export const _internal = { buildPayload, buildReply, ownerFor };
