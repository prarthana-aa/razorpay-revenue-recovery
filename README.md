# Payment Recovery Console

**Track 03 — AI Revenue Recovery** · Razorpay Buildathon

An agent that detects payment-success degradation, reasons about *why* it's happening across competing root causes, and recovers revenue — without ever acting on money without an operator's approval.

## The problem

Payment failures rarely have one obvious cause. A segment's success rate can drop because of an issuer-side gateway issue, OTP delivery timeouts, expired cards, or network errors — often several of these at once. Most automated "fixes" either guess at a single cause or require a human to dig through raw failure logs by hand. Both are expensive: one loses money to wrong actions, the other loses money to slow ones.

## What this does

1. **Detects** — computes success rate per payment segment (issuer × method) against a 14-day baseline and flags anomalies, from real transaction rows in the database.
2. **Diagnoses** — ranks *multiple* candidate root causes by confidence (computed from the actual distribution of failure codes in the flagged window), and shows why lower-ranked causes were deprioritized.
3. **Abstains honestly** — if no hypothesis clears a 45% confidence floor, it does **not** guess. It escalates to manual review and says so plainly, rather than presenting a low-confidence guess as a decision.
4. **Recovers, with a gate** — proposes a bounded recovery action per diagnosed cause. Nothing executes without explicit operator approval, and every approved action can be reverted if it turns out to be wrong.
5. **Replays** — every case's full reasoning trail (detection → hypotheses → decision → outcome) is stored in the database and viewable afterward in the Audit Trail tab.

## Architecture

```
┌─────────────────┐      REST API      ┌──────────────────────┐
│  React frontend  │ ─────────────────▶ │   FastAPI backend     │
│  (Vite, Recharts)│ ◀───────────────── │   (SQLite via SQLAlchemy) │
└─────────────────┘                     └──────────────────────┘
```

- The backend generates a randomized synthetic transaction batch on demand, computes detection and diagnosis live from that data, and persists cases and decisions to a SQLite database.
- The frontend holds **no business logic** — it fetches cases, the segment chart, and dashboard totals from the API, and calls approve/reject/revert endpoints, which write real state changes to the database.
- Click **"Generate new batch"** in the app to trigger a fresh randomized dataset — segments, anomaly severity, and failure-cause distributions are re-randomized each time, so the cases you see (clean single-cause, competing hypotheses, or honest abstention) genuinely depend on the data generated, not a script.

## Run it locally

**Backend:**
```bash
cd backend
python -m venv venv
venv\Scripts\Activate.ps1      # Windows PowerShell
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
API docs available at `http://127.0.0.1:8000/docs`.

**Frontend** (separate terminal):
```bash
cd recovery-console
npm install
npm run dev -- --host
```
Open the printed `localhost` URL. Click **Generate new batch** to populate data — the app calls out to `http://127.0.0.1:8000`, so the backend must be running first.

## What's real vs. simulated

To be upfront about scope, since this matters for how the demo should be read:

- **Detection and diagnosis are computed live** from transaction rows in the database — confidence scores, hypothesis ranking, and the abstention decision are not hardcoded anywhere.
- **Transaction data is synthetic**, generated on demand with a randomized mix of segments, anomaly severities, and failure-cause distributions. It is not pulled from any real gateway or live source.
- **Root-cause diagnosis is rule-based** (frequency-share of failure codes within the flagged window), not a trained model. This was a deliberate scope choice to keep the reasoning transparent and auditable within the build window — the confidence floor, ranking, and abstention logic are the parts intended to generalize to a real ML-based diagnosis layer later.
- **Recovery actions are simulated outcomes** (deterministic effectiveness per action type), not live retries against a payment gateway.
- **State persists in SQLite** across page reloads (a real improvement over an earlier in-memory prototype), but the database resets to a fresh batch each time "Generate new batch" is clicked, by design, to keep the demo repeatable.

## Why this architecture

Most recovery agents in this space output a single answer. This one is built around three constraints that matter more for a finance-adjacent agent than raw accuracy:

- **Show competing hypotheses, not just the winner** — an operator reviewing the decision can see what was ruled out and why.
- **Calibrated abstention** — an agent that knows when it doesn't know is more trustworthy than one that's always confident, especially where money is involved.
- **Gated, reversible actions with full replay** — every automated recommendation is auditable end-to-end, which is the actual bar the track brief sets for this problem.

## Stack

**Backend:** FastAPI · SQLAlchemy · SQLite
**Frontend:** React + Vite · Recharts (segment trend chart) · lucide-react (icons)
