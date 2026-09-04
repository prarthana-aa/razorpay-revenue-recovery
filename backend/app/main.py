import json
from collections import defaultdict
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from . import models, generator, agent, llm_review
from .database import engine, get_db, Base, SessionLocal

Base.metadata.create_all(bind=engine)

# Migration guard: add new columns to 'cases' if they were introduced after the
# table was first created. SQLite ignores ALTER TABLE ... ADD COLUMN if it errors
# (duplicate column), so we swallow OperationalError safely.
_NEW_CASE_COLS = [
    "ALTER TABLE cases ADD COLUMN diagnosis_category TEXT",
    "ALTER TABLE cases ADD COLUMN severity TEXT",
    "ALTER TABLE cases ADD COLUMN diagnosis_summary TEXT",
    "ALTER TABLE cases ADD COLUMN evidence_json TEXT",
    "ALTER TABLE cases ADD COLUMN recommendation_json TEXT",
    "ALTER TABLE cases ADD COLUMN abstain_reason TEXT",
    "ALTER TABLE cases ADD COLUMN lifecycle TEXT DEFAULT 'DETECTED'",
    "ALTER TABLE cases ADD COLUMN llm_opinion_json TEXT",
]
with engine.connect() as _conn:
    for _stmt in _NEW_CASE_COLS:
        try:
            _conn.execute(__import__("sqlalchemy").text(_stmt))
        except Exception:
            pass  # column already exists — safe to ignore


DEMO_SEED = 20260904


def _seed_demo_batch():
    """Create the judge-friendly initial batch with one approved outcome."""
    db = SessionLocal()
    try:
        if db.query(models.Batch).first():
            return
        batch = generator.generate_batch(db, seed=DEMO_SEED)
        cases = generator.analyze_batch(db, batch.id, batch.anomaly_start)
        approved = next((c for c in cases if c.status == "pending"), None)
        if approved:
            action = generator.ACTIONS[json.loads(approved.hypotheses_json)[0]["code"]]
            approved.status = "approved"
            approved.lifecycle = "RECOVERED"
            approved.recovered_amount = round(approved.window_failed * approved.avg_amount * action["effectiveness"], 2)
            approved.recovered_tx = round(approved.window_failed * action["effectiveness"])
            approved.chosen_action = action["label"]
            db.commit()
    finally:
        db.close()


app = FastAPI(title="Payment Recovery Console API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_seed_demo_batch()


def _serialize_case(c, include_timeline=False, db: Optional[Session] = None):
    data = {
        "id": c.id,
        "segment": c.segment_label,
        "baseline_rate": c.baseline_rate,
        "current_rate": c.current_rate,
        "window_attempts": c.window_attempts,
        "window_failed": c.window_failed,
        "avg_amount": c.avg_amount,
        "status": c.status,
        "lifecycle": c.lifecycle or ("ESCALATED" if c.status in ("abstained", "escalated-reviewed") else "RECOVERED" if c.status == "approved" and not c.reverted else "DETECTED"),
        "reverted": c.reverted,
        "recovered_amount": c.recovered_amount,
        "recovered_tx": c.recovered_tx,
        "chosen_action": c.chosen_action,
        "hypotheses": json.loads(c.hypotheses_json),
        # --- explainable diagnosis fields ---
        "diagnosis_category": c.diagnosis_category,
        "severity": c.severity,
        "diagnosis_summary": c.diagnosis_summary,
        "evidence": json.loads(c.evidence_json) if c.evidence_json else [],
        "recommendation": json.loads(c.recommendation_json) if c.recommendation_json else None,
        "abstain_reason": c.abstain_reason,
        "llm_opinion": json.loads(c.llm_opinion_json) if c.llm_opinion_json else None,
    }
    if include_timeline and db is not None:
        events = (
            db.query(models.TimelineEvent)
            .filter(models.TimelineEvent.case_id == c.id)
            .order_by(models.TimelineEvent.ts)
            .all()
        )
        data["timeline"] = [{"ts": e.ts.isoformat(), "event": e.event} for e in events]
    return data



@app.post("/api/generate")
def generate(seed: Optional[int] = None, db: Session = Depends(get_db)):
    batch = generator.generate_batch(db, seed=seed)
    cases = generator.analyze_batch(db, batch.id, batch.anomaly_start)
    return {"batch_id": batch.id, "cases_created": len(cases), "source": "generated"}


@app.post("/api/demo")
def demo_batch(db: Session = Depends(get_db)):
    """Reset to a deterministic demo batch and pre-approve one safe case."""
    batch = generator.generate_batch(db, seed=DEMO_SEED)
    cases = generator.analyze_batch(db, batch.id, batch.anomaly_start)
    approved = next((c for c in cases if c.status == "pending"), None)
    if approved:
        action = generator.ACTIONS[json.loads(approved.hypotheses_json)[0]["code"]]
        approved.status = "approved"
        approved.lifecycle = "RECOVERED"
        approved.recovered_amount = round(approved.window_failed * approved.avg_amount * action["effectiveness"], 2)
        approved.recovered_tx = round(approved.window_failed * action["effectiveness"])
        approved.chosen_action = action["label"]
        db.commit()
    return {"batch_id": batch.id, "selected_case_id": approved.id if approved else (cases[0].id if cases else None), "cases_created": len(cases), "source": "demo"}


@app.post("/api/upload")
async def upload_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Please upload a .csv file.")
    content = await file.read()
    try:
        batch, info = generator.parse_csv_and_load(db, content)
    except ValueError as e:
        raise HTTPException(400, str(e))

    cases = generator.analyze_batch(db, batch.id, batch.anomaly_start)
    return {
        "batch_id": batch.id,
        "cases_created": len(cases),
        "source": "csv_upload",
        **info,
    }


@app.get("/api/segments")
def get_segments(db: Session = Depends(get_db)):
    """Daily success-rate series per segment, computed live from the transactions table."""
    batch = db.query(models.Batch).order_by(models.Batch.id.desc()).first()
    if not batch:
        raise HTTPException(404, "No batch generated yet — call POST /api/generate first")

    txs = db.query(models.Transaction).filter(models.Transaction.batch_id == batch.id).all()
    stats = defaultdict(lambda: {"success": 0, "total": 0})
    segments_seen = {}
    all_days = set()
    for t in txs:
        segments_seen[t.segment_key] = f"{t.issuer} · {t.method}"
        all_days.add(t.day)
        k = (t.day, t.segment_key)
        stats[k]["total"] += 1
        if t.status == "success":
            stats[k]["success"] += 1

    rows = []
    for day in sorted(all_days):
        row = {"day": f"D{day}"}
        for seg_key in segments_seen:
            s = stats.get((day, seg_key), {"success": 0, "total": 0})
            row[seg_key] = round(100 * s["success"] / s["total"], 1) if s["total"] else None
        rows.append(row)

    return {
        "rows": rows,
        "segments": [{"key": k, "label": v} for k, v in segments_seen.items()],
        "anomaly_start": batch.anomaly_start,
    }


@app.get("/api/cases")
def list_cases(db: Session = Depends(get_db)):
    batch = db.query(models.Batch).order_by(models.Batch.id.desc()).first()
    if not batch:
        return []
    cases = db.query(models.Case).filter(models.Case.batch_id == batch.id).all()
    return [_serialize_case(c) for c in cases]


@app.get("/api/cases/{case_id}")
def get_case(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    return _serialize_case(case, include_timeline=True, db=db)


@app.get("/api/agent/{case_id}")
def get_agent(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    return agent.run_agent(case)

@app.post("/api/cases/{case_id}/lifecycle")
def update_lifecycle(case_id: int, state: str, event: str = "", db: Session = Depends(get_db)):
    allowed = {"DETECTED", "INVESTIGATING", "READY", "AWAITING_APPROVAL", "EXECUTING", "RECOVERED", "ESCALATED"}
    case = db.get(models.Case, case_id)
    if not case or state not in allowed:
        raise HTTPException(400, "Invalid lifecycle transition")
    case.lifecycle = state
    if event:
        db.add(models.TimelineEvent(case_id=case.id, event=event))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/approve")
def approve_case(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status not in ("pending", "approved") or case.reverted:
        raise HTTPException(400, "Case cannot be approved from its current status")

    hypotheses = json.loads(case.hypotheses_json)
    top = hypotheses[0]
    action = generator.ACTIONS[top["code"]]
    recoverable = case.window_failed * case.avg_amount
    amount = round(recoverable * action["effectiveness"], 2)
    recovered_tx = round(case.window_failed * action["effectiveness"])

    case.status = "approved"
    case.lifecycle = "RECOVERED"
    case.recovered_amount = amount
    case.recovered_tx = recovered_tx
    case.chosen_action = action["label"]

    db.add(models.TimelineEvent(case_id=case.id, event=f"Operator approved action: {action['label']}."))
    db.add(models.TimelineEvent(
        case_id=case.id,
        event=f"Outcome — ₹{amount:,.0f} recovered across {recovered_tx} transactions "
              f"({round(action['effectiveness'] * 100)}% of failed volume in segment).",
    ))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/reject")
def reject_case(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status != "pending":
        raise HTTPException(400, "Case cannot be rejected from its current status")

    case.status = "rejected"
    case.lifecycle = "ESCALATED"
    db.add(models.TimelineEvent(case_id=case.id, event="Operator rejected the recommended action. No recovery attempted."))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/revert")
def revert_case(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status != "approved" or case.reverted:
        raise HTTPException(400, "Case cannot be reverted")

    case.reverted = True
    case.lifecycle = "READY"
    db.add(models.TimelineEvent(case_id=case.id, event="Operator flagged the recovery as ineffective and reverted it. Amount removed from recovered total."))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/mark-reviewed")
def mark_reviewed(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status != "abstained":
        raise HTTPException(400, "Only abstained cases can be marked reviewed")

    case.status = "escalated-reviewed"
    case.lifecycle = "ESCALATED"
    db.add(models.TimelineEvent(case_id=case.id, event="Manual review completed by ops. Outcome logged outside the automated system."))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/llm-review")
def llm_review_case(case_id: int, db: Session = Depends(get_db)):
    """Get an independent LLM second opinion on an abstained case.

    Only valid for cases the rule-based engine has already abstained on.
    This never changes case status, never triggers approval, and never
    feeds back into the scoring pipeline — it's a read-only opinion for a
    human reviewer, stored alongside the case for the audit trail.
    """
    case = db.get(models.Case, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    if case.status not in ("abstained", "escalated-reviewed"):
        raise HTTPException(400, "LLM review is only available for abstained/escalated cases")

    hypotheses = json.loads(case.hypotheses_json) if case.hypotheses_json else []
    evidence = json.loads(case.evidence_json) if case.evidence_json else []

    opinion = llm_review.get_second_opinion(case, evidence, hypotheses)
    case.llm_opinion_json = json.dumps(opinion)

    if opinion.get("available"):
        db.add(models.TimelineEvent(
            case_id=case.id,
            event=(
                f"AI second opinion requested — model {'agrees' if opinion.get('agrees_with_abstention') else 'disagrees'} "
                f"with the abstention. Suggested cause: {opinion.get('likely_cause')} "
                f"({opinion.get('confidence_percent')}% confidence). Advisory only — no automated action taken."
            ),
        ))
    else:
        db.add(models.TimelineEvent(
            case_id=case.id,
            event=f"AI second opinion requested but unavailable: {opinion.get('error')}",
        ))

    db.commit()
    return _serialize_case(case)


@app.get("/api/dashboard")
def dashboard(db: Session = Depends(get_db)):
    batch = db.query(models.Batch).order_by(models.Batch.id.desc()).first()
    if not batch:
        return {"recovered": 0, "recoverable": 0, "resolution_rate": 0, "escalation_rate": 0, "flagged_segments": 0}

    cases = db.query(models.Case).filter(models.Case.batch_id == batch.id).all()
    recovered = sum(c.recovered_amount for c in cases if c.status == "approved" and not c.reverted and c.recovered_amount)
    recoverable = sum(c.window_failed * c.avg_amount for c in cases)
    resolved = sum(1 for c in cases if c.status in ("approved", "rejected"))
    escalated = sum(1 for c in cases if c.status in ("abstained", "escalated-reviewed"))
    n = len(cases) or 1

    return {
        "recovered": round(recovered),
        "recoverable": round(recoverable),
        "resolution_rate": round(100 * resolved / n),
        "escalation_rate": round(100 * escalated / n),
        "flagged_segments": len(cases),
    }
