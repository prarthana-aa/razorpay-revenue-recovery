from typing import Dict, Any, Optional

# The strict recovery policy mapping diagnoses to allowed recovery actions.
# Every automatic action must expose approval mode, retry limit, and reversible flag.
# Unknown diagnoses will return a default policy requiring manual approval.

# Mapping low-level failure codes to policy configurations.
_POLICY_TABLE = {
    "otp_timeout": {
        "action": "OTP_RESEND",
        "approval": "AUTO",
        "retry_limit": 1,
        "cooldown_minutes": 5,
        "reversible": True
    },
    "network_error": {
        "action": "PAYMENT_RETRY",
        "approval": "AUTO",
        "retry_limit": 1,
        "reversible": True
    },
    "expired_card": {
        "action": "PROMPT_ALTERNATE_PAYMENT",
        "approval": "OPTIONAL"
    },
    "issuer_decline": {
        "action": "ESCALATE_INVESTIGATION",
        "approval": "REQUIRED"
    }
}

# Default policy for unknown or unhandled diagnoses.
_DEFAULT_POLICY = {
    "action": "ESCALATE_INVESTIGATION",
    "approval": "REQUIRED"
}

def get_policy_for_diagnosis(failure_code: str) -> Dict[str, Any]:
    """
    Returns the bounded recovery policy for a given failure code.
    If the failure code is unknown, returns the default policy which requires manual approval.
    """
    return _POLICY_TABLE.get(failure_code, _DEFAULT_POLICY)
