# Payment Recovery Console

**Track 03 — AI Revenue Recovery** · Razorpay Buildathon

An agent that detects payment-success degradation, reasons transparently about *why* it's happening across multiple competing root causes, and recovers revenue — without ever acting on money without an operator's approval. When the rule-based engine isn't confident enough to act, it can also pull in an independent LLM opinion — advisory only, never a shortcut around the approval gate.

---

## Table of contents

- [The problem](#the-problem)
- [What this does](#what-this-does)
- [How diagnosis actually works](#how-diagnosis-actually-works)
- [AI second opinion on abstained cases](#ai-second-opinion-on-abstained-cases)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Setup](#setup)
- [API reference](#api-reference)
- [CSV format](#csv-format)
- [What's real vs. simulated](#whats-real-vs-simulated)
- [Design principles](#design-principles)
- [Stack](#stack)

---

## The problem

Payment failures rarely have one obvious cause. A segment's success rate can drop because of an issuer-side gateway issue, OTP delivery timeouts, expired cards, or network errors — often several of these at once. Most automated "fixes" either guess at a single cause or require a human to dig through raw failure logs by hand. Both are expensive: one loses money to wrong actions, the other loses money to slow ones.

## What this does

1. **Detects** — computes success rate per payment segment (issuer × method) against a baseline period and flags anomalies, from real transaction rows in the database.
2. **Diagnoses** — scores every candidate root cause on five independent signals (not just how often it appears), classifies case severity, and generates a structured evidence list and a human-readable summary.
3. **Abstains honestly** — if the evidence is weak, ambiguous, or too evenly spread across causes, it does **not** guess. It escalates to manual review with a specific, stated reason.
4. **Recovers, with a gate** — proposes a bounded recovery action per diagnosed cause, with an estimated recovery rate and revenue impact. Nothing executes without explicit operator approval, and every approved action can be reverted if it turns out to be wrong.
5. **Replays** — every case's full reasoning trail (detection → scoring → decision → outcome) is stored in the database and viewable afterward in the Audit Trail tab.

You can run this on two kinds of data:

| Source | What it does |
|---|---|
| **Generate new batch** | A randomized synthetic dataset — segments, anomaly severity, and failure-cause mix are re-randomized every time you click it. |
| **Upload CSV** | Your own transaction data. The identical detection and diagnosis pipeline runs unmodified on whatever you upload — this is what proves the logic isn't fitted to a fixed demo dataset. Click **"download a sample CSV to try"** in the app for a template. |

## How diagnosis actually works

This is the part worth understanding before a demo, since it's the core of the pitch.

**Step 1 — Multi-signal scoring.** Each candidate failure cause is scored on five signals, not just raw frequency:

| Signal | Weight | What it captures |
|---|---|---|
| Failure share | 0.35 | Fraction of failures this code accounts for |
| Drop magnitude | 0.25 | How large the success-rate drop is for the window |
| Concentration | 0.20 | Normalized Shannon entropy of the failure-code distribution — are failures piled on one cause, or spread out? |
| Volume | 0.10 | Absolute number of failed transactions (a 5-failure blip and a 50-failure trend shouldn't be treated the same) |
| Ticket size | 0.10 | Average transaction amount, as a proxy for revenue impact |

Raw weighted scores are min-max normalized across candidates for that case, so the strongest candidate in a *clear-cut* case reads close to 1.0.

**Step 2 — Three-condition abstention.** A normalized top score alone can be misleading — min-max normalization will stretch even a mediocre top candidate toward 1.0 if it's still the best of a bad set. So abstention checks three things, not one:

1. Top confidence falls below the **45% floor** → abstain.
2. Top and second candidate are within **10 points** of each other → abstain (a genuine toss-up, not a real answer).
3. The single largest raw failure share is below **35%** → abstain (nothing actually dominates, regardless of how the normalized score looks).

Any one of these firing routes the case to manual review with a specific stated reason — never a silent low-confidence guess.

**Step 3 — Severity classification.** Every raised case gets a severity of `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` from the combination of drop magnitude, failure volume, and average ticket size — so operators can triage, not just read a flat list.

**Step 4 — Structured evidence + recommendation.** Each case carries a human-readable summary, a list of evidence items (signal, value, impact, explanation), and a recommended action with an estimated recovery rate and estimated revenue recovered — computed from the actual data, not templated text.

## AI second opinion on abstained cases

The rule-based engine above is the system of record for every diagnosis — it decides what gets scored, what gets flagged, and what gets abstained. Nothing described in this section changes that.

What it *does* add: for a case the rule-based engine has already abstained on, an operator can click **"Get AI second opinion"** to send the same evidence bundle (segment stats, candidate causes, the stated abstain reason) to an LLM (Google Gemini) and get an independent read.

A few things are true about this by design, not by accident:

- **It only ever runs on already-abstained cases.** A case the rule-based engine is confident about never touches the LLM at all — there's no code path from this feature back into scoring, approval, or execution.
- **It's read-only and advisory.** The response — agree/disagree with the abstention, a possible cause with its own confidence, a plain-language explanation, and a suggested next step for a human — is displayed next to the rule-based reasoning, not merged into it. It cannot approve, reject, or execute anything.
- **It fails closed.** If the API key is missing, the request times out, or the response doesn't parse, the endpoint returns an "unavailable" result with the reason shown in the UI. It never crashes the case pipeline and never silently retries into a guess.
- **It's logged to the same audit trail as everything else** — a timeline event is written whether the call succeeds or fails, so "we asked the model, here's what happened" is part of the permanent case record either way.

Implementation lives in `backend/app/llm_review.py`, exposed at `POST /api/cases/{id}/llm-review`. See [Setup](#setup) for the one-time API key configuration.

## Architecture

```
┌───────────────────┐      REST API      ┌────────────────────────────┐
│   React frontend    │ ─────────────────▶ │      FastAPI backend        │
│   (Vite, Recharts)  │ ◀───────────────── │  (SQLite via SQLAlchemy)    │
└───────────────────┘                     └────────────────────────────┘
```

- The backend can either generate a randomized synthetic transaction batch or parse an uploaded CSV — both paths land in the same `transactions` table, and detection/diagnosis (`analyze_batch`) is computed purely from that table. There is no separate code path for "demo data" vs "real data."
- The frontend holds **no business logic** — it fetches cases, the segment chart, and dashboard totals from the API, and calls approve/reject/revert endpoints, which write real state changes to the database.
- CSV upload accepts flexible input: `day` can be an integer or a date (several formats supported), and unrecognized `failure_code` values are bucketed into `network_error` and reported back rather than rejecting the whole file.
- The one external call in the whole system is the optional LLM second opinion (`llm_review.py` → Gemini API), and it's isolated on its own endpoint, its own DB column, and its own failure path — nothing else in the app depends on it being available.

## Project structure

```
razorpay-revenue-recovery/
├── backend/
│   ├── requirements.txt
│   ├── .env               # not committed — your GEMINI_API_KEY goes here
│   ├── .env.example        # template for the above
│   ├── .gitignore
│   └── app/
│       ├── __init__.py
│       ├── database.py       # SQLAlchemy engine/session setup
│       ├── models.py         # Batch, Transaction, Case, TimelineEvent
│       ├── generator.py      # synthetic data + CSV parsing + detection/diagnosis
│       ├── llm_review.py     # independent LLM second opinion (abstained cases only)
│       ├── agent.py          # /api/agent — revenue projection + policy lookup for a case
│       ├── reasoning.py      # structured (non-LLM) reasoning summary used by agent.py
│       ├── recovery_policy.py # bounded action policy table (approval mode, retry limit, reversible)
│       └── main.py           # FastAPI routes
├── src/
│   ├── App.jsx               # main console UI
│   ├── App.css
│   ├── index.css
│   └── main.jsx
├── public/
├── index.html
├── package.json
└── vite.config.js
```

## Setup

### Prerequisites
- Python 3.10+ (Windows: the `py` launcher works if `python` doesn't)
- Node.js 18+ and npm

### Backend

```bash
cd backend
python -m venv venv

# Windows PowerShell
venv\Scripts\Activate.ps1
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
```

**Optional — enable the AI second opinion feature.** Without this step, everything else in the app works exactly the same; abstained cases just won't have the "Get AI second opinion" button produce a result (it'll show "unavailable" with a clear reason).

1. Get a free API key at [aistudio.google.com](https://aistudio.google.com) — no credit card required.
2. Copy `backend/.env.example` to `backend/.env`.
3. Open `backend/.env` and paste your key:
   ```
   GEMINI_API_KEY=your_key_here
   ```
   `backend/.env` is gitignored — it will never be committed.

Then start the server:

```bash
uvicorn app.main:app --reload --port 8000
```

Leave this running. Interactive API docs are available at **http://127.0.0.1:8000/docs**.

> First run creates `recovery.db` automatically. If you ever pull a schema change (a new column on `Case`, for example) and see a `sqlite3.OperationalError: no column named ...`, just delete `recovery.db` and restart — it holds only generated/uploaded batch data, nothing you've built.

### Frontend

In a **separate terminal**:

```bash
npm install
npm run dev -- --host
```

Open the printed `localhost` URL (typically `http://localhost:5173`). The app calls `http://127.0.0.1:8000` directly, so the backend must already be running.

### Using it

1. Click **Generate new batch** for a fresh randomized dataset, or **Upload CSV** for your own data.
2. **Overview** — segment success-rate chart with the anomaly window marked, plus recovered-amount / resolution-rate / escalation-rate summary cards.
3. **Case Queue** — click a case to see its ranked hypotheses, evidence, severity, and recommended action. Approve, reject, or (after approving) revert. On an abstained case, click **"Get AI second opinion"** for the independent LLM read (requires `GEMINI_API_KEY` to be set — see [Setup](#setup)).
4. **Audit Trail** — the full stamped, timestamped reasoning trail for every case, including AI second-opinion requests and their outcomes.

## API reference

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/generate` | Wipe existing data, generate a fresh randomized batch, run detection + diagnosis |
| `POST` | `/api/upload` | Parse an uploaded CSV as a fresh batch, run the same pipeline |
| `GET`  | `/api/segments` | Daily success-rate series per segment, for the chart |
| `GET`  | `/api/cases` | List all cases for the current batch |
| `GET`  | `/api/cases/{id}` | Full case detail, including the audit timeline |
| `GET`  | `/api/agent/{id}` | Revenue projection + bounded recovery policy for a case (retry limit, reversible, approval mode) |
| `POST` | `/api/cases/{id}/approve` | Approve the recommended action; computes and stores the recovered amount |
| `POST` | `/api/cases/{id}/reject` | Reject the recommended action; no recovery is attempted |
| `POST` | `/api/cases/{id}/revert` | Mark a previously approved recovery as ineffective; removes it from the recovered total |
| `POST` | `/api/cases/{id}/mark-reviewed` | Close out an abstained case after manual review |
| `POST` | `/api/cases/{id}/llm-review` | Abstained cases only. Requests an independent LLM second opinion; stores it and logs it to the timeline. Never changes case status. |
| `GET`  | `/api/dashboard` | Aggregate totals: recovered amount, resolution rate, escalation rate |

## CSV format

Required columns (case-insensitive): `day, issuer, method, amount, status`.
Optional: `failure_code` — required for rows where `status` is failed. Expected values: `issuer_decline`, `otp_timeout`, `expired_card`, `network_error`; anything else is bucketed as `network_error` and reported back to you rather than silently misfiled.

- `day` accepts either an integer (`1`, `2`, `3`…) or a date (`YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`, `MM/DD/YYYY`).
- At least **4 distinct days** and **10 rows** are required, so the pipeline has a genuine baseline period vs. a recent window to compare.
- The last third of your date range is automatically treated as the "recent window"; the rest is the baseline.

## What's real vs. simulated

To be upfront about scope, since this matters for how the demo should be read:

- **Detection and diagnosis are computed live** from transaction rows in the database — every score, severity level, and abstention decision is computed from the data present, not hardcoded, and runs identically whether the data was generated or uploaded.
- **The synthetic generator's data is randomized** on demand; it is not pulled from any real gateway or live source. CSV upload lets you substitute real or your-own data through the exact same pipeline.
- **Diagnosis is rule-based and explainable** (weighted multi-signal scoring), not a trained model. This was a deliberate scope choice to keep every decision auditable and defensible within the build window — the scoring weights and abstention thresholds are the parts intended to generalize toward a learned model later, once there's enough labeled outcome data to train one.
- **The LLM second opinion is a real API call** (Google Gemini) — it is not scripted or templated, and it can (and sometimes will) disagree with the abstention or with itself run-to-run, since it's a live model call. It is deliberately kept out of the automated decision path for exactly that reason: it's a second read for a human, not a second vote that gets averaged in.
- **Recovery actions are simulated outcomes** (an estimated recovery rate per action type applied to the at-risk amount), not live retries against a payment gateway.
- **State persists in SQLite** across page reloads, but is scoped to a single active batch — generating a new batch or uploading a new CSV replaces the previous one, by design, to keep the demo repeatable.

## Design principles

Most recovery agents in this space output a single answer. This one is built around constraints that matter more for a finance-adjacent agent than raw accuracy:

- **Score on multiple signals, not raw frequency** — a cause that's common but was *already* common before anything broke shouldn't outrank one that's newly spiking.
- **Calibrated, multi-condition abstention** — an agent that knows when it doesn't know is more trustworthy than one that's always confident, especially where money is involved. A single confidence threshold is easy to game with normalization tricks; three independent checks are harder to fool.
- **Gated, reversible actions with full replay** — every automated recommendation is auditable end-to-end, which is the actual bar the track brief sets for this problem.
- **Severity, not just a flat list** — an operator triaging ten cases needs to know which one to open first.
- **AI opinions augment humans, they don't replace guardrails** — the LLM second opinion is additive evidence for the one category of case (abstained) where a rule-based system has already said "I'm not sure," never a way to route around the approval gate or the abstention logic itself.

## Stack

**Backend:** FastAPI · SQLAlchemy · SQLite · Google Gemini API (optional, for AI second opinion)
**Frontend:** React + Vite · Recharts (segment trend chart) · lucide-react (icons)
