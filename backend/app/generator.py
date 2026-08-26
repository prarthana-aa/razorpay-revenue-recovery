import random
import json
from collections import defaultdict
from sqlalchemy.orm import Session

from . import models

SEGMENT_POOL = [
    ("SBI", "UPI"), ("Visa", "Card"), ("Paytm", "Wallet"),
    ("HDFC", "UPI"), ("ICICI", "Card"), ("Airtel", "Wallet"),
    ("Mastercard", "Card"), ("PhonePe", "UPI"),
]

FAILURE_CODES = ["issuer_decline", "otp_timeout", "expired_card", "network_error"]

ACTIONS = {
    "issuer_decline": {"label": "Reroute retry via alternate acquiring bank", "effectiveness": 0.65},
    "otp_timeout": {"label": "Trigger OTP resend with extended validity window", "effectiveness": 0.55},
    "expired_card": {"label": "Prompt customer to update card / switch method", "effectiveness": 0.35},
    "network_error": {"label": "Flag transaction for gateway health review", "effectiveness": 0.20},
}

CODE_LABELS = {
    "issuer_decline": "Issuer decline cluster",
    "otp_timeout": "OTP delivery timeout",
    "expired_card": "Expired / invalid card",
    "network_error": "Gateway / network error",
}

AVG_AMOUNT = {"UPI": 450, "Card": 1200, "Wallet": 300}

DAYS = 21
ANOMALY_START = 15
CONFIDENCE_FLOOR = 0.45
DROP_THRESHOLD = 12  # percentage points — below this, no case is raised


def _cause_weights_for_segment(rng):
    """Randomly decide how failure causes are distributed for a flagged segment.
    Sometimes one dominant cause, sometimes two competing, sometimes evenly spread —
    this is what produces different demo narratives on every regenerate."""
    concentration = rng.choice(["dominant", "competing", "spread"])
    causes = FAILURE_CODES[:]
    rng.shuffle(causes)

    if concentration == "dominant":
        top = rng.uniform(0.65, 0.85)
        remainder = 1 - top
        rest = [remainder * r for r in _random_split(rng, 3)]
        weights = [top] + rest
    elif concentration == "competing":
        a = rng.uniform(0.40, 0.50)
        b = rng.uniform(0.30, a - 0.02) if a > 0.32 else 0.30
        remainder = max(1 - a - b, 0.02)
        rest = [remainder * r for r in _random_split(rng, 2)]
        weights = [a, b] + rest
    else:  # spread
        weights = _random_split(rng, 4, low=0.15)

    total = sum(weights)
    weights = [w / total for w in weights]
    return dict(zip(causes, weights))


def _random_split(rng, n, low=0.0):
    raw = [rng.uniform(low, 1.0) for _ in range(n)]
    return raw


def generate_batch(db: Session, seed=None):
    rng = random.Random(seed)

    # single active batch at a time — wipe previous data for a clean demo state
    db.query(models.TimelineEvent).delete()
    db.query(models.Case).delete()
    db.query(models.Transaction).delete()
    db.query(models.Batch).delete()
    db.commit()

    batch = models.Batch(seed=seed)
    db.add(batch)
    db.commit()
    db.refresh(batch)

    segments = rng.sample(SEGMENT_POOL, 6)
    n_flagged = rng.choice([2, 3])
    flagged_indices = set(rng.sample(range(len(segments)), n_flagged))

    segment_meta = {}
    all_transactions = []

    for idx, (issuer, method) in enumerate(segments):
        key = f"{issuer.lower()}_{method.lower()}"
        label = f"{issuer} · {method}"
        is_flagged = idx in flagged_indices
        baseline_rate = rng.uniform(88, 95)
        anomaly_rate = rng.uniform(45, 70) if is_flagged else baseline_rate
        cause_weights = _cause_weights_for_segment(rng) if is_flagged else {
            c: 0.25 for c in FAILURE_CODES
        }
        avg_amount = AVG_AMOUNT.get(method, 500)

        segment_meta[key] = {
            "issuer": issuer, "method": method, "label": label,
            "is_flagged": is_flagged, "avg_amount": avg_amount,
        }

        for day in range(1, DAYS + 1):
            in_anomaly_window = is_flagged and day >= ANOMALY_START
            target_rate = anomaly_rate if in_anomaly_window else baseline_rate
            attempts = rng.randint(28, 42)

            for _ in range(attempts):
                success = rng.uniform(0, 100) < target_rate
                amount = round(rng.uniform(0.7, 1.3) * avg_amount, 2)
                failure_code = None
                if not success:
                    weights_to_use = cause_weights if in_anomaly_window else {
                        c: 0.25 for c in FAILURE_CODES
                    }
                    codes = list(weights_to_use.keys())
                    probs = list(weights_to_use.values())
                    failure_code = rng.choices(codes, weights=probs, k=1)[0]

                all_transactions.append(models.Transaction(
                    batch_id=batch.id, day=day, segment_key=key,
                    issuer=issuer, method=method, amount=amount,
                    status="success" if success else "failed",
                    failure_code=failure_code,
                ))

    db.bulk_save_objects(all_transactions)
    db.commit()

    return batch, segment_meta


def analyze_batch(db: Session, batch_id: int, segment_meta: dict):
    """Run real detection + diagnosis over the generated transactions
    and persist Case + TimelineEvent rows. Nothing here is hardcoded —
    every number is computed from the transactions table."""
    cases = []

    for key, meta in segment_meta.items():
        txs = db.query(models.Transaction).filter(
            models.Transaction.batch_id == batch_id,
            models.Transaction.segment_key == key,
        ).all()

        baseline_txs = [t for t in txs if t.day < ANOMALY_START]
        window_txs = [t for t in txs if t.day >= ANOMALY_START]

        baseline_success = sum(1 for t in baseline_txs if t.status == "success")
        baseline_rate = round(100 * baseline_success / len(baseline_txs), 1) if baseline_txs else 0

        window_success = sum(1 for t in window_txs if t.status == "success")
        window_rate = round(100 * window_success / len(window_txs), 1) if window_txs else 0

        drop = baseline_rate - window_rate
        if drop < DROP_THRESHOLD:
            continue  # not a meaningful anomaly — no case raised

        failed = [t for t in window_txs if t.status == "failed"]
        if not failed:
            continue

        counts = defaultdict(int)
        for t in failed:
            counts[t.failure_code] += 1
        total_failed = len(failed)

        hypotheses = []
        for code, count in sorted(counts.items(), key=lambda x: -x[1]):
            hypotheses.append({
                "code": code,
                "confidence": round(count / total_failed, 3),
                "share": count,
                "ruled_out": False,
                "reasoning": None,
            })

        top_confidence = hypotheses[0]["confidence"]
        abstained = top_confidence < CONFIDENCE_FLOOR

        for i, h in enumerate(hypotheses):
            if i == 0 and not abstained:
                h["reasoning"] = (
                    f"Explains {h['share']} of {total_failed} failures in the window "
                    f"— the strongest signal identified."
                )
            elif h["confidence"] < 0.15:
                h["ruled_out"] = True
                h["reasoning"] = (
                    f"Only {h['share']} of {total_failed} failures — consistent with "
                    f"normal background rate."
                )
            else:
                h["reasoning"] = (
                    f"{h['share']} of {total_failed} failures — a plausible alternate "
                    f"cause, kept visible rather than dismissed."
                )

        case = models.Case(
            batch_id=batch_id,
            segment_key=key,
            segment_label=meta["label"],
            baseline_rate=baseline_rate,
            current_rate=window_rate,
            window_attempts=len(window_txs),
            window_failed=total_failed,
            avg_amount=meta["avg_amount"],
            top_cause=hypotheses[0]["code"] if not abstained else None,
            top_confidence=top_confidence,
            hypotheses_json=json.dumps(hypotheses),
            status="abstained" if abstained else "pending",
        )
        db.add(case)
        db.commit()
        db.refresh(case)

        events = [
            f"Detected — success rate dropped from {baseline_rate}% to {window_rate}% "
            f"against a 14-day baseline.",
            f"Diagnosis generated — {len(hypotheses)} candidate cause(s) evaluated: "
            + ", ".join(
                f"{CODE_LABELS[h['code']]} ({round(h['confidence'] * 100)}%)"
                for h in hypotheses
            ) + ".",
        ]
        if abstained:
            events.append(
                f"Abstained — top confidence {round(top_confidence * 100)}% is below "
                f"the {int(CONFIDENCE_FLOOR * 100)}% floor. Routed to manual review."
            )

        for e in events:
            db.add(models.TimelineEvent(case_id=case.id, event=e))
        db.commit()

        cases.append(case)

    return cases
