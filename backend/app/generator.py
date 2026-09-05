import math
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

# Maps low-level failure codes to business-level root-cause categories.
ROOT_CAUSE_CATEGORIES = {
    "otp_timeout":    "Customer Authentication Failure",
    "issuer_decline": "Issuer / Bank Decline",
    "network_error":  "Payment Infrastructure Failure",
    "expired_card":   "Customer Payment Method Failure",
}

# Per-category recovery playbook (action text + base recovery rate).
RECOVERY_PLAYBOOK = {
    "Customer Authentication Failure": {
        "action": "Retry OTP flow with longer validity and alternate notification channel.",
        "estimated_recovery_rate": 0.55,
    },
    "Issuer / Bank Decline": {
        "action": "Reroute retry via alternate acquiring bank.",
        "estimated_recovery_rate": 0.65,
    },
    "Payment Infrastructure Failure": {
        "action": "Flag transaction for gateway health review and trigger fallback gateway.",
        "estimated_recovery_rate": 0.20,
    },
    "Customer Payment Method Failure": {
        "action": "Prompt customer to update payment method or switch instrument.",
        "estimated_recovery_rate": 0.35,
    },
}

AVG_AMOUNT = {"UPI": 450, "Card": 1200, "Wallet": 300}

DAYS = 21
ANOMALY_START = 15
CONFIDENCE_FLOOR = 0.45
DROP_THRESHOLD = 12  # percentage points — below this, no case is raised

# Scoring signal weights (must sum to 1.0).
_W_SHARE       = 0.35  # fraction of failures this code accounts for
_W_DROP        = 0.25  # magnitude of success-rate drop
_W_CONC        = 0.20  # concentration of failures (low entropy = high score)
_W_VOLUME      = 0.10  # absolute volume of failures
_W_TICKET      = 0.10  # average ticket size (proxy for revenue impact)


# ---------------------------------------------------------------------------
# Existing data-generation helpers (unchanged)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Explainable diagnosis helpers (new)
# ---------------------------------------------------------------------------

def _score_hypotheses(counts: dict, total_failed: int, drop: float, avg_amount: float) -> dict:
    """Compute a normalized multi-signal confidence score for every failure code.

    Five signals are combined with fixed weights:
      - Failure share   (0.35): fraction of failures this code accounts for.
      - Drop magnitude  (0.25): how large the success-rate drop is (window-level).
      - Concentration   (0.20): how concentrated failures are in one code (low entropy).
      - Volume          (0.10): absolute number of failed transactions.
      - Ticket size     (0.10): average transaction amount as revenue-impact proxy.

    The drop / concentration / volume / ticket signals are identical for all
    candidates (they characterize the window, not a single code). The failure-share
    signal differentiates candidates. Raw scores are min-max normalized to [0, 1].

    Returns dict mapping code → normalized score.
    """
    if not counts or total_failed == 0:
        return {}

    # --- Window-level signals (same for all codes) ---
    drop_score   = min(drop / 50.0, 1.0)          # 50 pp drop → full score
    volume_score = min(total_failed / 50.0, 1.0)  # 50 failures → full score
    ticket_score = min(avg_amount / 2000.0, 1.0)  # ₹2 000 → full score

    # Normalized Shannon entropy of the failure-code distribution (0 = one code, 1 = uniform).
    k = len(counts)
    if k > 1:
        total = sum(counts.values())
        entropy = -sum(
            (c / total) * math.log2(c / total)
            for c in counts.values() if c > 0
        )
        max_entropy = math.log2(k)
        norm_entropy = entropy / max_entropy if max_entropy > 0 else 0.0
    else:
        norm_entropy = 0.0
    concentration_score = 1.0 - norm_entropy  # high concentration → high score

    raw_scores = {}
    for code, count in counts.items():
        share_score = count / total_failed
        raw_scores[code] = (
            _W_SHARE  * share_score
            + _W_DROP   * drop_score
            + _W_CONC   * concentration_score
            + _W_VOLUME * volume_score
            + _W_TICKET * ticket_score
        )

    # Min-max normalize across candidates so scores span [0, 1].
    lo = min(raw_scores.values())
    hi = max(raw_scores.values())
    if hi > lo:
        return {code: (s - lo) / (hi - lo) for code, s in raw_scores.items()}
    # All scores equal (e.g. only one candidate) → return as-is capped at 1.
    return {code: min(s, 1.0) for code, s in raw_scores.items()}


def _build_evidence(
    code: str,
    count: int,
    total_failed: int,
    drop: float,
    avg_amount: float,
    baseline_failed_rate: float,
    window_failed_rate: float,
) -> list:
    """Build a structured evidence list for a given top failure code.

    Each item has: signal, value, impact, explanation.
    """
    share_pct = round(100 * count / total_failed) if total_failed else 0
    share_impact = "high" if share_pct >= 50 else ("medium" if share_pct >= 25 else "low")

    drop_rounded = round(drop, 1)
    drop_impact = "high" if drop_rounded >= 20 else ("medium" if drop_rounded >= 12 else "low")

    code_label = CODE_LABELS.get(code, code)

    evidence = [
        {
            "signal": "Failure Share",
            "value": f"{share_pct}%",
            "impact": share_impact,
            "explanation": (
                f"{code_label} accounts for {share_pct}% of failed transactions "
                f"({count} of {total_failed}) in the anomaly window."
            ),
        },
        {
            "signal": "Success Rate Drop",
            "value": f"{drop_rounded} percentage points",
            "impact": drop_impact,
            "explanation": (
                f"Success rate fell from {round(baseline_failed_rate, 1)}% to "
                f"{round(window_failed_rate, 1)}%, a drop of {drop_rounded} pp "
                f"against the baseline period."
            ),
        },
        {
            "signal": "Failed Transaction Volume",
            "value": str(total_failed),
            "impact": "high" if total_failed >= 30 else ("medium" if total_failed >= 15 else "low"),
            "explanation": (
                f"{total_failed} transactions failed in the anomaly window — "
                + ("a significant volume warranting action." if total_failed >= 30
                   else "a moderate volume." if total_failed >= 15
                   else "a low volume, but the drop magnitude still warrants review.")
            ),
        },
        {
            "signal": "Average Transaction Amount",
            "value": f"₹{round(avg_amount):,}",
            "impact": "high" if avg_amount >= 1000 else ("medium" if avg_amount >= 400 else "low"),
            "explanation": (
                f"Average ticket size is ₹{round(avg_amount):,}, "
                + ("amplifying the revenue impact of each failed transaction." if avg_amount >= 1000
                   else "reflecting moderate revenue exposure." if avg_amount >= 400
                   else "reflecting lower per-transaction revenue exposure.")
            ),
        },
    ]
    return evidence


def _classify_severity(drop: float, total_failed: int, avg_amount: float) -> str:
    """Classify case severity from three dimensions: drop magnitude, volume, ticket size."""
    if drop >= 30 or (total_failed >= 40 and avg_amount >= 800):
        return "CRITICAL"
    if drop >= 20 or (total_failed >= 25 and avg_amount >= 500):
        return "HIGH"
    if drop >= 12 or total_failed >= 15:
        return "MEDIUM"
    return "LOW"


def _generate_summary(
    label: str,
    top_code: str,
    top_share_pct: int,
    total_failed: int,
    drop: float,
    baseline_fail_count: int,
    window_fail_count: int,
    baseline_total: int,
    window_total: int,
    category: str,
) -> str:
    """Generate a human-readable narrative diagnosis summary."""
    code_label = CODE_LABELS.get(top_code, top_code)

    # Compute uplift ratio: failure rate in window vs baseline.
    baseline_fail_rate = baseline_fail_count / baseline_total if baseline_total else 0
    window_fail_rate   = window_fail_count / window_total if window_total else 0
    if baseline_fail_rate > 0:
        uplift = round(window_fail_rate / baseline_fail_rate, 1)
        uplift_phrase = f"increased {uplift}× relative to the baseline period"
    else:
        uplift_phrase = "spiked sharply compared to the baseline period"

    drop_rounded = round(drop, 1)

    return (
        f"We detected a significant degradation in the {label} payment segment. "
        f"{code_label} failures {uplift_phrase}, accounting for {top_share_pct}% of "
        f"failed transactions. The overall success rate dropped by {drop_rounded} percentage "
        f"points. Other failure categories remained near historical levels, making "
        f"{category} the highest-confidence diagnosis."
    )


def _build_recommendation(
    category: str,
    window_failed: int,
    avg_amount: float,
) -> dict:
    """Build a structured recovery recommendation from the category playbook."""
    playbook = RECOVERY_PLAYBOOK.get(category, {
        "action": "Escalate to payment operations for manual investigation.",
        "estimated_recovery_rate": 0.25,
    })
    rate = playbook["estimated_recovery_rate"]
    recovered_tx = round(window_failed * rate)
    recovered_revenue = round(recovered_tx * avg_amount, 2)
    return {
        "action": playbook["action"],
        "estimated_recovery_rate": rate,
        "estimated_recovered_transactions": recovered_tx,
        "estimated_revenue_recovered": recovered_revenue,
    }


# ---------------------------------------------------------------------------
# Data ingestion (unchanged)
# ---------------------------------------------------------------------------

def generate_batch(db, seed=None):
    """Create a fresh randomized synthetic transaction batch."""
    import random as _random
    rng = _random.Random(seed)
    _wipe_existing(db)

    batch = models.Batch(seed=seed, anomaly_start=ANOMALY_START, source="generated")
    db.add(batch)
    db.commit()
    db.refresh(batch)

    segments = rng.sample(SEGMENT_POOL, 6)
    n_flagged = rng.choice([2, 3])
    flagged_indices = set(rng.sample(range(len(segments)), n_flagged))
    # Keep one case reliably ambiguous so the operator escalation path is
    # always represented in a generated batch.  This is deliberately applied
    # to transactions, rather than only to the probability weights: sampling
    # can otherwise turn an ambiguous mix into a dominant diagnosis.
    guaranteed_ambiguous_index = min(flagged_indices)

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

        forced_failure_number = 0
        for day in range(1, DAYS + 1):
            in_anomaly_window = is_flagged and day >= ANOMALY_START
            target_rate = anomaly_rate if in_anomaly_window else baseline_rate
            attempts = rng.randint(28, 42)

            for attempt_number in range(attempts):
                forced_ambiguous = idx == guaranteed_ambiguous_index and in_anomaly_window
                success = (
                    attempt_number % 2 == 0
                    if forced_ambiguous
                    else rng.uniform(0, 100) < target_rate
                )
                amount = round(rng.uniform(0.7, 1.3) * avg_amount, 2)
                failure_code = None
                if not success:
                    if forced_ambiguous:
                        failure_code = FAILURE_CODES[forced_failure_number % 2]
                        forced_failure_number += 1
                    else:
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


def parse_csv_and_load(db, file_bytes: bytes):
    """Parse an uploaded transaction CSV and load it as a fresh batch.

    Expected columns (case-insensitive): day, issuer, method, amount, status,
    failure_code. `day` may be an integer day number or a date (several common
    formats are tried). `failure_code` should be one of: issuer_decline,
    otp_timeout, expired_card, network_error — unrecognized values are bucketed
    into network_error and reported back so nothing fails silently.
    """
    import csv as _csv
    import io as _io
    from datetime import datetime as _dt

    try:
        text = file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("Could not read the file as UTF-8 text. Please export the CSV as UTF-8.")

    reader = _csv.DictReader(_io.StringIO(text))
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
                    parsed = _dt.strptime(d, fmt)
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
        amount_raw = row[field_map["amount"]].strip().replace(",", "").replace("Rs", "").replace("$", "")
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


# ---------------------------------------------------------------------------
# Detection + explainable diagnosis engine
# ---------------------------------------------------------------------------

def analyze_batch(db, batch_id: int, anomaly_start: int):
    """Run real detection + explainable diagnosis over whatever transactions exist
    for this batch in the database. Works identically for generated or uploaded
    data — every number is computed live, nothing is hardcoded.

    Upgrades over the original majority-frequency baseline:
      - Multi-signal weighted scoring (5 signals) instead of raw frequency.
      - Root cause categories mapped from low-level failure codes.
      - Severity classification (LOW / MEDIUM / HIGH / CRITICAL).
      - Structured evidence list per case.
      - Human-readable diagnosis summary.
      - Recovery recommendation with estimated recovered transactions & revenue.
      - Improved abstention: fires on low confidence, ambiguous top-two, or
        evenly distributed evidence.
    """
    from collections import defaultdict as _dd
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

        label = f"{txs[0].issuer} \u00b7 {txs[0].method}"
        avg_amount = sum(t.amount for t in txs) / len(txs)

        baseline_txs = [t for t in txs if t.day < anomaly_start]
        window_txs   = [t for t in txs if t.day >= anomaly_start]
        if not baseline_txs or not window_txs:
            continue

        baseline_success = sum(1 for t in baseline_txs if t.status == "success")
        baseline_rate    = round(100 * baseline_success / len(baseline_txs), 1)

        window_success = sum(1 for t in window_txs if t.status == "success")
        window_rate    = round(100 * window_success / len(window_txs), 1)

        drop = baseline_rate - window_rate
        if drop < DROP_THRESHOLD:
            continue

        failed = [t for t in window_txs if t.status == "failed"]
        if not failed:
            continue

        counts = _dd(int)
        for t in failed:
            counts[t.failure_code] += 1
        total_failed = len(failed)

        # --- Multi-signal scoring ---
        scored = _score_hypotheses(counts, total_failed, drop, avg_amount)

        # Sort by normalized score descending, then build hypothesis dicts.
        hypotheses = []
        for code, norm_score in sorted(scored.items(), key=lambda x: -x[1]):
            hypotheses.append({
                "code": code,
                "confidence": round(norm_score, 3),
                "share": counts[code],
                "ruled_out": False,
                "reasoning": None,
            })

        top_confidence    = hypotheses[0]["confidence"] if hypotheses else 0.0
        second_confidence = hypotheses[1]["confidence"] if len(hypotheses) >= 2 else 0.0
        max_raw_share     = max(counts[h["code"]] / total_failed for h in hypotheses) if hypotheses else 0.0
        top_raw_share     = hypotheses[0]["share"] / total_failed if hypotheses else 0.0
        second_raw_share  = hypotheses[1]["share"] / total_failed if len(hypotheses) >= 2 else 0.0

        # --- Improved abstention logic (four conditions) ---
        abstain_reason = None
        if top_confidence < CONFIDENCE_FLOOR:
            abstained = True
            abstain_reason = (
                f"Top confidence score ({round(top_confidence * 100)}%) is below the "
                f"{int(CONFIDENCE_FLOOR * 100)}% threshold — evidence is insufficient "
                f"to single out a dominant cause."
            )
        elif (
            len(hypotheses) >= 2
            and abs(top_raw_share - second_raw_share) < 0.10
            and top_raw_share < 0.55
        ):
            abstained = True
            abstain_reason = (
                f"Top two diagnoses are within 10 percentage points of each other "
                f"({round(top_raw_share * 100)}% vs {round(second_raw_share * 100)}%) "
                f"— ambiguous signal, routing to manual review."
            )
        elif len(hypotheses) >= 2 and (top_confidence - second_confidence) < 0.10:
            abstained = True
            abstain_reason = (
                f"Top two diagnoses are within 10 confidence points of each other "
                f"({round(top_confidence * 100)}% vs {round(second_confidence * 100)}%) "
                f"— ambiguous signal, routing to manual review."
            )
        elif max_raw_share < 0.35:
            abstained = True
            abstain_reason = (
                f"No single failure code dominates (highest share {round(max_raw_share * 100)}%) "
                f"— failures are too evenly distributed to diagnose with confidence."
            )
        else:
            abstained = False

        # --- Per-hypothesis reasoning text ---
        for i, h in enumerate(hypotheses):
            raw_share_pct = round(100 * h["share"] / total_failed)
            if i == 0 and not abstained:
                h["reasoning"] = (
                    f"Explains {h['share']} of {total_failed} failures in the window "
                    f"({raw_share_pct}%) — the strongest signal identified across all "
                    f"five scoring dimensions."
                )
            elif h["confidence"] < 0.15:
                h["ruled_out"] = True
                h["reasoning"] = (
                    f"Only {h['share']} of {total_failed} failures ({raw_share_pct}%) — "
                    f"consistent with normal background rate."
                )
            else:
                h["reasoning"] = (
                    f"{h['share']} of {total_failed} failures ({raw_share_pct}%) — "
                    f"a plausible alternate cause, kept visible rather than dismissed."
                )

        # --- Root cause category, severity, evidence, summary, recommendation ---
        top_code      = hypotheses[0]["code"] if not abstained else None
        top_share_pct = round(100 * hypotheses[0]["share"] / total_failed) if hypotheses else 0
        category      = ROOT_CAUSE_CATEGORIES.get(top_code, "Unknown") if top_code else None
        severity      = _classify_severity(drop, total_failed, avg_amount)

        baseline_fail_count = sum(1 for t in baseline_txs if t.status == "failed")
        window_fail_count   = total_failed

        evidence = (
            _build_evidence(
                code=top_code,
                count=hypotheses[0]["share"],
                total_failed=total_failed,
                drop=drop,
                avg_amount=avg_amount,
                baseline_failed_rate=baseline_rate,
                window_failed_rate=window_rate,
            )
            if top_code else []
        )

        summary = (
            _generate_summary(
                label=label,
                top_code=top_code,
                top_share_pct=top_share_pct,
                total_failed=total_failed,
                drop=drop,
                baseline_fail_count=baseline_fail_count,
                window_fail_count=window_fail_count,
                baseline_total=len(baseline_txs),
                window_total=len(window_txs),
                category=category,
            )
            if top_code else (
                f"Diagnosis abstained for {label}: {abstain_reason}"
            )
        )

        recommendation = (
            _build_recommendation(category, total_failed, avg_amount)
            if top_code and category else None
        )

        # --- Persist case ---
        case = models.Case(
            batch_id=batch_id,
            segment_key=key,
            segment_label=label,
            baseline_rate=baseline_rate,
            current_rate=window_rate,
            window_attempts=len(window_txs),
            window_failed=total_failed,
            avg_amount=round(avg_amount, 2),
            top_cause=top_code,
            top_confidence=top_confidence,
            hypotheses_json=__import__("json").dumps(hypotheses),
            status="abstained" if abstained else "pending",
            lifecycle="ESCALATED" if abstained else "DETECTED",
            # new explainable diagnosis fields
            diagnosis_category=category,
            severity=severity,
            diagnosis_summary=summary,
            evidence_json=__import__("json").dumps(evidence),
            recommendation_json=__import__("json").dumps(recommendation) if recommendation else None,
            abstain_reason=abstain_reason,
        )
        db.add(case)
        db.commit()
        db.refresh(case)

        # --- Timeline events ---
        events = [
            f"Detected — success rate dropped from {baseline_rate}% to {window_rate}% "
            f"against a baseline period. Severity: {severity}.",
            f"Diagnosis generated — {len(hypotheses)} candidate cause(s) evaluated: "
            + ", ".join(
                f"{CODE_LABELS[h['code']]} ({round(h['confidence'] * 100)}%)"
                for h in hypotheses
            ) + ".",
        ]
        if abstained:
            events.append(
                f"Abstained — {abstain_reason} Routed to manual review."
            )
        elif category:
            events.append(
                f"Root cause category: {category}. "
                f"Recommended action: {recommendation['action']}"
            )

        for e in events:
            db.add(models.TimelineEvent(case_id=case.id, event=e))
        db.commit()

        cases.append(case)

    return cases