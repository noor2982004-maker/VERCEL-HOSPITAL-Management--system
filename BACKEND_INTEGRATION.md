# Devora Medical AI — Backend Integration Guide

For the Node.js backend team. This service is the **AI layer only**: it returns
structured health guidance, a recommended medical **specialty**, and up to three
matching doctors read (read-only) from your own Doctors API. It never touches
bookings, users or MongoDB.

**Behind Vercel, use the async endpoints (section 7) via the ready-made gateway in
`integration/node-gateway/aiController.js`.** A synchronous `/chat` cannot finish
within Vercel's 300 s limit when the GPU is cold.

Written for: backend engineers integrating the Node.js API with this service.

---

## 1. Endpoint

| | |
|---|---|
| **Base URL** | `https://mahmoudbadr238--devora-medical-ai-api.us-east.modal.run` |
| **Method / path** | `POST /chat` (synchronous) |
| **Async start** | `POST /chat/async` — same body, returns in ~1 s (section 7) |
| **Async result** | `GET /chat/async/{job_id}` |
| **Content type** | `application/json` |
| **Health check** | `GET /health` → `{"status":"ok"}` (no auth) |

Hosted on Modal (serverless GPU). This is a **staging** deployment.

## 2. Authentication

Every endpoint except `GET /health` requires a shared bearer token:

```
Authorization: Bearer <DEVORA_API_TOKEN>
```

The token is held in the Modal secret `devora-api-token` and is **not** in Git.
Ask the AI service owner for it and keep it in your own environment
configuration (e.g. `process.env.DEVORA_AI_TOKEN`), never in source.

Missing or wrong token:

```json
HTTP 401
{"detail": {"code": "UNAUTHORIZED", "message": "Missing or invalid bearer token."}}
```

Comparison is constant-time. Rotating the token means recreating the secret; no
redeploy of your service is needed.

## 3. Request schema

```jsonc
{
  "message":    "string",            // REQUIRED, 1-5000 chars, trimmed.
  "request_id": "string",            // OPTIONAL. Generated if omitted.
  "history":    [                    // optional, default []
    { "role": "user" | "assistant", "content": "string" }
  ],
  "user_id":         "string | null", // optional
  "conversation_id": "string | null", // optional
  "location": {                       // optional, default null. NOT sent to the model.
    "latitude":  -90..90,
    "longitude": -180..180,
    "city": "string | null",          // treated as the governorate for ranking
    "area": "string | null"
  }
}
```

**The only required field is `message`.** This is valid:

```json
{ "message": "عندي صداع من امبارح" }
```

`request_id` is optional. Send your own and it is echoed back unchanged; omit it
and the service generates a 32-character hex id and returns it, so every answer
is still traceable. Sending an explicitly empty string is rejected with `422`.

The service does not store conversation state — it is stateless, so every turn
must carry its own `history`.

`location` is accepted and validated but never reaches the model. `location.city`
is used only to prefer nearby doctors when ranking (see section 6).

### Conversation-history format

`history` is chronological, oldest first, and **excludes** the current message
(that goes in `message`). Include assistant turns so the triage logic can see
what was already asked:

```json
{
  "request_id": "req_124",
  "message": "كنت نايم عليه وبعد ما حركته بدأ يفك",
  "history": [
    { "role": "user",      "content": "دراعي منمل" },
    { "role": "assistant", "content": "التنميل بدأ فجأة ولا تدريجي؟" }
  ]
}
```

Only the most recent 10 messages are sent to the model. Safety pattern matching
combines the current message with the last 3 user turns, so a warning sign split
across turns is still caught.

## 4. Response schema

```jsonc
{
  "request_id": "string",       // echoed back
  "status": "success",
  "intent": "general_health_question" | "symptom_query" | "doctor_search"
          | "specialty_search" | "medication_question" | "medical_emergency"
          | "greeting" | "non_medical" | "unknown",
  "language": "ar" | "en",      // language of the user-facing text
  "content": {
    "summary":            "string",          // non-empty, <=600
    "explanation":        "string",          // non-empty, <=2000
    "advice":             ["string"],        // 0-6 items
    "red_flags":          ["string"],        // 0-6 items, warning signs to watch for
    "when_to_seek_care":  "string | null"
  },
  "medical": {
    "symptoms": [ { "id": "string", "original_text": "string | null" } ], // 0-8
    "duration": "string | null",
    "urgency":  "low" | "medium" | "high" | "critical",
    "emergency": true | false
  },
  "follow_up": {
    "needed": true | false,
    "questions": ["string"]      // 0-4 items
  },
  "specialty": { "id": "<specialty_id>", "reason": "string | null" } | null,
  "recommended_doctors": [       // 0-3 real doctors - see section 6
    {
      "doctor_id":        "string",          // the doctor document's _id, NOT user_id
      "name":             "string | null",
      "specialty_id":     "string | null",   // our canonical id, e.g. "cardiology"
      "specialty_name":   "string | null",   // your backend's display name
      "title":            "string | null",
      "image":            "string | null",
      "rating":           0..5,              // null if absent; 0 means unrated
      "consultation_fee": "number | null",
      "location": { "area": "string | null", "governorate": "string | null" },
      "available":        null               // ALWAYS null - see section 6
    }
  ]
}
```

Notes that matter for your UI:

- `red_flags` are **forward-looking warning signs**, not findings. Render them as
  "seek care if you notice…", never as "you have…".
- `content.*` text is Arabic or English per `language`, which is set from the
  script of the user's message. A mixed Arabic-English message answers in Arabic.
- `symptoms[].original_text` is a verbatim substring of the user's own words, or
  `null`. It is never paraphrased or invented.

### Specialty ID format

`specialty.id` is a lowercase snake_case string from this fixed list:

```
general_practice  internal_medicine  cardiology     dermatology
pediatrics        orthopedics        neurology      psychiatry
gastroenterology  ophthalmology      ent            urology
gynecology        dentistry          pulmonology    endocrinology
general_surgery
```

These are **temporary IDs owned by the AI service** and are not yet aligned with
your Specialties collection. Map them on your side, and tell us if you need the
list changed to match your IDs — the model can only ever emit a value from this
list, never a new one.

`specialty` is `null` when no doctor is needed, and **always `null` for an
emergency** — a critical case is never routed to a regular doctor.

## 5. Emergency handling

Clear, current emergencies are detected by a **deterministic rule layer that runs
before the AI model**. The model is not called at all.

What you get back:

```
intent     = "medical_emergency"
urgency    = "critical"
emergency  = true
specialty  = null
follow_up.needed = false
content    = a fixed safety message (no diagnosis, no country-specific number)
```

Treat `emergency === true` as a hard signal: show emergency guidance, and do not
offer booking or specialist routing. This path responds in **~50 ms** because it
never touches the GPU.

The fixed message intentionally names no emergency phone number — add your own
locale-appropriate number in the UI.

## 6. `recommended_doctors`

The AI never invents doctor data. It reads your own Doctors API and returns at
most **three** doctors from it.

### How the specialty is decided

The model proposes a specialty, but three deterministic rules run after it, so
routing never depends on what the model happens to generate:

| User says | Result |
|---|---|
| Names a supported specialty ("عايز دكتور مخ وأعصاب", "I want a cardiologist", "عايز neurologist") | **that** specialty, even if the model chose another or none |
| Names an unsupported one ("دكتور روماتيزم", "an oncologist", "دكتور تغذية") | `specialty: null`, no doctors. Never a substitute such as internal medicine |
| Asks for "a doctor" with no problem and no specialty ("عايز دكتور", "I want a doctor") | `specialty: null`, no doctors, and `follow_up` asks which doctor or what symptoms |

Requests are recognised in Egyptian Arabic, MSA, English and mixed messages. A doctor
who is only *mentioned* ("دكتور القلب قالي إني كويس") is not a request. A problem
described earlier in the conversation still lets the model route a later "عايز دكتور".
Emergencies are never affected.

How the doctors are then found:

1. The service settles the canonical specialty (e.g. `cardiology`) as above.
2. This service calls `GET /api/patient/patientviewspec` and matches the
   specialty **name** against an explicit alias table (English and Arabic) to
   find its MongoDB `_id`. Matching is exact after light normalization — an
   unknown name maps to nothing rather than to a near miss, and an ObjectId is
   never constructed.
3. It calls `GET /api/patient/filterdoctor?speciality_id=<_id>`, which already
   filters `is_active: true` and `approval_status: "accepted"`.
4. It ranks the results and returns the top three.

**Ranking:** rating descending, which is also your backend's own ordering. A
missing or `0` rating sorts last so unrated doctors don't outrank rated ones.
When the caller supplied `location.city`, doctors in that governorate come
first — a *preference*, never a filter, so it can reorder the list but can never
empty it.

> ### `available` is always `null`, and that is deliberate
>
> Your backend cannot currently confirm bookable availability. `getacceptedDoctors`
> filters `availability.$elemMatch.day_of_week`, but the doctor model stores
> `schedule.working_days`; `getDoctoravailability` also selects the absent
> `availability` field. Until that mismatch is fixed, this service never asserts
> availability and never sends `today=true`. **Do not present a doctor as
> bookable based on this response.**

**`recommended_doctors` is `[]` whenever:**

| Reason | Why |
|---|---|
| `emergency: true` | A critical case belongs in an emergency department, not a booking flow. The Doctors API is never called. |
| `specialty: null` | Nothing to look up. |
| The specialty isn't in your catalogue | No guessed ObjectId. |
| The Doctors API errors or times out | Medical guidance is never blocked by the catalogue. |
| No doctor matches | Empty is an honest answer. |
### Current status: LIVE on staging

Live lookup is **enabled** on the staging deployment and reads your production
backend (`https://vercel-hospital-management-system.vercel.app`), read-only.

What was verified against the live backend before enabling it:

| Check | Result |
|---|---|
| Auth | Both GETs answer `200` with no credentials and no auth challenge |
| Schemas | Match the backend source exactly (`{_id,name,icon}`; 9 doctor fields) |
| Specialty catalogue | 15 active; 14 of our 17 canonical ids map, no collisions |
| Reliability from Modal us-east | 30/30 calls, 0.13-0.28 s |

**Specialty coverage.** These canonical ids have **no** backend specialty, so they
always return `[]`: `general_practice`, `internal_medicine`, `general_surgery`.
Your catalogue's `Rheumatology` has no canonical id, so the AI never routes there.
Add catalogue entries (or tell us their names) to close either gap.

**Location.** `governorate` is matched exactly and case-sensitively in MongoDB:
`cairo` matches, but `Cairo`, `CAIRO` and `القاهرة` return nothing. So this service
never sends it as a filter; it uses `location.city` only to rank same-governorate
doctors first, comparing case- and diacritic-insensitively. If you want server-side
filtering, normalise the stored values first.

**Current data is test data.** At the time of testing the backend held 2 doctors,
both `title: "TESTDR"` with `rating: 0` (one Dentistry, one Cardiology). With all
ratings at 0, ranking falls back to your backend's own order.

To switch it off: redeploy with `DOCTORS_API_ENABLED=false`. No code change.

**Still yours:** booking, appointments, and any availability logic.

## 7. Timeouts and latency

All figures below are measured against this deployment, not estimates.

| Scenario | Measured | Notes |
|---|---|---|
| `GET /health` | ~1.6-2.0 s | wakes the CPU container if idle |
| Emergency `/chat` | **0.05-0.5 s** warm, ~5 s if the CPU container was idle | deterministic, no GPU, no Doctors API call |
| Warm `/chat` | **16-25 s** | model inference on L4 |
| **Cold `/chat`** | **~460 s** | measured end to end, through 3 redirect hops |
| `POST /chat/async` | ~0.1 s warm, ~6 s if the CPU container was idle | returns `202` with a job id |
| `GET /chat/async/{id}` | **0.06-0.14 s** per poll | 120 polls measured during one cold start |
| **Cold async job** | **619 s** observed | completed; most of it was waiting for an L4 GPU |

**GPU availability.** On 2026-10-28 Modal had no L4 capacity for this workspace
for about 23 minutes (12:28-12:51 +03:00), with nothing on Modal's status page,
while T4 and A10 allocated in ~7 s. During such a gap every non-emergency request
waits; emergencies are unaffected. A background job gives up after 15 minutes and
reports `MODEL_TIMEOUT`. An `["L4", "A10"]` fallback would close this gap at a higher
hourly rate when it triggers; it has not been enabled.

Cold-start detail, measured rather than estimated: the GPU container needs
**199.6 s** to start and load the model (336.7 s the very first time, including the
one-time 8 GB weight download, now cached in a Modal Volume). Over HTTP that
becomes **458.9 s**, because Modal's 150-second limit means the wait is served in
150 s hops — a ~225 s job still costs three redirects before the result lands.

### Behind Vercel: use `/chat/async`

Vercel functions (Fluid compute, the default) stop at **300 s on Hobby** — also the
default on Pro, whose maximum is 800 s. A cold synchronous `/chat` (~460 s) is killed
before it answers, and raising your HTTP client timeout cannot change that: Vercel
ends the function first. The async contract keeps every HTTP request short:

```
POST /chat/async            same request body as /chat
  -> 200 {"status":"complete","job_id":null,"result":{...}}    clear emergency, answered inline
  -> 202 {"status":"pending","job_id":"fc-...","request_id":"..."}

GET /chat/async/{job_id}    poll every 2-5 s
  -> 202 {"status":"pending","job_id":"fc-..."}
  -> 200 {"status":"complete","job_id":"fc-...","result":{...}}   result = the /chat response
  -> 502/503/504 {"status":"error","job_id":"fc-...","error":{"code":"MODEL_TIMEOUT","message":"..."}}
  -> 404 {"detail":{"code":"JOB_NOT_FOUND",...}}                   unknown, malformed or expired id
```

- `result` is exactly the `/chat` response schema (section 4). Same pipeline, same
  safety checks, same doctor lookup.
- **Emergencies are never queued.** `POST /chat/async` answers them inline with the
  fixed safety message, in under a second, with no model or Doctors API call.
- Both routes need the same bearer token as `/chat`. Job ids are unguessable.
- A background job survives a Modal container preemption (Modal restarts it with
  the same input), which a synchronous `/chat` does not.
- **Polling never re-runs the model.** A poll only reads the stored outcome; one job
  is one model call.

#### Isolation between users

Send `X-Devora-Owner: <opaque value>` on both the `POST` and every `GET`. The service
stores only its SHA-256 with the job, and returns a **completed** result only to a
request carrying the same value. Anyone else gets `404 JOB_NOT_FOUND`, exactly as for an
unknown id, so nothing reveals that the job exists. Use a value that is not the raw
user id: the gateway sends an HMAC-SHA256 of the user id keyed with the AI token.

Without the header, the job id is the only credential: anyone who obtains it can read
that answer. **Put `/api/ai/chat` and `/api/ai/chat/:jobId` behind your auth middleware**
so the gateway has a user to bind the job to.

#### Retention

| What | Where | How long |
|---|---|---|
| Job input | Modal | not documented by Modal. It is **already PII-redacted** (`[PHONE]`, `[EMAIL]`, `[NATIONAL_ID]`); no user id, conversation id or coordinates are included |
| Job result | Modal | up to **7 days** (Modal's limit; there is no delete API) |
| Job result | through this API | **30 minutes** after completion, then `404` |

The 7-day storage on Modal is one reason this stays synthetic-only until a
data-processing agreement is in place.

#### Load and limits

- When more than **20** jobs are already queued, `POST /chat/async` answers
  `503 MODEL_UNAVAILABLE` instead of queuing more, to protect GPU credits. Emergencies are
  never refused.
- A job gives up after **15 minutes** (`504 MODEL_TIMEOUT` on the next poll). This only
  happens when no GPU can be found, as during the L4 shortage recorded below.
- Poll every **3-5 s** from the app; each poll takes ~0.1 s and costs no GPU. Stop after
  ~15 minutes and show a friendly failure.

**Ready-made gateway:** `integration/node-gateway/aiController.js` is a drop-in
replacement for your current Gradio-based controller. It keeps `POST /api/ai/chat`
with `{"message": "..."}`, waits up to 25 s for the answer, otherwise returns
`202 {"success": true, "status": "pending", "job_id": "..."}`, and adds
`GET /api/ai/chat/:jobId` for the app to poll. It still returns `reply` (plain text)
for the current app, plus the full structured answer as `ai`. When `req.user` exists it
sends the owner header automatically. It has 25 tests (`node --test` in that folder) and
no new dependencies.

The mobile app must handle `status: "pending"`: show a waiting state and poll
`GET /api/ai/chat/:jobId` until `status` is `complete`. Warm answers usually arrive
within the 25 s wait, so most messages need no polling at all.

### Your client MUST follow redirects

Modal's HTTP layer has a hard **150-second** limit per request. A cold `/chat`
takes longer than that, so Modal returns **`303 See Other`** with an empty body,
pointing at a result URL. Following that redirect blocks until the work finishes
and returns the real JSON; it does not start a second request.

This is normal, expected behaviour for the first request after idle — **not an
error**. But a client that doesn't follow redirects sees a bare `303` and an
empty body, and will look broken:

| Client | Follows redirects? |
|---|---|
| Node `fetch` / undici | Yes, by default — nothing to do |
| axios | Yes, by default (`maxRedirects: 21`) |
| `curl` | **No** — needs `-L` |
| Python `httpx` | **No** — needs `follow_redirects=True` |
| Python `urllib` | Only 4 by default — raise it |

Modal allows up to 20 redirects (~50 minutes total). Do **not** set
`maxRedirects: 0`.

**Set your timeout to at least 600 s (10 minutes)** for `/chat`
(`600000` ms in axios/undici). The timeout must cover the **whole redirect
chain**, not one hop. A measured cold start took **458.9 s across 3 hops**, so a
420 s timeout fails — we verified this the hard way.

One caveat from Modal: the redirect mechanism **does not work for browser CORS
requests**, because CORS headers can't be attached to a response that hasn't
returned yet. Call this endpoint **server-to-server from your Node backend**, not
directly from the browser — which is also what the bearer token requires.

Cold starts happen because the GPU is configured to **scale to zero** to conserve
credits — there is no always-on GPU. The first request after an idle period pays
the model load. If that is unacceptable for your UX, we can keep one GPU warm,
but that costs ~$0.80/hour continuously (~$576/month) and must be approved first.

Practical advice: show a progress indicator, and consider calling `/health` when
the user opens the chat to pre-warm the CPU container.

## 8. Errors and status codes

| Status | Body `detail.code` | Meaning | Retry? |
|---|---|---|---|
| `200` | — | Success | — |
| `401` | `UNAUTHORIZED` | Missing/invalid bearer token | No — fix the token |
| `404` | — | Unknown path | No |
| `422` | *(validation array)* | Request failed schema validation | No — fix the payload |
| `502` | `MODEL_ERROR` | Model failed to process the request | Yes, once |
| `502` | `MODEL_INVALID_OUTPUT` | Model returned unusable output | Yes, once |
| `503` | `MODEL_UNAVAILABLE` | Model/GPU unavailable | Yes, with backoff |
| `504` | `MODEL_TIMEOUT` | Model did not respond in time | Yes, with backoff |
| `500` | *(plain text, see below)* | Modal infrastructure: container preempted mid-request | Yes, once |
| `503` | `MODEL_UNAVAILABLE` | `POST /chat/async` only: job queue full (>20 waiting) | Yes, after a pause |
| `404` | `JOB_NOT_FOUND` | Async result unknown, expired (30 min), or belongs to another owner | No — resend the message |

**The `500` is not from this service.** Modal can reclaim (preempt) a container
while it is serving a request. The caller then receives a plain-text `500`, not
JSON:

```
modal-http: internal error: function was terminated by signal
```

We observed this once on staging during a cold start. Modal restarts the
container automatically, and an immediate retry succeeded. Handle a `500` with a
non-JSON body as transient: retry once, then show a friendly failure. Don't try
to `JSON.parse` it.

Error bodies from this service itself are fixed strings. They never contain stack traces, prompts, raw
model output, hostnames or user text:

```json
{"detail": {"code": "MODEL_TIMEOUT", "message": "The AI model did not respond in time."}}
```

`422` is the one exception in shape — it returns an array of field errors, with
the submitted values stripped out so user text is not echoed back:

```json
{"detail": [{"type": "string_too_short", "loc": ["body", "message"], "msg": "..."}]}
```

**Do not retry `422` or `401`.** For `502`/`503`/`504`, one retry then surface a
friendly failure; do not retry in a tight loop, as each attempt may start a GPU.

## 9. Working example

Request:

```bash
curl -X POST "https://mahmoudbadr238--devora-medical-ai-api.us-east.modal.run/chat" \
  -H "Authorization: Bearer $DEVORA_AI_TOKEN" \
  -H "Content-Type: application/json" \
  --max-time 600 -L \
  -d '{
    "request_id": "req_001",
    "message": "نمت على دراعي وصحيت لقيته منمل وبعد دقيقتين بدأ يفك",
    "history": [],
    "location": null
  }'
```

Response (actual output from the deployed service):

```json
{
  "request_id": "req_001",
  "status": "success",
  "intent": "symptom_query",
  "language": "ar",
  "content": {
    "summary": "ذكرت أن التنميل بدأ بعد النوم على الذراع وأنه بدأ يتحسن خلال دقائق.",
    "explanation": "التنميل في الذراع يمكن أن يحدث بسبب الضغط على الأعصاب أثناء النوم أو التمدد، وتحسنها بسرعة يدل على أن السبب عادة ما يكون عابرًا وليست مشكلة خطيرة.",
    "advice": [
      "حرّك الذراع وغيّر وضعك برفق.",
      "تجنّب الضغط على الذراع لفترة طويلة."
    ],
    "red_flags": [
      "ضعف أو تنميل جديد في جانب من الجسم",
      "صعوبة مفاجئة في الكلام أو فهم الكلام",
      "تغير واضح في الرؤية أو فقدان التوازن"
    ],
    "when_to_seek_care": "إذا لم يختفِ التنميل أو تكرر بدون سبب واضح أو زاد، راجع طبيبًا. وإذا ظهر ضعف أو صعوبة في الكلام أو اعوجاج في الوجه أو تغير في الرؤية أو فقدان توازن، اطلب رعاية طبية طارئة فورًا."
  },
  "medical": {
    "symptoms": [{ "id": "numbness", "original_text": "منمل" }],
    "duration": "بعد دقيقتين",
    "urgency": "low",
    "emergency": false
  },
  "follow_up": { "needed": false, "questions": [] },
  "specialty": null,
  "recommended_doctors": []
}
```

Emergency example — `"دراعي الشمال منمل ومش قادر أتكلم كويس دلوقتي"`:

```json
{
  "request_id": "req_002",
  "status": "success",
  "intent": "medical_emergency",
  "language": "ar",
  "content": {
    "summary": "الأعراض المذكورة قد تحتاج إلى رعاية طبية عاجلة. يُرجى التواصل مع خدمات الطوارئ المحلية أو التوجه إلى أقرب قسم طوارئ.",
    "explanation": "هذه رسالة سلامة تلقائية وليست تشخيصًا طبيًا.",
    "advice": [],
    "red_flags": [],
    "when_to_seek_care": "فورًا."
  },
  "medical": { "symptoms": [], "duration": null, "urgency": "critical", "emergency": true },
  "follow_up": { "needed": false, "questions": [] },
  "specialty": null,
  "recommended_doctors": []
}
```

## 10. Node.js gateway

Use `integration/node-gateway/aiController.js` (see section 7). It is the tested,
complete version: input validation, the async flow, fixed public error messages,
no logging of message text, no forwarding of coordinates, and handling of Modal's
plain-text `500`.

To install it in the backend repository:

1. Replace `controllers/aiController.js` with the file.
2. In `routes/aiRoutes.js`:
   ```js
   import { chatWithAI, getChatResult } from "../controllers/aiController.js";
   router.post("/chat", chatWithAI);
   router.get("/chat/:jobId", getChatResult);
   ```
   Adding a rate limiter is recommended: every non-emergency message can start a GPU.
3. Set `DEVORA_AI_URL` and `DEVORA_AI_TOKEN` in the Vercel project's environment
   variables (server-side only), and redeploy.
4. `@gradio/client` and `axios` are then no longer used by this controller.

Note that `index.js` connects to MongoDB in a middleware before every route, so
`/api/ai/chat` also fails if the database is unreachable, even though this flow
never reads it.

When the response has `ai.medical.emergency === true`, show the emergency guidance
and do not offer booking or specialist routing.

Synchronous `/chat` remains available for callers without an execution limit (scripts,
Postman, a long-running server). Those must follow redirects and allow 600 s.

## 11. Privacy and safety obligations

Please read this before sending any real traffic.

- **This is a staging deployment validated with synthetic messages only.** It has
  not been assessed against any medical-device or health-data regulation. Passing
  tests is not regulatory or clinical approval.
- **Do not send real patient records to this endpoint yet.** No BAA or equivalent
  data-processing agreement is in place with the hosting provider, and Modal's
  Starter plan carries no healthcare compliance commitments.
- The service strips email addresses, phone numbers and Egyptian national IDs
  from the message **and** the history before the text reaches the model, and
  never logs raw message content. Medical values (`180/120`, `38.5`, `500 mg`)
  are deliberately preserved. **Person-name detection is not implemented** — names
  in free text are not removed.
- The AI gives **guidance and routing only**. There is no diagnosis field by
  design, and the model never states a medication dose. Do not present its output
  as a diagnosis.
- The debug `POST /preprocess` route, which exposes detected PII, is **removed**
  from this deployment. It exists only in local development.

## 12. Model and runtime

| | |
|---|---|
| Model | `Qwen/Qwen3-4B-Instruct-2507` (non-thinking Instruct) |
| Runtime | vLLM 0.21.0, JSON-schema constrained decoding |
| GPU | NVIDIA L4 (24 GB), bf16 |
| Context | 8192 tokens |
| Max output | 2048 tokens |
| Temperature | 0 |
| Scaling | min 0 GPU containers, max 1 |

Output is schema-constrained during generation and then re-validated with
Pydantic, so a malformed response becomes a clean `502 MODEL_INVALID_OUTPUT`
rather than malformed JSON reaching you.

Local development uses the same model family via Ollama at Q4_K_M quantisation.
Cloud runs bf16, so **exact wording differs between environments** while urgency,
emergency, specialty and follow-up behaviour are held identical by the shared
deterministic layers.

## 13. Who owns what

| Owned by the AI service | Owned by the backend team |
|---|---|
| `/chat`, PII filtering, safety rules | Node.js API, auth for end users |
| Intent, urgency, emergency detection | MongoDB, doctors, bookings |
| Triage questions, specialty selection | Doctor matching and ranking |
| Prompt and guard pipeline | Mapping `specialty.id` to your IDs |
| | Populating `recommended_doctors` |

Questions about this endpoint go to the AI service owner. Please don't call the
underlying Modal GPU function directly — go through `/chat` so the safety layer
always runs.
