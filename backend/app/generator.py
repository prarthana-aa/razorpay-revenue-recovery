import random
import json
import csv
import io
from collections import defaultdict
from datetime import datetime as dt
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
    return [rng.uniform(low, 1.0) for _ in range(n)]


def _wipe_existing(db: Session):
    db.query(models.TimelineEvent).delete()
    db.query(models.Case).delete()
    db.query(models.Transaction).delete()
    db.query(models.Batch).delete()
    db.commit()


def generate_batch(db: Session, seed=None):
    """Create a fresh randomized synthetic transaction batch."""
    rng = random.Random(seed)
    _wipe_existing(db)

    batch = models.Batch(seed=seed, anomaly_start=ANOMALY_START, source="generated")
    db.add(batch)
    db.commit()
    db.refresh(batch)

    segments = rng.sample(SEGMENT_POOL, 6)
    n_flagged = rng.choice([2, 3])
    flagged_indices = set(rng.sample(range(len(segments)), n_flagged))

    all_transactions = []

    for idx, (issuer, method) in enumerate(segments):
        key = f"{issuer.lower()}_{method.lower()}"
        is_flagged = idx in flagged_indices
        baseline_rate = rng.uniform(88, 95)
        anomaly_rate = rng.uniform(45, 70) if is_flagged else baseline_rate
        cause_weights = _cause_weights_for_segment(rng) if is_flagged else {
            c: 0.25 for c in FAILURE_CODES
        }
        avg_amount = AVG_AMOUNT.get(method, 500)

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
    return batch


def parse_csv_and_load(db: Session, file_bytes: bytes):
    """Parse an uploaded transaction CSV and load it as a fresh batch.

    Expected columns (case-insensitive): day, issuer, method, amount, status,
    failure_code. `day` may be an integer day number or a date (several common
    formats are tried). `failure_code` should be one of: issuer_decline,
    otp_timeout, expired_card, network_error — unrecognized values are bucketed
    into network_error and reported back so nothing fails silently.
    """
    try:
        text = file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("Could not read the file as UTF-8 text. Please export the CSV as UTF-8.")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("The CSV appears to be empty.")

    field_map = {f.strip().lower(): f for f in reader.fieldnames}
    required = ["day", "issuer", "method", "amount", "status"]
    missing = [r for r in required if r not in field_map]
    if missing:
        raise ValueError(
            f"Missing required column(s): {', '.join(missing)}. "
            f"Expected columns: day, issuer, method, amount, status, failure_code "
            f"(failure_code required for rows where status is failed)."
        )

    rows = list(reader)
    if len(rows) < 10:
        raise ValueError("Need at least 10 transaction rows to run detection meaningfully.")

    raw_days = [row[field_map["day"]].strip() for row in rows]
    try:
        day_values = [int(d) for d in raw_days]
    except ValueError:
        parsed_dates = []
        for d in raw_days:
            parsed = None
            for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
                try:
                    parsed = dt.strptime(d, fmt)
                    break
                except ValueError:
                    continue
            if parsed is None:
                raise ValueError(
                    f"Could not parse day/date value '{d}'. Use an integer day "
                    f"number (1, 2, 3...) or a date like 2026-08-01."
                )
            parsed_dates.append(parsed)
        unique_sorted = sorted(set(parsed_dates))
        date_to_day = {d: i + 1 for i, d in enumerate(unique_sorted)}
        day_values = [date_to_day[d] for d in parsed_dates]

    unique_days = sorted(set(day_values))
    if len(unique_days) < 4:
        raise ValueError(
            "Need at least 4 distinct days/dates in the data to establish a "
            "baseline vs. a recent window."
        )

    split_index = max(1, (len(unique_days) * 2) // 3)
    anomaly_start = unique_days[split_index]

    _wipe_existing(db)
    batch = models.Batch(seed=None, anomaly_start=anomaly_start, source="csv_upload")
    db.add(batch)
    db.commit()
    db.refresh(batch)

    unrecognized_codes = set()
    transactions = []
    fc_field = field_map.get("failure_code")

    for row, day in zip(rows, day_values):
        issuer = row[field_map["issuer"]].strip() or "Unknown"
        method = row[field_map["method"]].strip() or "Unknown"
        amount_raw = row[field_map["amount"]].strip().replace(",", "").replace("₹", "").replace("$", "")
        try:
            amount = float(amount_raw) if amount_raw else 0.0
        except ValueError:
            amount = 0.0

        status_raw = row[field_map["status"]].strip().lower()
        status = "success" if status_raw in ("success", "successful", "ok", "completed", "1", "true", "captured") else "failed"

        failure_code = None
        if status == "failed":
            fc_raw = row.get(fc_field, "").strip() if fc_field else ""
            if fc_raw:
                normalized = fc_raw.lower().replace(" ", "_").replace("-", "_")
                if normalized in FAILURE_CODES:
                    failure_code = normalized
                else:
                    unrecognized_codes.add(fc_raw)
                    failure_code = "network_error"
            else:
                failure_code = "network_error"

        key = f"{issuer.lower().replace(' ', '_')}_{method.lower().replace(' ', '_')}"
        transactions.append(models.Transaction(
            batch_id=batch.id, day=day, segment_key=key,
            issuer=issuer, method=method, amount=amount,
            status=status, failure_code=failure_code,
        ))

    db.bulk_save_objects(transactions)
    db.commit()

    return batch, {
        "rows_loaded": len(transactions),
        "unrecognized_failure_codes": sorted(unrecognized_codes),
    }


def analyze_batch(db: Session, batch_id: int, anomaly_start: int):
    """Run real detection + diagnosis over whatever transactions exist for this
    batch in the database. Works identically for generated or uploaded data —
    every number here is computed live, nothing is hardcoded."""
    cases = []

    segment_keys = [
        row[0] for row in
        db.query(models.Transaction.segment_key)
        .filter(models.Transaction.batch_id == batch_id)
        .distinct()
        .all()
    ]

    for key in segment_keys:
        txs = db.query(models.Transaction).filter(
            models.Transaction.batch_id == batch_id,
            models.Transaction.segment_key == key,
        ).all()
        if not txs:
            continue

        label = f"{txs[0].issuer} · {txs[0].method}"
        avg_amount = sum(t.amount for t in txs) / len(txs)

        baseline_txs = [t for t in txs if t.day < anomaly_start]
        window_txs = [t for t in txs if t.day >= anomaly_start]
        if not baseline_txs or not window_txs:
            continue

        baseline_success = sum(1 for t in baseline_txs if t.status == "success")
        baseline_rate = round(100 * baseline_success / len(baseline_txs), 1)

        window_success = sum(1 for t in window_txs if t.status == "success")
        window_rate = round(100 * window_success / len(window_txs), 1)

        drop = baseline_rate - window_rate
        if drop < DROP_THRESHOLD:
            continue

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
            segment_label=label,
            baseline_rate=baseline_rate,
            current_rate=window_rate,
            window_attempts=len(window_txs),
            window_failed=total_failed,
            avg_amount=round(avg_amount, 2),
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
            f"against a baseline period.",
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
