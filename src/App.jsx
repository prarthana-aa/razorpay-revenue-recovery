import React, { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  ShieldAlert, TrendingDown, CheckCircle2, XCircle, AlertTriangle,
  RotateCcw, ChevronRight, Activity, FileClock, IndianRupee, Circle
} from "lucide-react";

/* ---------------------------------------------------------------- */
/* Design tokens (ledger / ops-console identity, no default clichés) */
/* ---------------------------------------------------------------- */
const C = {
  bg: "#0A0F1C",
  surface: "#111827",
  surface2: "#161F33",
  border: "#26314A",
  borderSoft: "#1D2740",
  text: "#E7ECF5",
  textMuted: "#8592AD",
  textFaint: "#5C6884",
  green: "#46D6A0",
  amber: "#F0B559",
  red: "#F0637C",
  blue: "#6FA8F5",
};

const fontMono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const fontSans = "ui-sans-serif, system-ui, -apple-system, sans-serif";

/* ---------------------------------------------------------------- */
/* Deterministic RNG so the demo looks the same every run            */
/* ---------------------------------------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260822);
const jitter = (spread) => (rng() - 0.5) * 2 * spread;

/* ---------------------------------------------------------------- */
/* Segment definitions + hand-authored anomaly windows               */
/* ---------------------------------------------------------------- */
const DAYS = 21;
const ANOMALY_START = 15; // day index (1-based) where recent window begins

const SEGMENTS = [
  { key: "sbi_upi", label: "SBI · UPI", baseline: 94, flagged: false },
  { key: "visa_card", label: "Visa · Card", baseline: 91, flagged: false },
  { key: "paytm_wallet", label: "Paytm Wallet", baseline: 93, flagged: false },
  { key: "hdfc_upi", label: "HDFC · UPI", baseline: 93, flagged: true, anomalyRate: 54 },
  { key: "icici_card", label: "ICICI · Card", baseline: 90, flagged: true, anomalyRate: 59 },
  { key: "airtel_wallet", label: "Airtel Wallet", baseline: 92, flagged: true, anomalyRate: 66 },
];

function buildSeries() {
  const rows = [];
  for (let d = 1; d <= DAYS; d++) {
    const row = { day: `D${d}` };
    SEGMENTS.forEach((s) => {
      const inAnomaly = s.flagged && d >= ANOMALY_START;
      const target = inAnomaly ? s.anomalyRate : s.baseline;
      const spread = inAnomaly ? 3 : 2;
      row[s.key] = Math.max(0, Math.min(100, Math.round(target + jitter(spread))));
    });
    rows.push(row);
  }
  return rows;
}
const CHART_DATA = buildSeries();

const ACTIONS = {
  issuer_decline: { label: "Reroute retry via alternate acquiring bank", effectiveness: 0.65 },
  otp_timeout: { label: "Trigger OTP resend with extended validity window", effectiveness: 0.55 },
  expired_card: { label: "Prompt customer to update card / switch method", effectiveness: 0.35 },
  network_error: { label: "Flag transaction for gateway health review", effectiveness: 0.20 },
};

const CODE_LABEL = {
  issuer_decline: "Issuer decline cluster",
  otp_timeout: "OTP delivery timeout",
  expired_card: "Expired / invalid card",
  network_error: "Gateway / network error",
};

/* ---------------------------------------------------------------- */
/* Hand-authored case data — the three demo narratives                */
/* ---------------------------------------------------------------- */
const INITIAL_CASES = [
  {
    id: "CASE-1102",
    segment: "HDFC · UPI",
    avgAmount: 450,
    windowAttempts: 280,
    windowFailed: 129,
    baselineRate: 93,
    currentRate: 54,
    hypotheses: [
      {
        code: "issuer_decline", confidence: 0.80, share: 103, ruledOut: false,
        reasoning: "Explains 103 of 129 failures in the window — dominant and time-correlated with a known issuer-side gateway pattern."
      },
      {
        code: "otp_timeout", confidence: 0.10, share: 13, ruledOut: true,
        reasoning: "Only 13 of 129 failures — no correlation with OTP delivery delay windows."
      },
      {
        code: "expired_card", confidence: 0.06, share: 8, ruledOut: true,
        reasoning: "Too small a share, consistent with normal background rate."
      },
    ],
    status: "pending", // pending | approved | rejected | abstained | escalated-reviewed
    outcome: null,
    reverted: false,
    timeline: [],
  },
  {
    id: "CASE-1103",
    segment: "ICICI · Card",
    avgAmount: 1200,
    windowAttempts: 245,
    windowFailed: 101,
    baselineRate: 90,
    currentRate: 59,
    hypotheses: [
      {
        code: "otp_timeout", confidence: 0.475, share: 48, ruledOut: false,
        reasoning: "Narrow lead over the runner-up — 48 of 101 failures, chosen as primary but flagged as a close call."
      },
      {
        code: "expired_card", confidence: 0.376, share: 38, ruledOut: false,
        reasoning: "38 of 101 failures — plausible alternate cause, not ruled out, kept visible for the operator."
      },
      {
        code: "issuer_decline", confidence: 0.099, share: 10, ruledOut: true,
        reasoning: "Minor share, within normal background variance."
      },
      {
        code: "network_error", confidence: 0.050, share: 5, ruledOut: true,
        reasoning: "Negligible share."
      },
    ],
    status: "pending",
    outcome: null,
    reverted: false,
    timeline: [],
  },
  {
    id: "CASE-1104",
    segment: "Airtel Wallet",
    avgAmount: 300,
    windowAttempts: 210,
    windowFailed: 71,
    baselineRate: 92,
    currentRate: 66,
    hypotheses: [
      {
        code: "issuer_decline", confidence: 0.296, share: 21, ruledOut: false,
        reasoning: "Highest share, but well below the 45% confidence floor for automated action."
      },
      {
        code: "otp_timeout", confidence: 0.254, share: 18, ruledOut: false,
        reasoning: "Nearly tied with two other causes — no dominant signal."
      },
      {
        code: "expired_card", confidence: 0.254, share: 18, ruledOut: false,
        reasoning: "Nearly tied — evidence is genuinely split across causes."
      },
      {
        code: "network_error", confidence: 0.197, share: 14, ruledOut: false,
        reasoning: "Present in meaningful volume; can't be dismissed."
      },
    ],
    status: "abstained",
    outcome: null,
    reverted: false,
    timeline: [
      { ts: "Day 15, 06:00", event: "Detected — success rate dropped from 92% to 66% (14-day baseline)." },
      { ts: "Day 15, 06:01", event: "Diagnosis generated — 4 candidate causes evaluated, none clears the 45% confidence floor." },
      { ts: "Day 15, 06:01", event: "Abstained — routed to manual review. No automated recovery action taken." },
    ],
  },
];

const CONFIDENCE_FLOOR = 0.45;

/* ---------------------------------------------------------------- */
/* Small UI atoms                                                    */
/* ---------------------------------------------------------------- */
function Badge({ status }) {
  const map = {
    pending: { color: C.blue, label: "PENDING" },
    approved: { color: C.green, label: "RECOVERED" },
    rejected: { color: C.red, label: "REJECTED" },
    abstained: { color: C.amber, label: "ESCALATED" },
    "escalated-reviewed": { color: C.textMuted, label: "MANUALLY REVIEWED" },
  };
  const m = map[status] || map.pending;
  return (
    <span
      style={{
        fontFamily: fontMono, fontSize: 11, letterSpacing: "0.08em",
        color: m.color, border: `1px solid ${m.color}`, borderRadius: 3,
        padding: "2px 7px", whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}

function Stamp({ status }) {
  const map = {
    approved: { color: C.green, label: "RECOVERED" },
    rejected: { color: C.red, label: "REJECTED" },
    abstained: { color: C.amber, label: "ESCALATED" },
    "escalated-reviewed": { color: C.textMuted, label: "REVIEWED" },
    pending: { color: C.blue, label: "PENDING" },
  };
  const m = map[status] || map.pending;
  return (
    <div
      style={{
        display: "inline-block", transform: "rotate(-6deg)",
        border: `2px solid ${m.color}`, color: m.color,
        fontFamily: fontMono, fontWeight: 700, fontSize: 12,
        letterSpacing: "0.18em", padding: "4px 10px", borderRadius: 4,
        opacity: 0.9,
      }}
    >
      {m.label}
    </div>
  );
}

function ConfidenceBar({ value, ruledOut, color }) {
  return (
    <div style={{ background: C.surface2, borderRadius: 3, height: 6, width: "100%", overflow: "hidden" }}>
      <div
        style={{
          width: `${Math.round(value * 100)}%`, height: "100%",
          background: ruledOut ? C.textFaint : color, opacity: ruledOut ? 0.5 : 1,
        }}
      />
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "16px 18px", flex: 1, minWidth: 180 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textMuted, fontSize: 12, fontFamily: fontSans, marginBottom: 8 }}>
        <Icon size={14} color={color} />
        <span style={{ letterSpacing: "0.04em" }}>{label}</span>
      </div>
      <div style={{ fontFamily: fontMono, fontSize: 24, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontFamily: fontSans, fontSize: 12, color: C.textFaint, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent", border: "none", cursor: "pointer",
        color: active ? C.text : C.textMuted, fontFamily: fontSans,
        fontSize: 13, fontWeight: active ? 600 : 500, padding: "10px 4px",
        borderBottom: active ? `2px solid ${C.blue}` : "2px solid transparent",
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* Main component                                                     */
/* ---------------------------------------------------------------- */
export default function PaymentRecoveryConsole() {
  const [tab, setTab] = useState("overview");
  const [cases, setCases] = useState(INITIAL_CASES);
  const [selectedId, setSelectedId] = useState(INITIAL_CASES[0].id);

  const selected = cases.find((c) => c.id === selectedId);

  const metrics = useMemo(() => {
    let recovered = 0, recoverable = 0, resolvedCount = 0, escalatedCount = 0;
    cases.forEach((c) => {
      const recoverableAmt = Math.round(c.windowFailed * c.avgAmount);
      recoverable += recoverableAmt;
      if (c.status === "approved" && c.outcome && !c.reverted) recovered += c.outcome.amount;
      if (c.status === "approved" || c.status === "rejected") resolvedCount += 1;
      if (c.status === "abstained" || c.status === "escalated-reviewed") escalatedCount += 1;
    });
    return {
      recovered, recoverable,
      resolutionRate: Math.round((resolvedCount / cases.length) * 100),
      escalationRate: Math.round((escalatedCount / cases.length) * 100),
    };
  }, [cases]);

  function stamp(id, updater) {
    setCases((prev) => prev.map((c) => (c.id === id ? updater({ ...c, timeline: [...c.timeline] }) : c)));
  }

  function approve(c) {
    const top = c.hypotheses[0];
    const action = ACTIONS[top.code];
    const recoverableAmt = Math.round(c.windowFailed * c.avgAmount);
    const amount = Math.round(recoverableAmt * action.effectiveness);
    const recoveredTx = Math.round(c.windowFailed * action.effectiveness);
    stamp(c.id, (draft) => {
      draft.status = "approved";
      draft.outcome = { amount, recoveredTx, action: action.label };
      draft.timeline.push(
        { ts: "Day 15, 06:02", event: `Operator approved action: ${action.label}.` },
        { ts: "Day 15, 06:03", event: `Outcome — ₹${amount.toLocaleString("en-IN")} recovered across ${recoveredTx} transactions (${Math.round(action.effectiveness * 100)}% of failed volume in segment).` }
      );
      return draft;
    });
  }

  function reject(c) {
    stamp(c.id, (draft) => {
      draft.status = "rejected";
      draft.timeline.push({ ts: "Day 15, 06:02", event: "Operator rejected the recommended action. No recovery attempted." });
      return draft;
    });
  }

  function revert(c) {
    stamp(c.id, (draft) => {
      draft.reverted = true;
      draft.timeline.push({ ts: "Day 15, 09:14", event: "Operator flagged the recovery as ineffective and reverted it. Amount removed from recovered total." });
      return draft;
    });
  }

  function markReviewed(c) {
    stamp(c.id, (draft) => {
      draft.status = "escalated-reviewed";
      draft.timeline.push({ ts: "Day 16, 11:00", event: "Manual review completed by ops. Outcome logged outside the automated system." });
      return draft;
    });
  }

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: fontSans, minHeight: "100%", padding: 20, borderRadius: 8 }}>
      {/* Header */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textMuted, fontSize: 11, fontFamily: fontMono, letterSpacing: "0.12em", marginBottom: 4 }}>
          <ShieldAlert size={13} color={C.blue} /> AI REVENUE RECOVERY · TRACK 03
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Payment Recovery Console</h1>
        <p style={{ fontSize: 13, color: C.textMuted, margin: "4px 0 0", maxWidth: 640 }}>
          Detects payment-success degradation, ranks competing root causes with confidence, abstains honestly when evidence is thin, and never recovers money without an operator's approval.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 22, borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabButton>
        <TabButton active={tab === "cases"} onClick={() => setTab("cases")}>Case Queue</TabButton>
        <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>Audit Trail</TabButton>
      </div>

      {tab === "overview" && (
        <div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
            <MetricCard icon={IndianRupee} label="RECOVERED" value={`₹${metrics.recovered.toLocaleString("en-IN")}`} sub={`of ₹${metrics.recoverable.toLocaleString("en-IN")} at risk`} color={C.green} />
            <MetricCard icon={CheckCircle2} label="RESOLUTION RATE" value={`${metrics.resolutionRate}%`} sub="cases with an operator decision" color={C.blue} />
            <MetricCard icon={AlertTriangle} label="HONEST ESCALATIONS" value={`${metrics.escalationRate}%`} sub="abstained rather than guessed" color={C.amber} />
            <MetricCard icon={TrendingDown} label="FLAGGED SEGMENTS" value={cases.length} sub="of 6 monitored segments" color={C.red} />
          </div>

          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "18px 18px 8px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Success rate by segment, 21-day window</div>
            <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 10, fontFamily: fontMono }}>anomaly window begins day 15</div>
            <div style={{ width: "100%", height: 280 }}>
              <ResponsiveContainer>
                <LineChart data={CHART_DATA} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={C.borderSoft} vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: C.textFaint, fontSize: 10, fontFamily: fontMono }} axisLine={{ stroke: C.border }} tickLine={false} />
                  <YAxis domain={[40, 100]} tick={{ fill: C.textFaint, fontSize: 10, fontFamily: fontMono }} axisLine={false} tickLine={false} />
                  <ReferenceLine x="D15" stroke={C.amber} strokeDasharray="3 3" />
                  <Tooltip contentStyle={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: fontMono }} labelStyle={{ color: C.textMuted }} />
                  <Legend wrapperStyle={{ fontSize: 11, fontFamily: fontSans }} />
                  <Line type="monotone" dataKey="sbi_upi" name="SBI · UPI" stroke={C.textFaint} strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="visa_card" name="Visa · Card" stroke={C.textFaint} strokeWidth={1.5} dot={false} strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="paytm_wallet" name="Paytm Wallet" stroke={C.textFaint} strokeWidth={1.5} dot={false} strokeDasharray="1 3" />
                  <Line type="monotone" dataKey="hdfc_upi" name="HDFC · UPI" stroke={C.green} strokeWidth={2.5} dot={false} />
                  <Line type="monotone" dataKey="icici_card" name="ICICI · Card" stroke={C.blue} strokeWidth={2.5} dot={false} />
                  <Line type="monotone" dataKey="airtel_wallet" name="Airtel Wallet" stroke={C.amber} strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {tab === "cases" && (
        <div style={{ display: "flex", gap: 16 }}>
          {/* Case list */}
          <div style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {cases.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                style={{
                  textAlign: "left", background: c.id === selectedId ? C.surface2 : C.surface,
                  border: `1px solid ${c.id === selectedId ? C.blue : C.border}`, borderRadius: 8,
                  padding: "10px 12px", cursor: "pointer", color: C.text,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontFamily: fontMono, fontSize: 11, color: C.textMuted }}>{c.id}</span>
                  <ChevronRight size={13} color={C.textFaint} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{c.segment}</div>
                <div style={{ fontSize: 11, color: C.red, fontFamily: fontMono, marginBottom: 6 }}>
                  {c.baselineRate}% → {c.currentRate}%
                </div>
                <Badge status={c.reverted ? "rejected" : c.status} />
              </button>
            ))}
          </div>

          {/* Case detail */}
          {selected && (
            <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <div>
                  <div style={{ fontFamily: fontMono, fontSize: 12, color: C.textMuted }}>{selected.id}</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{selected.segment}</div>
                </div>
                <Badge status={selected.reverted ? "rejected" : selected.status} />
              </div>
              <div style={{ display: "flex", gap: 18, fontSize: 12, color: C.textMuted, fontFamily: fontMono, margin: "10px 0 18px" }}>
                <span>Baseline: <b style={{ color: C.text }}>{selected.baselineRate}%</b></span>
                <span>Current: <b style={{ color: C.red }}>{selected.currentRate}%</b></span>
                <span>Failed in window: <b style={{ color: C.text }}>{selected.windowFailed}</b> / {selected.windowAttempts}</span>
                <span>At risk: <b style={{ color: C.text }}>₹{(selected.windowFailed * selected.avgAmount).toLocaleString("en-IN")}</b></span>
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, letterSpacing: "0.04em", marginBottom: 8 }}>
                CANDIDATE ROOT CAUSES
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                {selected.hypotheses.map((h, i) => (
                  <div key={h.code} style={{ opacity: h.ruledOut ? 0.65 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                      <span style={{ textDecoration: h.ruledOut ? "line-through" : "none", fontWeight: i === 0 && !h.ruledOut ? 600 : 400 }}>
                        {CODE_LABEL[h.code]}
                      </span>
                      <span style={{ fontFamily: fontMono, color: C.textMuted }}>{Math.round(h.confidence * 100)}%</span>
                    </div>
                    <ConfidenceBar value={h.confidence} ruledOut={h.ruledOut} color={i === 0 ? C.green : C.blue} />
                    <div style={{ fontSize: 11.5, color: C.textFaint, marginTop: 4 }}>{h.reasoning}</div>
                  </div>
                ))}
              </div>

              <div style={{ height: 1, background: C.borderSoft, margin: "16px 0" }} />

              {selected.status === "abstained" && (
                <div style={{ background: C.surface2, border: `1px solid ${C.amber}`, borderRadius: 6, padding: 14, display: "flex", gap: 10 }}>
                  <AlertTriangle size={16} color={C.amber} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.amber, marginBottom: 4 }}>
                      Top confidence ({Math.round(selected.hypotheses[0].confidence * 100)}%) is below the {Math.round(CONFIDENCE_FLOOR * 100)}% floor for automated action.
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
                      No automated recovery was attempted. This case was escalated for manual review instead of guessing.
                    </div>
                    <button onClick={() => markReviewed(selected)} style={btnStyle(C.textMuted)}>Mark reviewed by ops</button>
                  </div>
                </div>
              )}

              {selected.status !== "abstained" && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, letterSpacing: "0.04em", marginBottom: 8 }}>
                    RECOMMENDED ACTION
                  </div>
                  <div style={{ background: C.surface2, borderRadius: 6, padding: 12, fontSize: 13, marginBottom: 14 }}>
                    {ACTIONS[selected.hypotheses[0].code].label}
                  </div>

                  {selected.status === "pending" && (
                    <div style={{ display: "flex", gap: 10 }}>
                      <button onClick={() => approve(selected)} style={btnStyle(C.green, true)}>
                        <CheckCircle2 size={14} /> Approve action
                      </button>
                      <button onClick={() => reject(selected)} style={btnStyle(C.red)}>
                        <XCircle size={14} /> Reject
                      </button>
                    </div>
                  )}

                  {selected.status === "approved" && selected.outcome && (
                    <div style={{ background: C.surface2, border: `1px solid ${selected.reverted ? C.red : C.green}`, borderRadius: 6, padding: 14 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: selected.reverted ? C.red : C.green, marginBottom: 4 }}>
                        {selected.reverted ? "Reverted" : "Recovered"}: ₹{selected.outcome.amount.toLocaleString("en-IN")} ({selected.outcome.recoveredTx} transactions)
                      </div>
                      {!selected.reverted && (
                        <button onClick={() => revert(selected)} style={btnStyle(C.textMuted)}>
                          <RotateCcw size={13} /> Mark as ineffective / revert
                        </button>
                      )}
                    </div>
                  )}

                  {selected.status === "rejected" && (
                    <div style={{ fontSize: 12, color: C.textFaint }}>No recovery action was taken for this case.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "audit" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {cases.map((c) => (
            <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div>
                  <div style={{ fontFamily: fontMono, fontSize: 11, color: C.textMuted }}>{c.id}</div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{c.segment}</div>
                </div>
                <Stamp status={c.reverted ? "rejected" : c.status} />
              </div>
              <div style={{ borderLeft: `2px dotted ${C.border}`, marginLeft: 5, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                <TimelineEntry ts="Day 15, 06:00" text={`Detected — success rate dropped from ${c.baselineRate}% to ${c.currentRate}% against a 14-day baseline.`} />
                <TimelineEntry ts="Day 15, 06:01" text={`Diagnosis generated — ${c.hypotheses.length} candidate cause(s) evaluated: ${c.hypotheses.map((h) => `${CODE_LABEL[h.code]} (${Math.round(h.confidence * 100)}%)`).join(", ")}.`} />
                {c.timeline.map((t, i) => (
                  <TimelineEntry key={i} ts={t.ts} text={t.event} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineEntry({ ts, text }) {
  return (
    <div style={{ position: "relative" }}>
      <Circle size={9} fill={C.blue} color={C.blue} style={{ position: "absolute", left: -23, top: 3 }} />
      <div style={{ fontFamily: fontMono, fontSize: 10.5, color: C.textFaint, marginBottom: 2 }}>{ts}</div>
      <div style={{ fontSize: 12.5, color: C.text }}>{text}</div>
    </div>
  );
}

function btnStyle(color, filled = false) {
  return {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: filled ? color : "transparent",
    color: filled ? C.bg : color,
    border: `1px solid ${color}`, borderRadius: 6,
    padding: "7px 12px", fontSize: 12.5, fontWeight: 600,
    cursor: "pointer", fontFamily: fontSans,
  };
}
