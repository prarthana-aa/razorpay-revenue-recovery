import React, { useState, useEffect, useCallback } from "react";
import "./App.css";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3,
  Bell, Check, CheckCircle2, ChevronRight, Clock3, Database,
  FileClock, IndianRupee, LayoutDashboard, ListFilter, Loader2,
  RefreshCw, RotateCcw, Search, Settings2, ShieldAlert,
  Sparkles, Upload, X, XCircle, Zap, BrainCircuit, Play
} from "lucide-react";

const API_BASE = "http://127.0.0.1:8000";

const C = {
  bg: "#080c14", surface: "#101722", surface2: "#151e2d",
  border: "#223047", borderSoft: "#192438",
  text: "#edf4f3", textMuted: "#8b9aab", textFaint: "#607084",
  green: "#62e6b4", amber: "#f5bd64", red: "#ff718b", blue: "#7caeff",
};
const fontMono = '"DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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
const SEGMENT_LINE_COLORS = [C.green, C.blue, C.amber, C.red, "#c391ff", "#51c7d5"];
const DEMO_CASES = [
  { merchant: "Swiggy", amount: 599, reason: "PSP timeout", confidence: 93, strategy: "Switch to backup PSP" },
  { merchant: "Zomato", amount: 1248, reason: "UPI PSP latency", confidence: 91, strategy: "Adaptive retry interval" },
  { merchant: "Netflix", amount: 3842, reason: "Issuer decline cluster", confidence: 88, strategy: "Reroute via alternate acquirer" },
  { merchant: "Spotify", amount: 11644, reason: "Token refresh failure", confidence: 95, strategy: "Update payment token" },
  { merchant: "Meesho", amount: 7553, reason: "Gateway network error", confidence: 90, strategy: "Retry through healthy gateway" },
  { merchant: "Blinkit", amount: 0, reason: "Expired card", confidence: 86, strategy: "Prompt alternate payment" },
];

function formatCurrency(value) {
  return `₹${Math.round(value || 0).toLocaleString("en-IN")}`;
}

function getEvidenceColor(colorName) {
  const map = {
    mint: C.green,
    blue: C.blue,
    amber: C.amber,
    coral: C.red,
    slate: C.textMuted
  };
  return map[colorName] || C.textMuted;
}

function statusMeta(status, reverted = false) {
  if (reverted) return { label: "REVERTED", tone: "red", color: C.red };
  const map = {
    pending: { label: "PENDING REVIEW", tone: "blue", color: C.blue },
    approved: { label: "RECOVERED", tone: "green", color: C.green },
    rejected: { label: "REJECTED", tone: "red", color: C.red },
    abstained: { label: "ESCALATED", tone: "amber", color: C.amber },
    "escalated-reviewed": { label: "MANUALLY REVIEWED", tone: "muted", color: C.textMuted },
  };
  return map[status] || map.pending;
}

function lifecycleMeta(state) {
  const map = {
    DETECTED: ["DETECTED", "blue"], INVESTIGATING: ["INVESTIGATING", "blue"],
    READY: ["READY", "green"], AWAITING_APPROVAL: ["AWAITING APPROVAL", "amber"],
    EXECUTING: ["EXECUTING", "amber"], RECOVERED: ["RECOVERED", "green"], ESCALATED: ["ESCALATED", "red"]
  };
  const [label, tone] = map[state] || map.DETECTED;
  return { label, tone };
}

function LifecycleChip({ state }) {
  const meta = lifecycleMeta(state);
  return <span className={`status-pill status-${meta.tone}`}><span className="status-dot" />{meta.label}</span>;
}

function Badge({ status, reverted = false }) {
  const meta = statusMeta(status, reverted);
  return <span className={`status-pill status-${meta.tone}`}><span className="status-dot" />{meta.label}</span>;
}

function ConfidenceBar({ value, ruledOut, color }) {
  return (
    <div className="confidence-track">
      <div className="confidence-fill" style={{ width: `${Math.round(value * 100)}%`, background: ruledOut ? C.textFaint : color, opacity: ruledOut ? 0.5 : 1 }} />
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, sub, color, trend }) {
  return (
    <div className="metric-card">
      <div className="metric-topline">
        <span className="metric-icon" style={{ color, background: `${color}18` }}><Icon size={15} /></span>
        {trend && <span className={`metric-trend ${trend.startsWith("-") ? "down" : ""}`}><ArrowUpRight size={12} />{trend}</span>}
      </div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }) {
  return (
    <button className={`tab-button ${active ? "active" : ""}`} onClick={onClick}>
      <Icon size={15} />{children}
    </button>
  );
}

function TimelineEntry({ ts, text, index = 0 }) {
  return (
    <div className="timeline-entry" style={{ "--entry-delay": `${index * 70}ms` }}>
      <div className="timeline-node"><span /></div>
      <div className="timeline-copy">
        <div className="timeline-time">{ts}</div>
        <div className="timeline-text">{text}</div>
      </div>
    </div>
  );
}

function btnStyle(color, filled = false, disabled = false) {
  return {
    "--button-color": color,
    background: filled ? color : "transparent",
    color: filled ? C.bg : color,
    borderColor: color,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function LoadingState() {
  return (
    <div className="loading-state">
      <div className="loading-orbit"><Sparkles size={21} /></div>
      <div>
        <strong>Connecting to recovery intelligence</strong>
        <span>Pulling the latest batch signals and case evidence…</span>
      </div>
      <div className="loading-skeleton-grid">
        <span /><span /><span /><span />
      </div>
    </div>
  );
}

function EmptyState({ onGenerate, generating }) {
  return (
    <div className="empty-state panel">
      <div className="empty-visual"><div className="empty-ring"><Activity size={28} /></div></div>
      <div className="eyebrow">SYSTEM READY · NO ACTIVE BATCH</div>
      <h2>Start your first recovery run</h2>
      <p>Generate a fresh transaction cohort to map payment health, surface competing root causes, and create an operator-ready case queue.</p>
      <button className="action-button primary" onClick={onGenerate} disabled={generating}>
        {generating ? <Loader2 size={16} className="spin" /> : <Zap size={16} />}
        {generating ? "Building signal map…" : "Generate new batch"}
      </button>
    </div>
  );
}

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
  const [caseSearch, setCaseSearch] = useState("");
  const [caseFilter, setCaseFilter] = useState("all");
  const [demo, setDemo] = useState(null);
  const [demoToast, setDemoToast] = useState(null);
  const [demoBanner, setDemoBanner] = useState(null);
  const [demoSummary, setDemoSummary] = useState(false);

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
    } catch {
      setError("Can't reach the backend at " + API_BASE + ". Is `uvicorn app.main:app --reload --port 8000` running?");
    }
  }, [selectedId]);

  const fetchDetail = useCallback(async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/cases/${id}`);
      if (res.ok) setSelectedDetail(await res.json());
    } catch { /* ignore, handled by fetchAll error state */ }
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/generate`, { method: "POST" });
      if (!res.ok) throw new Error("generate failed");
      await fetchAll();
    } catch {
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
    } catch {
      setError("Action failed — backend may be unreachable.");
    }
  }

  const transition = useCallback(async (caseId, state, event) => {
    const params = new URLSearchParams({ state, event });
    await fetch(`${API_BASE}/api/cases/${caseId}/lifecycle?${params}`, { method: "POST" });
    await fetchAll();
    await fetchDetail(caseId);
  }, [fetchAll, fetchDetail]);

  async function runDemo() {
    if (!selectedId || demo?.running) return;
    const agent = await (await fetch(`${API_BASE}/api/agent/${selectedId}`)).json();
    const target = DEMO_CASES.reduce((sum, item) => sum + item.amount, 0);
    const targetTx = 39;
    const say = (message, phase) => { setDemoBanner(phase); setDemoToast(message); setTimeout(() => setDemoToast(null), 2300); setDemo((d) => ({ ...d, events: [...(d?.events || []), { message, state: "INVESTIGATING", time: new Date().toLocaleTimeString([], { hour12: false }) }] })); };
    setTab("overview");
    setDemoSummary(false);
    setDemo({ caseId: selectedId, running: true, paused: false, index: 0, events: [], progress: 0, recoveredTx: 0, recoveredAmount: 0, targetTx, targetAmount: target, agent, activeDemoCase: -1, phase: "SCANNING" });
    say(`AI Recovery Agent started — Batch #${String(cases[0]?.id || 1).padStart(4, "0")}`, "Scanning payment health…");
    await new Promise((r) => setTimeout(r, 1500));
    setTab("cases"); say("Detecting degradation clusters…", "Detecting degradation clusters…");
    await new Promise((r) => setTimeout(r, 1500));
    say("Building recovery plan…", "Building recovery plan…");
    for (let i = 0; i < DEMO_CASES.length; i += 1) {
      setDemo((d) => ({ ...d, activeDemoCase: i, phase: "DIAGNOSING", index: i + 2 }));
      await new Promise((r) => setTimeout(r, 650));
      say(`${DEMO_CASES[i].merchant}: ${DEMO_CASES[i].reason} identified.`, "Optimizing recovery strategy…");
      await new Promise((r) => setTimeout(r, 500));
      setDemo((d) => ({ ...d, phase: "RETRYING", recoveredAmount: target * (i + 1) / DEMO_CASES.length, recoveredTx: Math.round(targetTx * (i + 1) / DEMO_CASES.length), progress: (i + 1) / DEMO_CASES.length }));
      say(`${DEMO_CASES[i].merchant}: Payment recovered.`, "Recovery signal confirmed.");
      await new Promise((r) => setTimeout(r, 650));
    }
    setTab("audit"); setDemoBanner("Audit trail synchronized…");
    await new Promise((r) => setTimeout(r, 2200));
    setDemo((d) => ({ ...d, running: false, phase: "HEALTHY", recoveredAmount: target, recoveredTx: targetTx, progress: 1 }));
    setDemoBanner(null); setDemoSummary(true);
  }

  async function approveDemo() {
    if (!demo) return;
    const { caseId, targetTx, targetAmount } = demo;
    await transition(caseId, "EXECUTING", "Recovery executed.");
    for (let i = 1; i <= 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 110));
      setDemo((d) => ({ ...d, paused: false, progress: i / 12, recoveredTx: Math.round(targetTx * i / 12), recoveredAmount: targetAmount * i / 12 }));
    }
    await fetch(`${API_BASE}/api/cases/${caseId}/approve`, { method: "POST" });
    await transition(caseId, "RECOVERED", "Revenue recovered.");
    setDemo((d) => ({ ...d, running: false, paused: false, progress: 1, recoveredTx: targetTx, recoveredAmount: targetAmount, index: 7, events: [...d.events, { message: "Recovery executed.", state: "EXECUTING", time: new Date().toLocaleTimeString([], { hour12: false }) }, { message: "Revenue recovered.", state: "RECOVERED", time: new Date().toLocaleTimeString([], { hour12: false }) }] }));
  }

  async function rejectDemo() {
    if (!demo) return;
    await transition(demo.caseId, "ESCALATED", "Operator rejected recovery. Case escalated.");
    await fetch(`${API_BASE}/api/cases/${demo.caseId}/reject`, { method: "POST" });
    setDemo((d) => ({ ...d, running: false, paused: false, index: 7, events: [...d.events, { message: "Recovery rejected and escalated.", state: "ESCALATED", time: new Date().toLocaleTimeString([], { hour12: false }) }] }));
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
  const filteredCases = cases.filter((item) => {
    const matchesSearch = `${item.segment} ${item.id}`.toLowerCase().includes(caseSearch.toLowerCase());
    const matchesFilter = caseFilter === "all" || item.status === caseFilter;
    return matchesSearch && matchesFilter;
  });
  const pendingCount = cases.filter((item) => item.status === "pending").length;
  const topCase = cases[0];
  const healthScore = topCase ? Math.max(0, Math.round(topCase.current_rate)) : 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><ShieldAlert size={18} /></div>
          <div><strong>Razorpay</strong><span>RECOVERY OS</span></div>
        </div>
        <div className="workspace-label">OPERATIONS CONSOLE</div>
        <nav className="side-nav" aria-label="Primary navigation">
          <button className={`side-nav-item ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}><LayoutDashboard size={17} /><span>Mission control</span><kbd>01</kbd></button>
          <button className={`side-nav-item ${tab === "cases" ? "active" : ""}`} onClick={() => setTab("cases")}><ListFilter size={17} /><span>Case queue</span>{pendingCount > 0 && <b>{pendingCount}</b>}</button>
          <button className={`side-nav-item ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}><FileClock size={17} /><span>Audit trail</span><kbd>03</kbd></button>
        </nav>
        <div className="sidebar-divider" />
        <div className="side-nav-caption">SYSTEM</div>
        <button className="side-nav-item muted"><Settings2 size={17} /><span>Console settings</span></button>
        <div className="sidebar-bottom">
          <div className="live-status"><span className="live-dot" /><div><strong>Detection engine live</strong><span>Rule set v2.4 · calibrated</span></div></div>
          <div className="sidebar-footnote"><Database size={13} /> SQLite session store</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark"><ShieldAlert size={16} /></div><strong>Recovery OS</strong></div>
          <div className="breadcrumb"><span>RZP / OPERATIONS</span><ChevronRight size={13} /><strong>{tab === "overview" ? "MISSION CONTROL" : tab === "cases" ? "CASE QUEUE" : "AUDIT TRAIL"}</strong></div>
          <div className="topbar-actions">
            <span className="environment-chip"><span className="live-dot" />LIVE DATA</span>
            <button className="icon-button" aria-label="Notifications"><Bell size={16} /><span className="notification-dot" /></button>
            <button className="avatar-button" aria-label="Operator profile">OP</button>
          </div>
        </header>

        {error && (
          <div className="error-toast" role="alert">
            <AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error"><X size={15} /></button>
          </div>
        )}
        {demoBanner && <div className="agent-banner"><Loader2 size={14} className="spin" />{demoBanner}</div>}
        {demoToast && <div className="demo-toast"><BrainCircuit size={16} /><span>{demoToast}</span></div>}

        {loading ? <LoadingState /> : cases.length === 0 && !error ? (
          <EmptyState onGenerate={generate} generating={generating} />
        ) : (
          <>
            <section className="page-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-pulse" />AI REVENUE RECOVERY <span className="eyebrow-separator">/</span> TRACK 03</div>
                <h1>{tab === "overview" ? "Payment health, at a glance." : tab === "cases" ? "Investigate with confidence." : "Every decision, replayable."}</h1>
                <p>{tab === "overview" ? "A live operating picture for detecting, diagnosing, and recovering payment-success degradation." : tab === "cases" ? "Review the evidence behind every anomaly before approving a bounded recovery action." : "A complete reasoning trail from detection to outcome, preserved for review."}</p>
              </div>
              <div className="heading-actions">
                <button className="action-button ghost" onClick={downloadSampleCsv}><FileClock size={15} />Sample CSV</button>
                <label className={`action-button ghost ${generating ? "disabled" : ""}`}><Upload size={15} />Upload data<input type="file" accept=".csv" disabled={generating} onChange={(e) => { uploadCsv(e.target.files[0]); e.target.value = ""; }} /></label>
                <button className="action-button demo-button" onClick={runDemo} disabled={!selectedId || demo?.running}>{demo?.running ? <Loader2 size={15} className="spin" /> : <Play size={15} />}{demo?.running ? "Running Recovery…" : demoSummary ? "Run Again" : "Run AI Recovery Demo"}</button>
                <button className="action-button primary" onClick={generate} disabled={generating}>{generating ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{generating ? "Running…" : "Generate batch"}</button>
              </div>
            </section>

            <div className="tab-bar">
              <TabButton icon={BarChart3} active={tab === "overview"} onClick={() => setTab("overview")}>Overview</TabButton>
              <TabButton icon={ListFilter} active={tab === "cases"} onClick={() => setTab("cases")}>Case Queue <span className="tab-count">{cases.length}</span></TabButton>
              <TabButton icon={FileClock} active={tab === "audit"} onClick={() => setTab("audit")}>Audit Trail</TabButton>
              <div className="tab-bar-meta"><span className="live-dot" />SYNCED JUST NOW <span className="meta-divider" />BATCH #{cases.length ? String(cases[0].id).padStart(4, "0") : "—"}</div>
            </div>

            {tab === "overview" && (
              <Overview chart={chart} metrics={metrics} cases={cases} healthScore={healthScore} setTab={setTab} setSelectedId={setSelectedId} demo={demo} />
            )}
            {tab === "cases" && (
              <CaseQueue
                cases={filteredCases}
                allCases={cases}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                selectedDetail={selectedDetail}
                caseSearch={caseSearch}
                setCaseSearch={setCaseSearch}
                caseFilter={caseFilter}
                setCaseFilter={setCaseFilter}
                doAction={doAction} demo={demo} approveDemo={approveDemo} rejectDemo={rejectDemo}
              />
            )}
            {tab === "audit" && <AuditTrail cases={cases} demo={demo} />}
            {demoSummary && <RecoverySummary demo={demo} batchId={cases[0]?.id || 1} onClose={() => setDemoSummary(false)} />}
          </>
        )}
      </main>
    </div>
  );
}

function Overview({ chart, metrics, cases, healthScore, setTab, setSelectedId, demo }) {
  const queueCount = cases.filter((item) => item.status === "pending").length;
  const active = cases.filter((item) => !["RECOVERED", "ESCALATED"].includes(item.lifecycle)).length;
  const risk = cases.reduce((sum, item) => sum + item.window_failed * item.avg_amount, 0);
  const recovering = demo?.running && demo.progress > 0;
  return (
    <div className="overview-grid">
      <section className="mission-status panel">
        <div><div className="section-kicker"><BrainCircuit size={14} /> MISSION STATUS</div><h3>Recovery operations, live</h3></div>
        <div className="mission-metrics">
          <MetricCard icon={Activity} label="ACTIVE INVESTIGATIONS" value={active} sub={`${queueCount} awaiting operator action`} color={C.blue} />
          <MetricCard icon={AlertTriangle} label="REVENUE CURRENTLY AT RISK" value={formatCurrency(risk)} sub="across flagged segments" color={C.amber} />
          <MetricCard icon={IndianRupee} label="REVENUE RECOVERED TODAY" value={formatCurrency(demo?.recoveredAmount || metrics.recovered)} sub={recovering ? "simulation in progress" : "confirmed outcomes"} color={C.green} />
          <MetricCard icon={recovering ? RefreshCw : Activity} label="AGENT HEALTH" value={recovering ? "Recovering" : active ? "Monitoring" : "Idle"} sub="autonomous investigation loop" color={recovering ? C.amber : C.green} />
        </div>
      </section>
      <section className="hero-analytics panel">
        <div className="hero-content">
          <div className="section-kicker"><Activity size={14} /> LIVE PAYMENT HEALTH</div>
          <div className="hero-title-row"><h2>Success rate by segment</h2><span className="time-chip"><Clock3 size={13} />21 DAY WINDOW</span></div>
          <p className="panel-description">Payment health across issuer × method combinations. Anomaly window begins day {chart?.anomaly_start || "—"}.</p>
          <div className="chart-legend-note"><span className="legend-line" />Current success signal <span className="legend-marker" />Anomaly window</div>
          {chart ? (
            <div className="main-chart">
              <ResponsiveContainer>
                <LineChart data={chart.rows} margin={{ top: 10, right: 14, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={C.borderSoft} vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: C.textFaint, fontSize: 10, fontFamily: fontMono }} axisLine={false} tickLine={false} />
                  <YAxis domain={[30, 100]} tick={{ fill: C.textFaint, fontSize: 10, fontFamily: fontMono }} axisLine={false} tickLine={false} />
                  <ReferenceLine x={`D${chart.anomaly_start}`} stroke={C.amber} strokeDasharray="4 4" />
                  <Tooltip contentStyle={{ background: "#182334", border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12, fontFamily: fontMono, boxShadow: "0 12px 30px #0008" }} labelStyle={{ color: C.textMuted }} />
                  <Legend wrapperStyle={{ display: "none" }} />
                  {chart.segments.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SEGMENT_LINE_COLORS[i % SEGMENT_LINE_COLORS.length]} strokeWidth={2.4} dot={false} connectNulls animationDuration={1200} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="chart-placeholder">No chart data available for this batch.</div>}
        </div>
        <div className="hero-side-stat">
          <div className="radial-score" style={{ "--score": `${healthScore * 3.6}deg` }}><div><strong>{healthScore}%</strong><span>health score</span></div></div>
          <div className="score-caption"><span className="signal-bullet" />{queueCount} segments need operator attention</div>
          <button className="inline-link" onClick={() => setTab("cases")}>Open investigation queue <ArrowUpRight size={14} /></button>
        </div>
      </section>

      <section className="signal-panel panel">
        <div className="panel-heading"><div><div className="section-kicker"><Zap size={14} /> SIGNAL MONITOR</div><h3>How the engine is thinking</h3></div><span className="confidence-chip">CONFIDENCE FLOOR · 45%</span></div>
        <div className="signal-columns">
          <div className="signal-summary"><div className="signal-icon"><Sparkles size={18} /></div><div><strong>Competing hypotheses ranked</strong><p>Diagnosis is computed from live failure-code distribution, not a fixed demo answer.</p></div></div>
          <div className="signal-summary"><div className="signal-icon amber"><ShieldAlert size={18} /></div><div><strong>Abstention is active</strong><p>Thin evidence is escalated to an operator instead of triggering an unsafe action.</p></div></div>
          <div className="signal-summary"><div className="signal-icon blue"><RotateCcw size={18} /></div><div><strong>Actions are reversible</strong><p>Every approved recovery remains visible in the audit trail and can be reverted.</p></div></div>
        </div>
      </section>

      <section className="recent-panel panel">
        <div className="panel-heading"><div><div className="section-kicker"><ListFilter size={14} /> RECENT INVESTIGATIONS</div><h3>Case queue snapshot</h3></div><button className="inline-link" onClick={() => setTab("cases")}>View all cases <ArrowUpRight size={14} /></button></div>
        <div className="recent-list">
          {cases.slice(0, 4).map((item) => (
            <button className="recent-case" key={item.id} onClick={() => { setSelectedId(item.id); setTab("cases"); }}>
              <span className={`case-severity severity-${item.severity || "medium"}`} />
              <span className="recent-case-main"><strong>{item.segment}</strong><span>CASE-{String(item.id).padStart(4, "0")} · {item.current_rate}% current rate</span></span>
              <LifecycleChip state={item.lifecycle} /><ChevronRight size={15} className="recent-chevron" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function CaseQueue({ cases, allCases, selectedId, setSelectedId, selectedDetail, caseSearch, setCaseSearch, caseFilter, setCaseFilter, doAction, demo, approveDemo, rejectDemo }) {
  return (
    <div className="case-workspace">
      <aside className="case-sidebar panel">
        <div className="case-sidebar-head"><div><div className="section-kicker"><ListFilter size={14} /> INVESTIGATION QUEUE</div><h3>Flagged segments</h3></div><span className="queue-count">{allCases.length}</span></div>
        <div className="search-field"><Search size={15} /><input value={caseSearch} onChange={(e) => setCaseSearch(e.target.value)} placeholder="Search segments…" aria-label="Search cases" />{caseSearch && <button onClick={() => setCaseSearch("")}><X size={13} /></button>}</div>
        <div className="filter-row">
          {["all", "pending", "approved", "abstained"].map((filter) => <button key={filter} className={caseFilter === filter ? "selected" : ""} onClick={() => setCaseFilter(filter)}>{filter === "all" ? "All" : filter === "abstained" ? "Escalated" : filter[0].toUpperCase() + filter.slice(1)} </button>)}
        </div>
        <div className="case-list">
          {demo?.running && <DemoCaseStream demo={demo} />}
          {cases.length ? cases.map((item) => (
            <button key={item.id} className={`case-list-item ${item.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}>
              <div className="case-list-top"><span className={`case-severity severity-${item.severity || "medium"}`} /><span>CASE-{String(item.id).padStart(4, "0")}</span><ChevronRight size={14} /></div>
              <strong>{item.segment}</strong>
              <div className="case-rate"><ArrowDownRight size={13} />{item.baseline_rate}% <span>→</span> <b>{item.current_rate}%</b><em>{Math.round(item.baseline_rate - item.current_rate)}pt drop</em></div>
              <LifecycleChip state={item.lifecycle} />
            </button>
          )) : <div className="no-results"><Search size={20} /><span>No cases match your filter.</span></div>}
        </div>
        <div className="queue-footnote"><Activity size={13} /> Ranking by severity and revenue impact</div>
      </aside>

      {selectedDetail ? <DiagnosisWorkspace detail={selectedDetail} doAction={doAction} demo={demo} approveDemo={approveDemo} rejectDemo={rejectDemo} /> : (
        <section className="diagnosis-empty panel"><div className="empty-visual"><ListFilter size={23} /></div><h2>Select an investigation</h2><p>Choose a case from the queue to inspect the evidence and recovery recommendation.</p></section>
      )}
    </div>
  );
}

function DemoCaseStream({ demo }) {
  return <div className="demo-case-stream">{DEMO_CASES.map((item, index) => {
    const active = index === demo.activeDemoCase;
    const done = index < demo.activeDemoCase;
    return <div className={`demo-case-row ${active ? "active" : ""} ${done ? "done" : ""}`} key={item.merchant}>
      <div><strong>{item.merchant}</strong><span>{formatCurrency(item.amount)} · {item.reason}</span></div>
      <span className={`demo-row-status ${done ? "recovered" : active ? "retrying" : "queued"}`}>{done ? "RECOVERED" : active ? "RETRYING" : "QUEUED"}</span>
    </div>;
  })}</div>;
}

function DiagnosisWorkspace({ detail, doAction, demo, approveDemo, rejectDemo }) {
  const [agentData, setAgentData] = useState(null);
  
  useEffect(() => {
    if (detail?.id) {
      fetch(`${API_BASE}/api/agent/${detail.id}`)
        .then(res => res.json())
        .then(setAgentData)
        .catch(() => setAgentData(null));
    }
  }, [detail?.id]);

  const topHypothesis = detail.hypotheses?.[0];
  const meta = statusMeta(detail.status, detail.reverted);
  
  const evidenceData = detail.hypotheses?.map(h => {
    const count = h.share || 0;
    const percentage = detail.window_failed ? Math.round((count / detail.window_failed) * 100) : 0;
    const label = CODE_LABEL[h.code] || "Unknown signal";
    const colorMap = {
      otp_timeout: "mint",
      issuer_decline: "blue",
      expired_card: "amber",
      network_error: "coral"
    };
    const color = colorMap[h.code] || "slate";
    return { label, count, percentage, color };
  }) || [];
  return (
    <section className="diagnosis-workspace">
      <div className="diagnosis-header panel">
        <div className="diagnosis-title"><span className="case-id">CASE-{String(detail.id).padStart(4, "0")}</span><h2>{detail.segment}</h2><div className="diagnosis-meta"><span><Database size={13} /> Payment segment</span><span><Clock3 size={13} /> Live case</span></div></div>
        <div className="diagnosis-header-right"><LifecycleChip state={detail.lifecycle} /><Badge status={detail.status} reverted={detail.reverted} /><div className={`severity-label severity-text-${detail.severity || "medium"}`}>{(detail.severity || "medium").toUpperCase()} SEVERITY</div></div>
      </div>

      <div className="evidence-metrics">
        <div><span>BASELINE SUCCESS</span><strong>{detail.baseline_rate}%</strong><small>reference period</small></div>
        <div className="metric-alert"><span>CURRENT SUCCESS</span><strong>{detail.current_rate}%</strong><small><ArrowDownRight size={12} /> active anomaly</small></div>
        <div><span>FAILED IN WINDOW</span><strong>{detail.window_failed}<small className="inline-unit"> / {detail.window_attempts}</small></strong><small>transactions</small></div>
        <div><span>REVENUE AT RISK</span><strong>{formatCurrency(detail.window_failed * detail.avg_amount)}</strong><small>estimated exposure</small></div>
      </div>

      <div className="diagnosis-grid">
        <section className="hypotheses-panel panel">
          <div className="panel-heading"><div><div className="section-kicker"><Sparkles size={14} /> ROOT-CAUSE ANALYSIS</div><h3>Competing hypotheses</h3></div><span className="analysis-status"><span className="live-dot" />ANALYSIS COMPLETE</span></div>
          <p className="panel-description">The engine ranked these candidates from the observed failure-code mix. Lower-ranked causes remain visible for operator context.</p>
          <div className="hypothesis-list">
            {detail.hypotheses.map((hypothesis, index) => (
              <div className={`hypothesis ${hypothesis.ruled_out ? "ruled-out" : index === 0 ? "leading" : ""}`} key={hypothesis.code}>
                <div className="hypothesis-top"><div className="hypothesis-name"><span className="hypothesis-index">0{index + 1}</span><strong>{CODE_LABEL[hypothesis.code]}</strong>{index === 0 && !hypothesis.ruled_out && <span className="leading-chip">LEADING SIGNAL</span>}</div><strong className="hypothesis-percent">{Math.round(hypothesis.confidence * 100)}%</strong></div>
                <ConfidenceBar value={hypothesis.confidence} ruledOut={hypothesis.ruled_out} color={index === 0 ? C.green : C.blue} />
                <div className="hypothesis-reason">{hypothesis.reasoning}</div>
                {hypothesis.ruled_out && <span className="ruled-label">RULED OUT BY EVIDENCE</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="evidence-panel panel">
          <div className="panel-heading"><div><div className="section-kicker"><BarChart3 size={14} /> EVIDENCE</div><h3>Signal composition</h3></div><span className="evidence-count">{evidenceData.length} signals</span></div>
          {evidenceData.length ? (
            <div className="evidence-list">
              {evidenceData.map((evidence, index) => (
                <div key={evidence.label || index} style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: getEvidenceColor(evidence.color) }} />
                      <strong style={{ fontSize: "10px" }}>{evidence.label}</strong>
                    </div>
                    <b style={{ color: "var(--text)", fontSize: "12px", fontFamily: "var(--mono)" }}>{evidence.percentage}%</b>
                  </div>
                  <div className="confidence-track" style={{ height: "4px" }}>
                    <div className="confidence-fill" style={{ width: `${evidence.percentage}%`, background: getEvidenceColor(evidence.color) }} />
                  </div>
                  <span style={{ color: "var(--text-faint)", fontSize: "9px" }}>
                    {evidence.count} failures • {evidence.percentage}% of failed transactions
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="evidence-empty" style={{ opacity: 0.7 }}>
              No evidence available for this investigation window.
            </div>
          )}
          <div className="evidence-foot"><ShieldAlert size={14} /> Scores are transparent and traceable to transaction rows.</div>
        </section>
      </div>

      <section className="recovery-panel panel">
        <div className="recovery-copy"><div className="section-kicker"><Zap size={14} /> OPERATOR GATE</div><h3>Recommended recovery action</h3><p>{detail.diagnosis_summary || (topHypothesis ? ACTION_LABEL[topHypothesis.code] : "No action recommendation available.")}</p><div className="recovery-boundary"><ShieldAlert size={14} />Nothing executes without explicit approval.</div></div>
        <div className="recovery-action">
          <div className="action-label">PROPOSED ACTION</div>
          <strong>{detail.recommendation?.label || (topHypothesis ? ACTION_LABEL[topHypothesis.code] : "Manual review required")}</strong>
          {detail.status === "pending" && !demo?.paused && <div className="operator-actions"><button className="action-button approve" style={btnStyle(C.green, true)} onClick={() => doAction(detail.id, "approve")}><CheckCircle2 size={15} />Approve Recovery</button><button className="action-button reject" style={btnStyle(C.red)} onClick={() => doAction(detail.id, "reject")}><XCircle size={15} />Reject Recovery</button></div>}
          {demo?.caseId === detail.id && demo.paused && <div className="approval-card"><ShieldAlert size={16} /><div><strong>Operator Approval Required</strong><span>The policy gate paused the autonomous run before execution.</span><div className="operator-actions"><button className="action-button approve" style={btnStyle(C.green, true)} onClick={approveDemo}>Approve Recovery</button><button className="action-button reject" style={btnStyle(C.red)} onClick={rejectDemo}>Reject Recovery</button></div></div></div>}
          {detail.status === "abstained" && <div className="abstain-block"><AlertTriangle size={16} /><div><strong>Confidence below the {Math.round(CONFIDENCE_FLOOR * 100)}% automation floor.</strong><span>{detail.abstain_reason || "No automated recovery was attempted. This case was escalated for manual review instead of guessing."}</span><button className="text-button" onClick={() => doAction(detail.id, "mark-reviewed")}>Mark reviewed by ops <ArrowUpRight size={13} /></button></div></div>}
          {detail.status === "approved" && <div className={`outcome-block ${detail.reverted ? "reverted" : ""}`}><Check size={16} /><div><strong>{detail.reverted ? "Recovery reverted" : `${formatCurrency(detail.recovered_amount)} recovered`}</strong><span>{detail.reverted ? "The action was marked ineffective and removed from recovered totals." : `Across ${detail.recovered_tx} transactions · outcome logged`}</span>{!detail.reverted && <button className="text-button" onClick={() => doAction(detail.id, "revert")}><RotateCcw size={13} />Mark ineffective / revert</button>}</div></div>}
          {detail.status === "rejected" && <div className="rejected-note"><XCircle size={16} />No recovery action was taken for this case.</div>}
        </div>
      </section>

      {agentData && (
        <div className="agent-panels">
          <section className="agent-status panel">
            <div className="panel-heading"><div><div className="section-kicker"><Zap size={14} /> AI AGENT STATUS</div><h3>Agent Readiness</h3></div></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div><strong>Status:</strong> {agentData.agent_status}</div>
              <div><strong>Approval Mode:</strong> {agentData.recommended_action?.approval || 'REQUIRED'}</div>
              <div><strong>Retry Limit:</strong> {agentData.recommended_action?.retry_limit || 'N/A'}</div>
              <div><strong>Reversible:</strong> {agentData.recommended_action?.reversible ? 'Yes' : 'No'}</div>
            </div>
          </section>

          <section className="agent-reasoning panel">
            <div className="panel-heading"><div><div className="section-kicker"><Sparkles size={14} /> AGENT REASONING</div><h3>Structured Reasoning</h3></div></div>
            <div className="reasoning-steps">
              {[['Step 1', 'Primary diagnosis', agentData.primary_diagnosis], ['Step 2', 'Confidence score', `${Math.round((agentData.confidence || 0) * 100)}%`], ['Step 3', 'Evidence summary', agentData.reasoning?.summary], ['Step 4', 'Recovery policy', agentData.recommended_action?.action], ['Step 5', 'Final recommendation', agentData.reasoning?.explanation]].map(([step, label, value], index) => <div className={`reasoning-step ${!demo || demo.caseId !== detail.id || demo.index >= index + 2 ? 'revealed' : ''}`} key={step}><span>{step}</span><div><strong>{label}</strong><p>{value || 'Pending agent analysis…'}</p></div></div>)}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div><strong>Strength:</strong> {agentData.reasoning?.evidence_strength}</div>
                <div><strong>Count:</strong> {agentData.reasoning?.evidence_count}</div>
                <div><strong>Percentage:</strong> {agentData.reasoning?.evidence_percentage}%</div>
                <div><strong>Blast Radius:</strong> {agentData.reasoning?.blast_radius}</div>
              </div>
            </div>
          </section>

          <section className="agent-projection panel">
            <div className="panel-heading"><div><div className="section-kicker"><BarChart3 size={14} /> RECOVERY PROJECTION</div><h3>Expected Outcome</h3></div></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div><strong>Revenue at Risk:</strong> {formatCurrency(agentData.revenue_projection?.at_risk)}</div>
              <div><strong>Expected Recovery Rate:</strong> {Math.round((agentData.revenue_projection?.expected_recovery_rate || 0) * 100)}%</div>
              <div><strong>Recoverable Amount:</strong> {formatCurrency(agentData.revenue_projection?.recoverable)}</div>
            </div>
          </section>
        </div>
      )}

      {demo?.caseId === detail.id && demo.activeDemoCase >= 0 && <DemoDecisionCard demo={demo} />}
      {demo?.caseId === detail.id && <LiveAgentActivity demo={demo} />}

      <div className="detail-footer-note"><span className={`footer-status-dot status-${meta.tone}`} />{meta.label} · all actions are written to the audit trail</div>
    </section>
  );
}

function LiveAgentActivity({ demo }) {
  const visible = demo.events || [];
  return <section className="live-activity panel">
    <div className="panel-heading"><div><div className="section-kicker"><Activity size={14} /> LIVE AGENT ACTIVITY</div><h3>Autonomous investigation stream</h3></div><span className="confidence-chip"><span className="live-dot" />{demo.running ? "STREAMING" : "COMPLETE"}</span></div>
    <div className="activity-list">{visible.map((item, index) => <div className="activity-item" key={`${item.time}-${index}`}><span className={`activity-icon status-${lifecycleMeta(item.state).tone}`}><Check size={13} /></span><span className="activity-time">{item.time}</span><span>{item.message}</span></div>)}{demo.running && !demo.paused && <div className="activity-item activity-pending"><span className="activity-icon status-blue"><Loader2 size={13} className="spin" /></span><span>Agent is evaluating the next investigation step…</span></div>}</div>
    {demo.targetTx > 0 && <div className="execution-simulation"><div className="execution-row"><span>Recovered Transactions</span><b>{demo.recoveredTx} <em>/ {demo.targetTx}</em></b></div><div className="execution-track"><i style={{ width: `${demo.progress * 100}%` }} /></div><div className="execution-row"><span>Recovered Revenue</span><b>{formatCurrency(demo.recoveredAmount)} <em>/ {formatCurrency(demo.targetAmount)}</em></b></div></div>}
  </section>;
}

function DemoDecisionCard({ demo }) {
  const item = DEMO_CASES[demo.activeDemoCase];
  if (!item) return null;
  return <section className="demo-decision panel"><div className="section-kicker"><BrainCircuit size={14} /> AI DECISION TRACE · {item.merchant.toUpperCase()}</div><div className="decision-grid"><div><span>ISSUE DETECTED</span><strong>Payment failed due to {item.reason.toLowerCase()}.</strong></div><div><span>ROOT CAUSE</span><strong>High latency detected on primary gateway.</strong><small>Confidence: {item.confidence}%</small></div><div><span>AI RECOVERY STRATEGY</span><strong>{item.strategy}. Retry after predicted optimal interval.</strong></div><div><span>AGENT SIGNAL</span><strong className="decision-state">{demo.phase === "RETRYING" ? "Payment recovered" : "Sending retry…"}</strong></div></div></section>;
}

function AuditTrail({ cases, demo }) {
  const resolved = cases.filter((item) => item.status !== "pending").length;
  return (
    <div className="audit-layout">
      <aside className="audit-summary panel">
        <div className="section-kicker"><FileClock size={14} /> REPLAY CENTER</div>
        <h2>Decision history</h2>
        <p>Follow the full chain from anomaly detection to operator outcome. Nothing is hidden behind a single score.</p>
        <div className="audit-total"><strong>{cases.length}</strong><span>total cases logged</span></div>
        <div className="audit-summary-row"><span><span className="summary-dot green" />Resolved</span><b>{resolved}</b></div>
        <div className="audit-summary-row"><span><span className="summary-dot amber" />Escalated</span><b>{cases.filter((item) => item.status === "abstained" || item.status === "escalated-reviewed").length}</b></div>
        <div className="audit-summary-row"><span><span className="summary-dot blue" />Awaiting action</span><b>{cases.filter((item) => item.status === "pending").length}</b></div>
        <div className="audit-privacy"><ShieldAlert size={14} /><span>Immutable session log<br /><b>Every event is operator-attributed</b></span></div>
      </aside>
      <div className="audit-feed">
        <div className="audit-feed-head"><div><div className="section-kicker"><Activity size={14} /> CHRONOLOGICAL FEED</div><h3>Investigation timeline</h3></div><span className="confidence-chip"><span className="live-dot" />LIVE LOG</span></div>
        {demo && <LiveAgentActivity demo={demo} />}
        {cases.map((item) => <AuditCard key={item.id} caseId={item.id} summary={item} />)}
      </div>
    </div>
  );
}

function RecoverySummary({ demo, batchId, onClose }) {
  const confidence = Math.round(demo?.agent?.confidence * 100 || 93);
  return <div className="summary-overlay"><section className="summary-modal panel">
    <div className="section-kicker"><BrainCircuit size={14} /> AI RECOVERY COMPLETE</div>
    <h2>Recovery Summary — Batch #{String(batchId).padStart(4, "0")}</h2>
    <p className="panel-description">The autonomous recovery loop completed and the audit trail is synchronized.</p>
    <div className="summary-grid"><div><span>REVENUE RECOVERED</span><strong>{formatCurrency(demo.recoveredAmount)}</strong></div><div><span>TRANSACTIONS RECOVERED</span><strong>{demo.recoveredTx}</strong></div><div><span>RECOVERY SUCCESS RATE</span><strong>{confidence}%</strong></div><div><span>REMAINING AT RISK</span><strong>{formatCurrency(Math.max(0, demo.targetAmount - demo.recoveredAmount))}</strong></div></div>
    <div className="summary-recommendation"><strong>AI Recommendation</strong><p>Enable adaptive retries between 6–9 PM for affected PSPs. Estimated additional recoverable revenue: ₹38,000/day.</p><span>Top strategy: {DEMO_CASES[1].strategy} · {confidence}% AI confidence</span></div>
    <button className="action-button primary" onClick={onClose}>Continue monitoring <ArrowUpRight size={14} /></button>
  </section></div>;
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
    <article className="audit-card panel">
      <div className="audit-card-head"><div className="audit-card-title"><span className="case-id">CASE-{String(caseId).padStart(4, "0")}</span><h3>{summary.segment}</h3><span className="audit-card-rate">{summary.baseline_rate}% <ArrowDownRight size={12} /> {summary.current_rate}%</span></div><LifecycleChip state={summary.lifecycle} /></div>
      <div className="timeline">
        {detail ? detail.timeline.map((t, i) => { const base = new Date(detail.timeline[0]?.ts || t.ts); base.setSeconds(base.getSeconds() + i * 3); return <TimelineEntry key={i} ts={base.toLocaleTimeString([], { hour12: false })} text={t.event} index={i} />; }) : <div className="timeline-loading"><Loader2 size={15} className="spin" />Loading timeline…</div>}
      </div>
    </article>
  );
}
