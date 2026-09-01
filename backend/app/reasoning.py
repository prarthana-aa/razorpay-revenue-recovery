from typing import Dict, Any, List

def generate_reasoning(case: Any, evidence_list: List[Dict[str, Any]], primary_diagnosis_code: str) -> Dict[str, Any]:
    """
    Generate structured reasoning from diagnosis output, avoiding LLMs.
    Returns:
    - summary
    - evidence_strength
    - evidence_count
    - evidence_percentage
    - blast_radius
    - recency
    - merchant_segment
    - explanation
    """
    
    # Calculate evidence strength based on number of evidence items and case confidence
    evidence_count = len(evidence_list)
    confidence = case.top_confidence or 0.0
    
    if confidence >= 0.8:
        evidence_strength = "HIGH"
    elif confidence >= 0.5:
        evidence_strength = "MEDIUM"
    else:
        evidence_strength = "LOW"
        
    evidence_percentage = round(confidence * 100)
    
    blast_radius = f"{case.window_failed} transactions affected"
    recency = "Recent window"
    merchant_segment = case.segment_label

    explanation = f"Diagnosis points to {primary_diagnosis_code} with {evidence_percentage}% confidence, supported by {evidence_count} evidence signals."

    summary = f"Detected anomaly in segment {merchant_segment}. Primary driver is {primary_diagnosis_code}."

    return {
        "summary": summary,
        "evidence_strength": evidence_strength,
        "evidence_count": evidence_count,
        "evidence_percentage": evidence_percentage,
        "blast_radius": blast_radius,
        "recency": recency,
        "merchant_segment": merchant_segment,
        "explanation": explanation
    }
