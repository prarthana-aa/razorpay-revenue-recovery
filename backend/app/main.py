import json
from collections import defaultdict
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from . import models, generator
from .database import engine, get_db, Base

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Payment Recovery Console API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        "reverted": c.reverted,
        "recovered_amount": c.recovered_amount,
        "recovered_tx": c.recovered_tx,
        "chosen_action": c.chosen_action,
        "hypotheses": json.loads(c.hypotheses_json),
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
    batch, segment_meta = generator.generate_batch(db, seed=seed)
    cases = generator.analyze_batch(db, batch.id, segment_meta)
    return {"batch_id": batch.id, "cases_created": len(cases)}


@app.get("/api/segments")
def get_segments(db: Session = Depends(get_db)):
    """Daily success-rate series per segment, computed live from the transactions table."""
    batch = db.query(models.Batch).order_by(models.Batch.id.desc()).first()
    if not batch:
        raise HTTPException(404, "No batch generated yet — call POST /api/generate first")

    txs = db.query(models.Transaction).filter(models.Transaction.batch_id == batch.id).all()
    stats = defaultdict(lambda: {"success": 0, "total": 0})
    segments_seen = {}
    for t in txs:
        segments_seen[t.segment_key] = f"{t.issuer} · {t.method}"
        k = (t.day, t.segment_key)
        stats[k]["total"] += 1
        if t.status == "success":
            stats[k]["success"] += 1

    rows = []
    for day in range(1, generator.DAYS + 1):
        row = {"day": f"D{day}"}
        for seg_key in segments_seen:
            s = stats.get((day, seg_key), {"success": 0, "total": 0})
            row[seg_key] = round(100 * s["success"] / s["total"], 1) if s["total"] else None
        rows.append(row)

    return {
        "rows": rows,
        "segments": [{"key": k, "label": v} for k, v in segments_seen.items()],
        "anomaly_start": generator.ANOMALY_START,
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


@app.post("/api/cases/{case_id}/approve")
def approve_case(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status != "pending":
        raise HTTPException(400, "Case cannot be approved from its current status")

    hypotheses = json.loads(case.hypotheses_json)
    top = hypotheses[0]
    action = generator.ACTIONS[top["code"]]
    recoverable = case.window_failed * case.avg_amount
    amount = round(recoverable * action["effectiveness"], 2)
    recovered_tx = round(case.window_failed * action["effectiveness"])

    case.status = "approved"
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
    db.add(models.TimelineEvent(case_id=case.id, event="Operator rejected the recommended action. No recovery attempted."))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/revert")
def revert_case(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status != "approved" or case.reverted:
        raise HTTPException(400, "Case cannot be reverted")

    case.reverted = True
    db.add(models.TimelineEvent(case_id=case.id, event="Operator flagged the recovery as ineffective and reverted it. Amount removed from recovered total."))
    db.commit()
    return _serialize_case(case)


@app.post("/api/cases/{case_id}/mark-reviewed")
def mark_reviewed(case_id: int, db: Session = Depends(get_db)):
    case = db.get(models.Case, case_id)
    if not case or case.status != "abstained":
        raise HTTPException(400, "Only abstained cases can be marked reviewed")

    case.status = "escalated-reviewed"
    db.add(models.TimelineEvent(case_id=case.id, event="Manual review completed by ops. Outcome logged outside the automated system."))
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
