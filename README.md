# Payment Recovery Console

**Track 03 — AI Revenue Recovery** · Razorpay Buildathon

An agent that detects payment-success degradation, reasons about *why* it's happening across competing root causes, and recovers revenue — without ever acting on money without an operator's approval.

## The problem

Payment failures rarely have one obvious cause. A segment's success rate can drop because of an issuer-side gateway issue, OTP delivery timeouts, expired cards, or network errors — often several of these at once. Most automated "fixes" either guess at a single cause or require a human to dig through raw failure logs by hand. Both are expensive: one loses money to wrong actions, the other loses money to slow ones.

## What this does

1. **Detects** — monitors success rate per payment segment (issuer × method) against a 14-day baseline and flags anomalies.
2. **Diagnoses** — ranks *multiple* candidate root causes by confidence instead of committing to one, and shows why lower-ranked causes were deprioritized.
3. **Abstains honestly** — if no hypothesis clears a 45% confidence floor, it does **not** guess. It escalates to manual review and says so plainly, rather than presenting a low-confidence guess as a decision.
4. **Recovers, with a gate** — proposes a bounded recovery action per diagnosed cause. Nothing executes without explicit operator approval, and every approved action can be reverted if it turns out to be wrong.
5. **Replays** — every case's full reasoning trail (detection → hypotheses → decision → outcome) is stored and viewable afterward in the Audit Trail tab.

## Try it

The **Case Queue** tab has three cases, each demonstrating a different reasoning outcome:

| Case | Segment | What it shows |
|---|---|---|
| CASE-1102 | HDFC · UPI | Clean, high-confidence single cause (80%) — safe to auto-recommend |
| CASE-1103 | ICICI · Card | Two competing causes, both shown — top one chosen with a "close call" flag |
| CASE-1104 | Airtel Wallet | Confidence too low (30%) on all causes — abstains and escalates instead of guessing |

Approve or reject a case to see the recovery simulation and revert flow. Check **Audit Trail** for the full stamped ledger of any case's decision history.

## What's real vs. simulated

This is a working interactive prototype, built to demonstrate the reasoning and control-flow architecture — not a production system connected to live payment data. To be upfront about scope:

- **Transaction data is synthetic and hand-authored**, seeded for a repeatable demo (`mulberry32` PRNG). It is not pulled from any real gateway or live source.
- **Root-cause diagnosis is rule-based** (frequency-share of failure codes within a flagged window), not a trained model. This was a deliberate scope choice to keep the reasoning transparent and auditable within the build window — the confidence floor, ranking, and abstention logic are the parts intended to generalize to a real ML-based diagnosis layer later.
- **Recovery actions are simulated outcomes**, not live retries against a payment gateway.
- **State is in-memory** (React state) and resets on page reload — no backend or database yet.

## Why this architecture

Most recovery agents in this space output a single answer. This one is built around three constraints that matter more for a finance-adjacent agent than raw accuracy:

- **Show competing hypotheses, not just the winner** — an operator reviewing the decision can see what was ruled out and why.
- **Calibrated abstention** — an agent that knows when it doesn't know is more trustworthy than one that's always confident, especially where money is involved.
- **Gated, reversible actions with full replay** — every automated recommendation is auditable end-to-end, which is the actual bar the track brief sets for this problem.

## Stack

React + Vite · Recharts (segment trend chart) · lucide-react (icons). No backend — fully client-side for this prototype.

## Run locally

```bash
npm install
npm run dev
```
