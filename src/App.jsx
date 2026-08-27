import React, { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  ShieldAlert, TrendingDown, CheckCircle2, XCircle, AlertTriangle,
  RotateCcw, ChevronRight, IndianRupee, Circle, RefreshCw, Loader2, Upload
} from "lucide-react";

const API_BASE = "http://127.0.0.1:8000";

/* ---------------------------------------------------------------- */
/* Design tokens                                                      */
/* ---------------------------------------------------------------- */
const C = {
  bg: "#0A0F1C", surface: "#111827", surface2: "#161F33",
  border: "#26314A", borderSoft: "#1D2740",
  text: "#E7ECF5", textMuted: "#8592AD", textFaint: "#5C6884",
  green: "#46D6A0", amber: "#F0B559", red: "#F0637C", blue: "#6FA8F5",
};
const fontMono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const fontSans = "ui-sans-serif, system-ui, -apple-system, sans-serif";

const CODE_LABEL = {
  issuer_decline: "Issuer decline cluster",
  otp_timeout: "OTP delivery timeout",
  expired_card: "Expired / invalid card",
  network_error: "Gateway / network error",
};
const ACTION_LABEL = {
  issuer_decline: "Reroute retry via alternate acquiring bank",
  otp_timeout: "Trigger OTP resend with extended validity window",
  expired_card: "Prompt customer to update card / switch method",
  network_error: "Flag transaction for gateway health review",
};
const CONFIDENCE_FLOOR = 0.45;
const SEGMENT_LINE_COLORS = [C.green, C.blue, C.amber, C.red, "#B98BF0", "#4FC3D9"];

/* ---------------------------------------------------------------- */
/* Small UI atoms (unchanged visual language)                        */
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
    <span style={{ fontFamily: fontMono, fontSize: 11, letterSpacing: "0.08em", color: m.color, border: `1px solid ${m.color}`, borderRadius: 3, padding: "2px 7px", whiteSpace: "nowrap" }}>
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
    <div style={{ display: "inline-block", transform: "rotate(-6deg)", border: `2px solid ${m.color}`, color: m.color, fontFamily: fontMono, fontWeight: 700, fontSize: 12, letterSpacing: "0.18em", padding: "4px 10px", borderRadius: 4, opacity: 0.9 }}>
      {m.label}
    </div>
  );
}

function ConfidenceBar({ value, ruledOut, color }) {
  return (
    <div style={{ background: C.surface2, borderRadius: 3, height: 6, width: "100%", overflow: "hidden" }}>
      <div style={{ width: `${Math.round(value * 100)}%`, height: "100%", background: ruledOut ? C.textFaint : color, opacity: ruledOut ? 0.5 : 1 }} />
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
    <button onClick={onClick} style={{ background: "transparent", border: "none", cursor: "pointer", color: active ? C.text : C.textMuted, fontFamily: fontSans, fontSize: 13, fontWeight: active ? 600 : 500, padding: "10px 4px", borderBottom: active ? `2px solid ${C.blue}` : "2px solid transparent", letterSpacing: "0.02em" }}>
      {children}
    </button>
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

function btnStyle(color, filled = false, disabled = false) {
  return {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: filled ? color : "transparent",
    color: filled ? C.bg : color,
    border: `1px solid ${color}`, borderRadius: 6,
    padding: "7px 12px", fontSize: 12.5, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontFamily: fontSans,
  };
}

/* ---------------------------------------------------------------- */
/* Main component — everything below is fetched from the backend     */
/* ---------------------------------------------------------------- */
export default function App() {
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  const [cases, setCases] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [chart, setChart] = useState(null);
  const [dashboard, setDashboard] = useState(null);

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const [casesRes, chartRes, dashRes] = await Promise.all([
        fetch(`${API_BASE}/api/cases`),
        fetch(`${API_BASE}/api/segments`),
        fetch(`${API_BASE}/api/dashboard`),
      ]);
      if (!casesRes.ok) throw new Error("cases fetch failed");
      const casesData = await casesRes.json();
      const chartData = chartRes.ok ? await chartRes.json() : null;
      const dashData = dashRes.ok ? await dashRes.json() : null;

      setCases(casesData);
      setChart(chartData);
      setDashboard(dashData);
      if (casesData.length && !casesData.find((c) => c.id === selectedId)) {
        setSelectedId(casesData[0].id);
      }
    } catch (e) {
      setError("Can't reach the backend at " + API_BASE + ". Is `uvicorn app.main:app --reload --port 8000` running?");
    }
  }, [selectedId]);

  const fetchDetail = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/cases/${id}`);
      if (res.ok) setSelectedDetail(await res.json());
    } catch (e) { /* ignore, handled by fetchAll error state */ }
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/generate`, { method: "POST" });
      if (!res.ok) throw new Error("generate failed");
      await fetchAll();
    } catch (e) {
      setError("Can't reach the backend at " + API_BASE + ". Is it running?");
    }
    setGenerating(false);
  }

  async function uploadCsv(file) {
    if (!file) return;
    setGenerating(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE}/api/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed.");
      await fetchAll();
      if (data.unrecognized_failure_codes && data.unrecognized_failure_codes.length) {
        setError(
          `Loaded ${data.rows_loaded} rows. Some failure_code values weren't recognized ` +
          `and were bucketed as "network_error": ${data.unrecognized_failure_codes.join(", ")}.`
        );
      }
    } catch (e) {
      setError(e.message || "Upload failed — check your CSV format.");
    }
    setGenerating(false);
  }

  function downloadSampleCsv() {
    const header = "day,issuer,method,amount,status,failure_code\n";
    const rows = [];
    for (let day = 1; day <= 15; day++) {
      const anomaly = day >= 11;
      const rate = anomaly ? 55 : 93;
      for (let i = 0; i < 25; i++) {
        const success = Math.random() * 100 < rate;
        const amount = (300 + Math.random() * 300).toFixed(2);
        let code = "";
        if (!success) {
          code = anomaly
            ? (Math.random() < 0.75 ? "issuer_decline" : ["otp_timeout", "expired_card", "network_error"][Math.floor(Math.random() * 3)])
            : ["issuer_decline", "otp_timeout", "expired_card", "network_error"][Math.floor(Math.random() * 4)];
        }
        rows.push(`${day},HDFC,UPI,${amount},${success ? "success" : "failed"},${code}`);
      }
    }
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sample_transactions.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doAction(caseId, action) {
    try {
      const res = await fetch(`${API_BASE}/api/cases/${caseId}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(action + " failed");
      await fetchAll();
      await fetchDetail(caseId);
    } catch (e) {
      setError("Action failed — backend may be unreachable.");
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchAll();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  const metrics = dashboard || { recovered: 0, recoverable: 0, resolution_rate: 0, escalation_rate: 0, flagged_segments: 0 };

  return (
    <div className="app-container" style={{ background: C.bg, color: C.text, fontFamily: fontSans, minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textMuted, fontSize: 11, fontFamily: fontMono, letterSpacing: "0.12em", marginBottom: 4 }}>
            <ShieldAlert size={13} color={C.blue} /> AI REVENUE RECOVERY · TRACK 03
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Payment Recovery Console</h1>
          <p style={{ fontSize: 13, color: C.textMuted, margin: "4px 0 0", maxWidth: 640 }}>
            Detects payment-success degradation, ranks competing root causes with confidence, abstains honestly when evidence is thin, and never recovers money without an operator's approval.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={generate} disabled={generating} style={{ ...btnStyle(C.blue, true, generating), height: 36 }}>
              {generating ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              {generating ? "Working..." : "Generate new batch"}
            </button>
            <label style={{ ...btnStyle(C.textMuted, false, generating), height: 36, margin: 0 }}>
              <Upload size={14} /> Upload CSV
              <input
                type="file"
                accept=".csv"
                disabled={generating}
                style={{ display: "none" }}
                onChange={(e) => { uploadCsv(e.target.files[0]); e.target.value = ""; }}
              />
            </label>
          </div>
          <button onClick={downloadSampleCsv} style={{ background: "none", border: "none", color: C.textFaint, fontSize: 11.5, cursor: "pointer", textDecoration: "underline", fontFamily: fontSans, padding: 0 }}>
            download a sample CSV to try
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#2A1420", border: `1px solid ${C.red}`, color: C.red, borderRadius: 6, padding: "10px 14px", fontSize: 12.5, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 13, padding: 40, textAlign: "center" }}>Loading…</div>
      ) : cases.length === 0 && !error ? (
        <div style={{ color: C.textMuted, fontSize: 13, padding: 40, textAlign: "center" }}>
          No batch yet — click <b style={{ color: C.text }}>Generate new batch</b> above to run detection on a fresh synthetic dataset.
        </div>
      ) : (
        <>
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
                <MetricCard icon={CheckCircle2} label="RESOLUTION RATE" value={`${metrics.resolution_rate}%`} sub="cases with an operator decision" color={C.blue} />
                <MetricCard icon={AlertTriangle} label="HONEST ESCALATIONS" value={`${metrics.escalation_rate}%`} sub="abstained rather than guessed" color={C.amber} />
                <MetricCard icon={TrendingDown} label="FLAGGED SEGMENTS" value={metrics.flagged_segments} sub="anomalies this batch" color={C.red} />
              </div>

              {chart && (
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "18px 18px 8px" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Success rate by segment, 21-day window</div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 10, fontFamily: fontMono }}>anomaly window begins day {chart.anomaly_start}</div>
                  <div style={{ width: "100%", height: 280 }}>
                    <ResponsiveContainer>
                      <LineChart data={chart.rows} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid stroke={C.borderSoft} vertical={false} />
                        <XAxis dataKey="day" tick={{ fill: C.textFaint, fontSize: 10, fontFamily: fontMono }} axisLine={{ stroke: C.border }} tickLine={false} />
                        <YAxis domain={[30, 100]} tick={{ fill: C.textFaint, fontSize: 10, fontFamily: fontMono }} axisLine={false} tickLine={false} />
                        <ReferenceLine x={`D${chart.anomaly_start}`} stroke={C.amber} strokeDasharray="3 3" />
                        <Tooltip contentStyle={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: fontMono }} labelStyle={{ color: C.textMuted }} />
                        <Legend wrapperStyle={{ fontSize: 11, fontFamily: fontSans }} />
                        {chart.segments.map((s, i) => (
                          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SEGMENT_LINE_COLORS[i % SEGMENT_LINE_COLORS.length]} strokeWidth={2} dot={false} connectNulls />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "cases" && (
            <div style={{ display: "flex", gap: 16 }}>
              <div style={{ width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {cases.map((c) => (
                  <button key={c.id} onClick={() => setSelectedId(c.id)} style={{ textAlign: "left", background: c.id === selectedId ? C.surface2 : C.surface, border: `1px solid ${c.id === selectedId ? C.blue : C.border}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", color: C.text }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontFamily: fontMono, fontSize: 11, color: C.textMuted }}>CASE-{String(c.id).padStart(4, "0")}</span>
                      <ChevronRight size={13} color={C.textFaint} />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{c.segment}</div>
                    <div style={{ fontSize: 11, color: C.red, fontFamily: fontMono, marginBottom: 6 }}>{c.baseline_rate}% → {c.current_rate}%</div>
                    <Badge status={c.reverted ? "rejected" : c.status} />
                  </button>
                ))}
              </div>

              {selectedDetail && (
                <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                    <div>
                      <div style={{ fontFamily: fontMono, fontSize: 12, color: C.textMuted }}>CASE-{String(selectedDetail.id).padStart(4, "0")}</div>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{selectedDetail.segment}</div>
                    </div>
                    <Badge status={selectedDetail.reverted ? "rejected" : selectedDetail.status} />
                  </div>
                  <div style={{ display: "flex", gap: 18, fontSize: 12, color: C.textMuted, fontFamily: fontMono, margin: "10px 0 18px", flexWrap: "wrap" }}>
                    <span>Baseline: <b style={{ color: C.text }}>{selectedDetail.baseline_rate}%</b></span>
                    <span>Current: <b style={{ color: C.red }}>{selectedDetail.current_rate}%</b></span>
                    <span>Failed in window: <b style={{ color: C.text }}>{selectedDetail.window_failed}</b> / {selectedDetail.window_attempts}</span>
                    <span>At risk: <b style={{ color: C.text }}>₹{Math.round(selectedDetail.window_failed * selectedDetail.avg_amount).toLocaleString("en-IN")}</b></span>
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, letterSpacing: "0.04em", marginBottom: 8 }}>CANDIDATE ROOT CAUSES</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                    {selectedDetail.hypotheses.map((h, i) => (
                      <div key={h.code} style={{ opacity: h.ruled_out ? 0.65 : 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                          <span style={{ textDecoration: h.ruled_out ? "line-through" : "none", fontWeight: i === 0 && !h.ruled_out ? 600 : 400 }}>{CODE_LABEL[h.code]}</span>
                          <span style={{ fontFamily: fontMono, color: C.textMuted }}>{Math.round(h.confidence * 100)}%</span>
                        </div>
                        <ConfidenceBar value={h.confidence} ruledOut={h.ruled_out} color={i === 0 ? C.green : C.blue} />
                        <div style={{ fontSize: 11.5, color: C.textFaint, marginTop: 4 }}>{h.reasoning}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ height: 1, background: C.borderSoft, margin: "16px 0" }} />

                  {selectedDetail.status === "abstained" && (
                    <div style={{ background: C.surface2, border: `1px solid ${C.amber}`, borderRadius: 6, padding: 14, display: "flex", gap: 10 }}>
                      <AlertTriangle size={16} color={C.amber} style={{ flexShrink: 0, marginTop: 2 }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.amber, marginBottom: 4 }}>
                          Top confidence ({Math.round(selectedDetail.hypotheses[0].confidence * 100)}%) is below the {Math.round(CONFIDENCE_FLOOR * 100)}% floor for automated action.
                        </div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>No automated recovery was attempted. This case was escalated for manual review instead of guessing.</div>
                        <button onClick={() => doAction(selectedDetail.id, "mark-reviewed")} style={btnStyle(C.textMuted)}>Mark reviewed by ops</button>
                      </div>
                    </div>
                  )}

                  {selectedDetail.status !== "abstained" && (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, letterSpacing: "0.04em", marginBottom: 8 }}>RECOMMENDED ACTION</div>
                      <div style={{ background: C.surface2, borderRadius: 6, padding: 12, fontSize: 13, marginBottom: 14 }}>
                        {ACTION_LABEL[selectedDetail.hypotheses[0].code]}
                      </div>

                      {selectedDetail.status === "pending" && (
                        <div style={{ display: "flex", gap: 10 }}>
                          <button onClick={() => doAction(selectedDetail.id, "approve")} style={btnStyle(C.green, true)}>
                            <CheckCircle2 size={14} /> Approve action
                          </button>
                          <button onClick={() => doAction(selectedDetail.id, "reject")} style={btnStyle(C.red)}>
                            <XCircle size={14} /> Reject
                          </button>
                        </div>
                      )}

                      {selectedDetail.status === "approved" && (
                        <div style={{ background: C.surface2, border: `1px solid ${selectedDetail.reverted ? C.red : C.green}`, borderRadius: 6, padding: 14 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: selectedDetail.reverted ? C.red : C.green, marginBottom: 4 }}>
                            {selectedDetail.reverted ? "Reverted" : "Recovered"}: ₹{Math.round(selectedDetail.recovered_amount).toLocaleString("en-IN")} ({selectedDetail.recovered_tx} transactions)
                          </div>
                          {!selectedDetail.reverted && (
                            <button onClick={() => doAction(selectedDetail.id, "revert")} style={btnStyle(C.textMuted)}>
                              <RotateCcw size={13} /> Mark as ineffective / revert
                            </button>
                          )}
                        </div>
                      )}

                      {selectedDetail.status === "rejected" && (
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
                <AuditCard key={c.id} caseId={c.id} summary={c} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditCard({ caseId, summary }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/cases/${caseId}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => { });
  }, [caseId]);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: fontMono, fontSize: 11, color: C.textMuted }}>CASE-{String(caseId).padStart(4, "0")}</div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{summary.segment}</div>
        </div>
        <Stamp status={summary.reverted ? "rejected" : summary.status} />
      </div>
      <div style={{ borderLeft: `2px dotted ${C.border}`, marginLeft: 5, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {detail ? (
          detail.timeline.map((t, i) => (
            <TimelineEntry key={i} ts={new Date(t.ts).toLocaleString()} text={t.event} />
          ))
        ) : (
          <div style={{ color: C.textFaint, fontSize: 12 }}>Loading timeline…</div>
        )}
      </div>
    </div>
  );
}
