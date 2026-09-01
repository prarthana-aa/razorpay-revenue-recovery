import json
from typing import Dict, Any, List

from .recovery_policy import get_policy_for_diagnosis
from .reasoning import generate_reasoning
from .generator import ACTIONS, RECOVERY_PLAYBOOK

def get_recovery_rate(failure_code: str, category: str) -> float:
    # Attempt to derive rate from the playbook or actions mapping based on diagnosis.
    if failure_code in ACTIONS:
        return ACTIONS[failure_code]["effectiveness"]
    
    playbook = RECOVERY_PLAYBOOK.get(category)
    if playbook:
        return playbook["estimated_recovery_rate"]
    
    # Default conservative recovery rate
    return 0.25

def run_agent(case: Any) -> Dict[str, Any]:
    """
    Orchestrator that consumes a case (with diagnosis and evidence) and
    returns the structured agent evaluation.
    """
    hypotheses = []
    if case.hypotheses_json:
        hypotheses = json.loads(case.hypotheses_json)
        
    evidence_list = []
    if case.evidence_json:
        evidence_list = json.loads(case.evidence_json)
        
    primary_diagnosis_code = hypotheses[0]["code"] if hypotheses else "unknown"
    confidence = case.top_confidence or 0.0
    
    # Evaluate policy
    policy = get_policy_for_diagnosis(primary_diagnosis_code)
    
    # Generate structured reasoning
    reasoning = generate_reasoning(case, evidence_list, primary_diagnosis_code)
    
    # Compute revenue projection
    at_risk = case.window_failed * case.avg_amount if case.window_failed and case.avg_amount else 0
    expected_recovery_rate = get_recovery_rate(primary_diagnosis_code, case.diagnosis_category or "")
    recoverable = at_risk * expected_recovery_rate
    
    revenue_projection = {
        "at_risk": at_risk,
        "recoverable": recoverable,
        "expected_recovery_rate": expected_recovery_rate
    }
    
    agent_status = "READY"
    if policy.get("approval") == "REQUIRED":
        agent_status = "AWAITING_APPROVAL"
        
    recommended_action = policy
    
    return {
        "agent_status": agent_status,
        "primary_diagnosis": primary_diagnosis_code,
        "confidence": confidence,
        "reasoning": reasoning,
        "recommended_action": recommended_action,
        "revenue_projection": revenue_projection
    }
