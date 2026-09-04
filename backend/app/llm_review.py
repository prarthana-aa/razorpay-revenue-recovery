"""
LLM second opinion for abstained cases.

Scope, deliberately narrow:
- Only ever called for cases where the rule-based engine (generator.py) has
  already abstained. It never runs on, and never influences, a case that the
  deterministic pipeline is confident enough to act on.
- It NEVER touches money math, recovery rates, or the approval/execution
  path. It only returns a narrative opinion + a suggested next step for a
  human to read. There is no code path from this module back into
  /approve or /reject.
- If the API key is missing, the request times out, or the response doesn't
  parse, we fail closed: return an "unavailable" result and let the case sit
  in manual review exactly as it would have without this feature. We never
  block or crash the case pipeline because an LLM call failed.

Uses Groq's free tier (no credit card required):
https://console.groq.com  ->  API Keys -> Create API Key  ->  set GROQ_API_KEY.
"""

import json
import os
from typing import Any, Dict, List, Optional

import requests

try:
    from dotenv import load_dotenv
    # Looks for backend/.env regardless of where uvicorn is launched from.
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except ImportError:
    pass  # python-dotenv not installed — GROQ_API_KEY must be set another way

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
REQUEST_TIMEOUT_SECONDS = 12

_VALID_CAUSES = {"issuer_decline", "otp_timeout", "expired_card", "network_error", "none"}
_REQUIRED_KEYS = (
    "agrees_with_abstention",
    "likely_cause",
    "confidence_percent",
    "reasoning",
    "suggested_next_step",
)

# Groq's JSON mode (response_format={"type": "json_object"}) guarantees valid
# JSON syntax but, unlike Gemini's responseSchema, doesn't enforce a specific
# shape — so the exact keys/types/enum have to be spelled out in the prompt,
# and we validate the parsed result ourselves before trusting it.
_SYSTEM_PREAMBLE = (
    "You are an independent second-opinion reviewer for a payment failure "
    "diagnosis system used by a payments company. A deterministic, rule-based "
    "pipeline has already scored the candidate root causes for a segment "
    "and decided the evidence is too weak or ambiguous to act on "
    "automatically. Your job is NOT to override that system. You are giving "
    "a second, independent read of the same evidence for a human reviewer, "
    "who will make the final call. Be honest if you also can't tell — "
    "agreeing that the evidence is ambiguous is a valid and useful answer, "
    "not a failure. Never suggest an automated or irreversible action; only "
    "suggest what a human reviewer should look at or do next.\n\n"
    "Respond with ONLY a JSON object (no markdown fences, no commentary) "
    "with exactly these keys:\n"
    '  "agrees_with_abstention": boolean — true if you also think no single '
    "cause can be confidently isolated.\n"
    '  "likely_cause": string — one of "issuer_decline", "otp_timeout", '
    '"expired_card", "network_error", or "none" if the evidence is genuinely '
    "ambiguous.\n"
    '  "confidence_percent": integer 0-100 — your confidence in likely_cause. '
    'Use 0 if likely_cause is "none".\n'
    '  "reasoning": string — 2-4 sentences explaining your read of the '
    "evidence, in plain operator-facing language.\n"
    '  "suggested_next_step": string — one concrete, human-actionable next '
    "step for an ops reviewer — not an automated action."
)


def _build_prompt(case: Any, evidence_list: List[Dict[str, Any]], hypotheses: List[Dict[str, Any]]) -> str:
    hyp_lines = "\n".join(
        f"  - {h['code']}: {h['share']} of {case.window_failed} failed transactions "
        f"(rule-based confidence {round(h['confidence'] * 100)}%)"
        for h in hypotheses
    )
    evidence_lines = "\n".join(
        f"  - {e['signal']}: {e['value']} (impact: {e['impact']}) — {e['explanation']}"
        for e in evidence_list
    ) or "  (no structured evidence was generated — this itself may be a signal.)"

    return (
        f"Segment: {case.segment_label}\n"
        f"Baseline success rate: {case.baseline_rate}%\n"
        f"Current success rate: {case.current_rate}%\n"
        f"Failed transactions in window: {case.window_failed} of {case.window_attempts} attempts\n"
        f"Average transaction amount: ₹{round(case.avg_amount)}\n\n"
        f"Candidate root causes the rule-based system considered:\n{hyp_lines}\n\n"
        f"The rule-based system abstained because: {case.abstain_reason}\n\n"
        f"Structured evidence:\n{evidence_lines}\n\n"
        f"Give your independent read of this evidence."
    )


def is_configured() -> bool:
    return bool(GROQ_API_KEY)


def get_second_opinion(
    case: Any, evidence_list: List[Dict[str, Any]], hypotheses: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Call Groq for an independent opinion on an abstained case.

    Always returns a dict — never raises. On any failure (missing key,
    network error, timeout, bad response) it returns a dict with
    "available": False and a human-readable "error" field, so the caller
    can display "AI second opinion unavailable" instead of crashing the
    request.
    """
    if not GROQ_API_KEY:
        return {
            "available": False,
            "error": "GROQ_API_KEY is not set on the backend. "
                     "Get a free key at https://console.groq.com and set it as an env var.",
        }

    prompt = _build_prompt(case, evidence_list, hypotheses)

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM_PREAMBLE},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }

    try:
        resp = requests.post(
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        return {"available": False, "error": f"Request to Groq failed: {e}"}

    if resp.status_code != 200:
        return {
            "available": False,
            "error": f"Groq API returned HTTP {resp.status_code}: {resp.text[:300]}",
        }

    try:
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        parsed = json.loads(text)
    except (KeyError, IndexError, ValueError) as e:
        return {"available": False, "error": f"Could not parse Groq response: {e}"}

    missing = [k for k in _REQUIRED_KEYS if k not in parsed]
    if missing:
        return {"available": False, "error": f"Groq response missing keys: {missing}"}

    if parsed["likely_cause"] not in _VALID_CAUSES:
        return {
            "available": False,
            "error": f"Groq returned an unrecognized likely_cause: {parsed['likely_cause']!r}",
        }

    try:
        parsed["confidence_percent"] = max(0, min(100, int(parsed["confidence_percent"])))
    except (TypeError, ValueError):
        return {"available": False, "error": "Groq returned a non-numeric confidence_percent"}

    parsed["agrees_with_abstention"] = bool(parsed["agrees_with_abstention"])
    parsed["available"] = True
    parsed["model"] = GROQ_MODEL
    return parsed