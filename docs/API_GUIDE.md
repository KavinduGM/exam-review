# Exam Link Registry — API Integration Guide

This service is the **source of truth** for every exam across the exam-prep sites:
its canonical **exam number**, **exam name**, and all **links** (study guide,
practice questions, timed exams, contact), plus the live **up/down status** of
each link. It exists to feed a YouTube-description automation and to keep a
closed broken-link feedback loop with it.

This guide is self-contained: an automation project can build a complete
integration from this document alone. A machine-readable OpenAPI 3.1 spec is also
available at [`openapi.yaml`](./openapi.yaml).

---

## 1. Base URL & Authentication

| | |
|---|---|
| **Base URL** | `https://<your-monitor-domain>` (the Dokploy domain for this app) |
| **Auth** | A single shared secret, the `DESCRIPTION_API_KEY` |

Send the key on protected endpoints in **any** of these ways:

```
x-api-key: <DESCRIPTION_API_KEY>
Authorization: Bearer <DESCRIPTION_API_KEY>
?key=<DESCRIPTION_API_KEY>        (query string; avoid in logs)
```

Prefer the `x-api-key` header. `401 unauthorized` = missing/wrong key.
`503` = the server has no key configured (set `DESCRIPTION_API_KEY` in its env).

**Which endpoints need the key**

| Endpoint | Auth |
|---|---|
| `GET /api/resolve/{key}` | 🔒 key required |
| `GET /api/description/{site}/{code}` | 🔒 key required |
| `POST /api/reports`, `GET /api/reports[/{id}]` | 🔒 key required |
| `GET /api/exam/{group}/{code}` | 🌐 public |
| `GET /api/exams/{site}/{code}` | 🌐 public |
| `GET /api/health` | 🌐 public |

---

## 2. Channel codes

The automation identifies an exam by a **channel-coded key**:

```
<CHANNEL>_<CONTENT_TYPE>_<EXAM_CODE>
   OAP   _    SG        _   D310
 NURSING _    QA        _   TEAS
```

**Channel → site**

| Channel | Site | Site key |
|---|---|---|
| `OAP` | OA Practice | `oapractice` |
| `OAG` | OA Guides | `oaguides` |
| `NURSING` | Nursing Exam Support | `nursingexamsupport` |
| `STATE` | State Exams Prep | `stateexamsprep` |

**Content type** (`SG` = Study Guide, `QA` = Questions & Answers) is **ignored**
for resolution — the same exam has both. It's parsed and echoed back for your
reference, but it does not change which exam is returned.

Parser is tolerant: `_`, `-`, `/`, or spaces as separators; the content-type
token is optional (`OAP_D426` works); exam codes may contain a separator
(`STATE_QA_NY_PCL` → code `NY_PCL`). Channel and code are matched
case-insensitively.

---

## 3. The primary call: resolve an exam

### `GET /api/resolve/{key}` 🔒

Turn a channel-coded key into a **canonical exam name + number + links**, with a
**confidence** you can trust before publishing.

```bash
curl -H "x-api-key: $KEY" \
  "https://<domain>/api/resolve/OAP_SG_D310"
```

**200 — resolved**

```json
{
  "input": "OAP_SG_D310",
  "channel": "OAP",
  "site": "oapractice",
  "contentType": "SG",
  "requestedCode": "D310",
  "confidence": "exact",
  "matchedVia": "exact code",
  "resolved": true,
  "examCode": "D310",
  "examName": "Leadership and Management in Nursing",
  "nameResolved": true,
  "links": {
    "studyGuide": "https://oapractice.com/d310",
    "practiceQuestions": "https://questions.oapractice.com/classes/d310/set1-part1.html",
    "timedExams": "https://onlineexamtest.com/exam_sets/leadership-and-management-d310/set-1",
    "contact": "https://oapractice.com/contact"
  },
  "alternativeCandidates": []
}
```

### Confidence levels — how to act on each

| `confidence` | HTTP | Meaning | Recommended action |
|---|---|---|---|
| `exact` | 200 | Exam code matched exactly. | **Use it.** |
| `strong` | 200 | One clear fuzzy winner (vendor prefix, name/slug match). | **Use it**, optionally log `matchedVia`. |
| `ambiguous` | 409 | Several exams matched similarly (e.g. multi-part `C213-I`/`C213-II`). | **Don't auto-use.** Pick from `candidates` or flag for a human. |
| `none` | 404 | Nothing matched. | Flag for review; the exam may not be collected yet. |

Always check `confidence` (or the HTTP status) — never assume the first candidate
is right on `409`/`404`.

### Why fuzzy matching matters (nursing/state)

The document title and the stored code often differ. Examples the resolver
handles automatically:

| Automation sends | Resolves to | Via |
|---|---|---|
| `NURSING_QA_TEAS` | `TEAS` — "Test of Essential Academic Skills - TEAS" | exact |
| `NURSING_QA_ATITEAS` / `..._ATI_TEAS` | `TEAS` | vendor prefix stripped |
| `STATE_QA_NY_PCL` / `..._NYPCL` | `NYPCL` | separators normalized |
| `OAG_QA_C720` | `C720` — "Operations and Supply Chain Management" | exact / brand-group fallback |
| `OAP_SG_C213` | **ambiguous** → `C213-I`, `C213-II` | flagged for review |

`nameResolved: true` means the name came from the exam-manager database (the
authoritative source). `false` means it's a placeholder derived from the page
title — usable, but not yet DB-verified.

**Ambiguous / not-found response (409 / 404)**

```json
{
  "input": "OAP_SG_C213",
  "channel": "OAP",
  "site": "oapractice",
  "requestedCode": "C213",
  "confidence": "ambiguous",
  "matchedVia": "multiple exams score similarly for \"C213\"",
  "resolved": false,
  "candidates": [
    { "examCode": "C213-I",  "examName": "Accounting for Decision Makers I",  "site": "oapractice", "score": 80 },
    { "examCode": "C213-II", "examName": "Accounting for Decision Makers II", "site": "oapractice", "score": 80 }
  ]
}
```

---

## 4. Building the YouTube description

Once you have a confident exam, get the ready-to-paste description block:

### `GET /api/description/{site}/{code}` 🔒

```bash
curl -H "x-api-key: $KEY" \
  "https://<domain>/api/description/oapractice/D310"
```

```json
{
  "site": "oapractice",
  "siteName": "OA Practice",
  "examCode": "D310",
  "examName": "Leadership and Management in Nursing",
  "nameResolved": true,
  "links": {
    "studyGuide": "https://oapractice.com/d310",
    "practiceQuestions": "https://questions.oapractice.com/classes/d310/set1-part1.html",
    "timedExams": "https://onlineexamtest.com/exam_sets/leadership-and-management-d310/set-1",
    "contact": "https://oapractice.com/contact"
  },
  "status": { "studyGuide": "up", "practiceQuestions": "up", "timedExams": "up", "contact": "up" },
  "allUp": true,
  "labels": {
    "studyGuide": "Study Guide & Course Breakdown:",
    "practiceQuestions": "Free Practice Questions:",
    "timedExams": "Free Timed Exams:",
    "contact": "Want a Guaranteed Pass? Connect with our premium tutors today:"
  },
  "descriptionBlock": "Study Guide & Course Breakdown:\nhttps://oapractice.com/d310\n\nFree Practice Questions:\nhttps://questions.oapractice.com/classes/d310/set1-part1.html\n\nFree Timed Exams:\nhttps://onlineexamtest.com/exam_sets/leadership-and-management-d310/set-1\n\nWant a Guaranteed Pass? Connect with our premium tutors today:\nhttps://oapractice.com/contact"
}
```

- `descriptionBlock` is the exact 4-line-labelled text, ready to paste.
- `status` / `allUp` let you **skip publishing a description whose links are
  down** — publish only when `allUp` is `true`, or drop the down entry.
- `{code}` accepts the canonical code from `/api/resolve` (`D310`). It also
  tolerates legacy slug-coded rows, so `C720` works even if stored differently.

### Grouped export (OAP + OAG together)

`GET /api/exam/{group}/{code}` 🌐 returns one exam's links from **every site in a
brand group** (group `oa` = OAP + OAG), under one canonical name, with timed
links de-duplicated. Use this if a video covers the shared OA brand rather than a
single channel. Groups: `oa`, `nursing`, `state`.

---

## 5. Broken-link feedback loop

When your reviewer thinks a link is broken, don't guess — report it. We re-check
it **live**, watch it, and tell you when it recovers.

### `POST /api/reports` 🔒

```bash
curl -X POST -H "x-api-key: $KEY" -H "content-type: application/json" \
  "https://<domain>/api/reports" \
  -d '{
        "url": "https://questions.oapractice.com/classes/d310/set2-part1.html",
        "context": { "videoId": "abc123", "descriptionId": 987 },
        "callbackUrl": "https://<your-automation>/webhooks/link-recovered"
      }'
```

**Response**

- **`200` `{ "tracked": false, "status": "up" }`** — the link is actually up right
  now (your reviewer hit a transient blip). **Safe to publish.** Nothing tracked.
- **`202` `{ "tracked": true, "reportId": 42, "status": "down"|"degraded" }`** —
  confirmed broken. We now:
  1. Re-check it every ~10 minutes.
  2. **POST your `callbackUrl`** (or the server-configured `DESCRIPTION_WEBHOOK_URL`)
     when it recovers.
  3. **Email the admin** if it's still down after `REPORT_ESCALATION_HOURS`
     (default 24h).

### Recovery webhook (we call you)

When a reported link comes back, we POST to your `callbackUrl` with header
`x-api-key: <DESCRIPTION_WEBHOOK_KEY>` (if configured). Respond `2xx` to ack;
non-2xx is retried next sweep.

```json
{
  "event": "link.recovered",
  "reportId": 42,
  "url": "https://questions.oapractice.com/classes/d310/set2-part1.html",
  "site": "oapractice",
  "examCode": "D310",
  "examName": "Leadership and Management in Nursing",
  "context": { "videoId": "abc123", "descriptionId": 987 },
  "reportedAt": "2026-07-16T10:00:00.000Z",
  "recoveredAt": "2026-07-16T10:40:00.000Z"
}
```

### Poll instead of webhook

`GET /api/reports/{id}` 🔒 → `{ "status": "OPEN|RECOVERED|ESCALATED",
"safeToAttach": true|false, ... }`. Poll until `safeToAttach` is `true`.
`GET /api/reports?status=OPEN` lists all open reports.

---

## 6. Recommended automation flow

```
For each (channel, examCode) the automation processes:

1. GET /api/resolve/{CHANNEL}_{TYPE}_{CODE}
   • confidence exact|strong → continue with examName + examCode
   • confidence ambiguous|none → route to human review, STOP
2. GET /api/description/{site}/{examCode}
   • if allUp == false:
        POST /api/reports for each down link (with videoId in context)
        hold the description until the recovery webhook says safeToAttach
   • else: publish using descriptionBlock
3. On the recovery webhook (link.recovered): re-fetch the description & publish.
```

---

## 7. Reference

### Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/resolve/{key}` | 🔒 | Channel key → canonical name + links (+ confidence) |
| GET | `/api/description/{site}/{code}` | 🔒 | Ready-to-paste description block + link status |
| GET | `/api/exam/{group}/{code}` | 🌐 | Grouped export (OAP+OAG), one canonical name |
| GET | `/api/exams/{site}/{code}` | 🌐 | All links for one exam on one site (raw) |
| POST | `/api/reports` | 🔒 | Report a broken link (live re-check) |
| GET | `/api/reports/{id}` | 🔒 | Poll a report's status |
| GET | `/api/reports?status=` | 🔒 | List reports |
| GET | `/api/health` | 🌐 | Liveness |

### Server-side environment (set in Dokploy)

| Var | Purpose |
|---|---|
| `DESCRIPTION_API_KEY` | The shared key for all 🔒 endpoints. **Required.** |
| `DESCRIPTION_WEBHOOK_URL` | Default recovery-webhook target (optional if you always pass `callbackUrl`). |
| `DESCRIPTION_WEBHOOK_KEY` | Sent as `x-api-key` on the recovery webhook. |
| `REPORT_ESCALATION_HOURS` | Hours before a still-down report emails the admin (default 24). |

### Conventions

- **Exam code is the key**: `D310`, `C720`, `TEAS`, `NYPCL`. Multi-part course
  articles use a roman suffix (`C213-I`, `C213-II`).
- All timestamps are ISO-8601 UTC.
- Link `status` values: `up`, `degraded` (loads but content looks wrong), `down`.
- A resolve/description call reflects the **latest collected** data; collection
  refreshes daily, uptime every ~10 minutes.
