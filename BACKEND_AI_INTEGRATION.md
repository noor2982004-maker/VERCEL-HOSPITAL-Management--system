# DevOra backend: Medical AI integration

The mobile app talks only to the DevOra backend on Vercel. The backend calls the
Devora Medical AI on Modal on the app's behalf, holding the Modal token server-side.

```
React Native app ──JWT──▶ Vercel backend /api/ai/chat ──Modal token──▶ Modal /chat/async
                 ◀──────── { success, status, reply, ai } ◀───────────── structured JSON
```

| Piece | Where |
|---|---|
| Routes | `routes/aiRoutes.js` |
| Gateway | `controllers/aiController.js` |
| Auth | `middleware/authMiddleware.js` (`protect`, unchanged) |
| Tests | `tests/ai.test.js` (`npm test`) |
| Postman | `postman/backend/` |

The previous Hugging Face / Gradio client and its `@gradio/client` dependency are removed.
`DEVORA_AI_URL` is the only upstream setting. `AI_SERVICE_URL` and `MYAI_SERVICE_URL` are no longer read.

## Endpoints

Both need the app's JWT from `POST /api/auth/login` (`data.token`):
`Authorization: Bearer <app JWT>`. **The Modal token is never sent by the app.**

### `POST /api/ai/chat`

```json
{
  "message": "عايز دكتور قلب",
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "conversation_id": "optional_id",
  "request_id": "optional_id",
  "location": { "city": "Cairo", "area": "Nasr City" }
}
```

Only `message` is required (1–5000 characters). `history` holds up to 20 turns.
Coordinates, `user_id` and unknown fields are dropped before anything reaches the AI.

### `GET /api/ai/chat/:jobId`

Polls a pending job. Must be called with the **same user's** JWT that submitted it.

## Response contract

Every response has `success` and, for AI responses, `status`.

| HTTP | `status` | Meaning | App should |
|---|---|---|---|
| 200 | `complete` | Answer ready: `reply` (plain text) + `ai` (full structured JSON) | Show it, stop polling |
| 202 | `pending` | Queued on the GPU: `job_id` + a "please wait" `reply` | Poll `GET /api/ai/chat/{job_id}` |
| 400 | `error` | Bad body (`Please enter a message`) or malformed job id (`Invalid job id`) | Fix the request |
| 401 | — | Missing, invalid, expired or logged-out JWT | Log in again |
| 404 | `expired` | Unknown or expired job, or another user's job | Stop; ask the user to resend |
| 429 | `error` | Rate limit: 20 messages/min, 60 polls/min per user | Wait |
| 502 | `failed` | The AI job failed (model error or timeout) | Stop; ask the user to resend |
| 503 | `error` | AI or database temporarily unavailable | Retry later |

Complete:

```json
{
  "success": true,
  "status": "complete",
  "reply": "summary\n\nexplanation",
  "ai": {
    "request_id": "…", "status": "success", "intent": "doctor_search", "language": "ar",
    "content": { "summary": "…", "explanation": "…", "advice": [], "red_flags": [], "when_to_seek_care": null },
    "medical": { "symptoms": [], "duration": null, "urgency": "low", "emergency": false },
    "follow_up": { "needed": false, "questions": [] },
    "specialty": { "id": "cardiology" },
    "recommended_doctors": [{ "doctor_id": "…", "name": "…", "consultation_fee": 200, "available": null }]
  }
}
```

Pending:

```json
{ "success": true, "status": "pending", "job_id": "fc-…", "reply": "جاري تحليل رسالتك، يرجى الانتظار قليلًا." }
```

- `ai` is passed through from the AI untouched: urgency, emergency flags, follow-up
  questions, specialty and every doctor field (id, name, fee, image, location, availability)
  arrive exactly as the AI produced them. The backend does not add or change doctor data.
- For an emergency, `reply` is the summary plus `when_to_seek_care`. `ai.medical.emergency`
  is `true`, `ai.medical.urgency` is `"critical"` and `ai.recommended_doctors` is `[]`.
- **Old clients** that read only `success` and `reply` keep working for completed answers.
  They must also handle `202` to show anything for non-emergency messages.

### Two ways an answer arrives

1. **Immediate (HTTP 200).** Clear emergencies (for example `عندي ألم في الصدر من الصبح`) are answered
   by Modal at once with `job_id: null`. The backend returns it directly and never polls.
2. **Queued (HTTP 202).** Everything else runs on the GPU. The backend waits up to
   `DEVORA_AI_WAIT_MS` (default 25 s), polling Modal every 2 s. If the answer is ready in time the
   POST returns 200; otherwise it returns 202 with `job_id`. A warm GPU usually answers in
   15–35 s. A cold start takes about 7–8 minutes, so the app must poll.

## React Native: polling (required change)

```js
const API = "https://vercel-hospital-management-system.vercel.app/api";

export async function askAI(body, jwt, { signal, intervalMs = 4000, timeoutMs = 9 * 60_000 } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` };
  let res = await fetch(`${API}/ai/chat`, { method: "POST", headers, body: JSON.stringify(body), signal });
  let data = await res.json();
  if (res.status !== 202) return finish(res, data); // emergency or warm answer, or an error

  const jobId = data.job_id; // show data.reply ("please wait") meanwhile
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("ABORTED")); });
    });
    res = await fetch(`${API}/ai/chat/${jobId}`, { headers, signal });
    data = await res.json();
    if (res.status === 202 || res.status === 503 || res.status === 429) continue; // pending or transient
    return finish(res, data); // 200 complete, or 404 expired / 502 failed / 401
  }
  throw new Error("AI_TIMEOUT");
}

function finish(res, data) {
  if (!res.ok) throw Object.assign(new Error(data.message), { status: res.status, data });
  return data; // { success, status: "complete", reply, ai }
}
```

Stop polling on `404 expired`, `502 failed` or when the user leaves the screen
(`AbortController`). Finished results stay retrievable for 30 minutes.

## Configuration

| Variable | Required | Value |
|---|---|---|
| `DEVORA_AI_URL` | yes | `https://mahmoudbadr238--devora-medical-ai-api.us-east.modal.run` |
| `DEVORA_AI_TOKEN` | yes | Modal bearer token (secret) |
| `DEVORA_AI_WAIT_MS` | no | `25000` (default). See the timeout note below. |

If `DEVORA_AI_URL` or `DEVORA_AI_TOKEN` is missing, every valid AI request returns
`503 AI service is temporarily unavailable`. The Vercel log line names the missing variable
(`[ai-gateway] config failed: missing DEVORA_AI_TOKEN`), never its value.

### Vercel setup

1. Vercel → project → **Settings → Environment Variables**: add `DEVORA_AI_URL` and
   `DEVORA_AI_TOKEN` (mark the token **Sensitive**). Optionally add `DEVORA_AI_WAIT_MS`.
   Select **Production** and **Preview** (and Development if you use `vercel dev`).
   Also check `BACKEND_URL` there: it must be
   `https://vercel-hospital-management-system.vercel.app/api/up`. The doctor edit-request email
   links to `${BACKEND_URL}/doctor-upload`, and that route is mounted under `/api/up`. Local
   `.env` uses `http://localhost:3000/api/up`. Delete `AI_SERVICE_URL` / `MYAI_SERVICE_URL` if present.
2. **Redeploy**: environment changes apply only to new deployments.
3. **Timeout check.** In Settings → Functions, confirm the function max duration. With Fluid
   compute (the default for newer projects) it is 300 s and `DEVORA_AI_WAIT_MS=25000` is fine.
   If the limit is lower (legacy Hobby default: 10 s), set `DEVORA_AI_WAIT_MS=5000` or the
   function will be cut off and the app will get a Vercel 504 instead of a `job_id`. Each
   Modal call also has its own 15 s timeout.

### Ownership

The backend sends Modal `X-Devora-Owner = HMAC-SHA256(DEVORA_AI_TOKEN, user id)` on submit and
poll. Modal stores only a SHA-256 of it and returns a finished answer only to the same value, so
patient B polling patient A's `job_id` gets `404 expired`. Clients cannot set this header: it is
computed server-side from the verified JWT. If the Modal token is rotated, jobs still pending at
that moment become unreadable (they show as expired).

## Testing

```bash
npm ci
npm test         # mock Modal, stubbed DB: no MongoDB, no GPU
```

`tests/ai.test.js` runs the AI router with the real `protect` middleware against a mock Modal. It covers
JWT (missing, invalid, expired, wrong secret, revoked, Modal token misused as a JWT), body
validation, missing config, Modal 401/500/503, network errors, timeouts, immediate emergencies,
pending jobs, polling, failed and expired jobs, cross-user isolation, field filtering, rate
limits and log privacy. `tests/app.test.js` covers route mounting in `index.js`, database
outages and malformed JSON. It exists only where `index.js` is the Vercel entry point
(`export default app`), so it isn't on branches whose `index.js` always calls `listen()`.

### Postman

Import `postman/backend/DevOra-Backend-AI.postman_collection.json` and
`postman/backend/DevOra-Backend-Vercel.postman_environment.json`, then select the environment.

1. Put a **synthetic test patient**'s email and password into the environment's *current* values
   and run **1 Setup → Patient login**. It stores `backendJwt`.
2. Folders 2 and 3 cost no GPU time. Folder 4 starts GPU jobs. In the Collection Runner,
   "Async poll" repeats every 4 s while pending (up to 60 times).

`backendJwt` is the backend's login token. Putting the Modal token there returns 401.

The older `postman/collections/Devora-Medical-AI` collection calls Modal directly and is for AI
owners only.

## Not yet ready for real patients

Staging is for synthetic messages only. Before real patient use you need a health-data
privacy, security and clinical review, a persistent rate limit (the current one is in-memory per
serverless instance) and monitoring of the Vercel and Modal logs.
