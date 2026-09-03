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

Uses Google Gemini's free tier (no credit card required):
https://aistudio.google.com  ->  create an API key  ->  set GEMINI_API_KEY.
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
    pass  # python-dotenv not installed — GEMINI_API_KEY must be set another way

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
REQUEST_TIMEOUT_SECONDS = 12

# Structured output schema — Gemini will be constrained to return exactly
# this shape, so we never have to hope the model formats JSON correctly.
_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "agrees_with_abstention": {
            "type": "BOOLEAN",
            "description": "True if you also think no single cause can be confidently isolated.",
        },
        "likely_cause": {
            "type": "STRING",
            "description": "Your best-guess root cause code, or 'none' if you agree the evidence is genuinely ambiguous.",
            "enum": ["issuer_decline", "otp_timeout", "expired_card", "network_error", "none"],
        },
        "confidence_percent": {
            "type": "INTEGER",
            "description": "Your confidence in likely_cause, 0-100. Use 0 if likely_cause is 'none'.",
        },
        "reasoning": {
            "type": "STRING",
            "description": "2-4 sentences explaining your read of the evidence, in plain operator-facing language.",
        },
        "suggested_next_step": {
            "type": "STRING",
            "description": "One concrete, human-actionable next step for an ops reviewer — not an automated action.",
        },
    },
    "required": [
        "agrees_with_abstention",
        "likely_cause",
        "confidence_percent",
        "reasoning",
        "suggested_next_step",
    ],
}

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
    "suggest what a human reviewer should look at or do next."
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
    return bool(GEMINI_API_KEY)


def get_second_opinion(
    case: Any, evidence_list: List[Dict[str, Any]], hypotheses: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Call Gemini for an independent opinion on an abstained case.

    Always returns a dict — never raises. On any failure (missing key,
    network error, timeout, bad response) it returns a dict with
    "available": False and a human-readable "error" field, so the caller
    can display "AI second opinion unavailable" instead of crashing the
    request.
    """
    if not GEMINI_API_KEY:
        return {
            "available": False,
            "error": "GEMINI_API_KEY is not set on the backend. "
                     "Get a free key at https://aistudio.google.com and set it as an env var.",
        }

    prompt = _build_prompt(case, evidence_list, hypotheses)

    payload = {
        "system_instruction": {"parts": [{"text": _SYSTEM_PREAMBLE}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _RESPONSE_SCHEMA,
            "temperature": 0.2,
        },
    }

    try:
        resp = requests.post(
            GEMINI_URL,
            params={"key": GEMINI_API_KEY},
            json=payload,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        return {"available": False, "error": f"Request to Gemini failed: {e}"}

    if resp.status_code != 200:
        return {
            "available": False,
            "error": f"Gemini API returned HTTP {resp.status_code}: {resp.text[:300]}",
        }

    try:
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
    except (KeyError, IndexError, ValueError) as e:
        return {"available": False, "error": f"Could not parse Gemini response: {e}"}

    parsed["available"] = True
    parsed["model"] = GEMINI_MODEL
    return parsed
