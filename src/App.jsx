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
  Sparkles, TrendingDown, Upload, X, XCircle, Zap
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

function formatCurrency(value) {
  return `₹${Math.round(value || 0).toLocaleString("en-IN")}`;
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

function Badge({ status, reverted = false }) {
  const meta = statusMeta(status, reverted);
  return <span className={`status-pill status-${meta.tone}`}><span className="status-dot" />{meta.label}</span>;
}

function Stamp({ status, reverted = false }) {
  const meta = statusMeta(status, reverted);
  return <div className={`audit-stamp stamp-${meta.tone}`}>{meta.label}</div>;
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
              <Overview chart={chart} metrics={metrics} cases={cases} healthScore={healthScore} setTab={setTab} setSelectedId={setSelectedId} />
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
                doAction={doAction}
              />
            )}
            {tab === "audit" && <AuditTrail cases={cases} />}
          </>
        )}
      </main>
    </div>
  );
}

function Overview({ chart, metrics, cases, healthScore, setTab, setSelectedId }) {
  const queueCount = cases.filter((item) => item.status === "pending").length;
  return (
    <div className="overview-grid">
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

      <section className="metrics-row">
        <MetricCard icon={IndianRupee} label="RECOVERED" value={formatCurrency(metrics.recovered)} sub={`of ${formatCurrency(metrics.recoverable)} at risk`} color={C.green} trend="+12.4%" />
        <MetricCard icon={CheckCircle2} label="RESOLUTION RATE" value={`${metrics.resolution_rate}%`} sub="cases with an operator decision" color={C.blue} />
        <MetricCard icon={AlertTriangle} label="HONEST ESCALATIONS" value={`${metrics.escalation_rate}%`} sub="abstained rather than guessed" color={C.amber} />
        <MetricCard icon={TrendingDown} label="FLAGGED SEGMENTS" value={metrics.flagged_segments} sub="anomalies this batch" color={C.red} trend={metrics.flagged_segments ? `${metrics.flagged_segments} active` : "0 active"} />
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
              <Badge status={item.status} reverted={item.reverted} /><ChevronRight size={15} className="recent-chevron" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function CaseQueue({ cases, allCases, selectedId, setSelectedId, selectedDetail, caseSearch, setCaseSearch, caseFilter, setCaseFilter, doAction }) {
  return (
    <div className="case-workspace">
      <aside className="case-sidebar panel">
        <div className="case-sidebar-head"><div><div className="section-kicker"><ListFilter size={14} /> INVESTIGATION QUEUE</div><h3>Flagged segments</h3></div><span className="queue-count">{allCases.length}</span></div>
        <div className="search-field"><Search size={15} /><input value={caseSearch} onChange={(e) => setCaseSearch(e.target.value)} placeholder="Search segments…" aria-label="Search cases" />{caseSearch && <button onClick={() => setCaseSearch("")}><X size={13} /></button>}</div>
        <div className="filter-row">
          {["all", "pending", "approved", "abstained"].map((filter) => <button key={filter} className={caseFilter === filter ? "selected" : ""} onClick={() => setCaseFilter(filter)}>{filter === "all" ? "All" : filter === "abstained" ? "Escalated" : filter[0].toUpperCase() + filter.slice(1)} </button>)}
        </div>
        <div className="case-list">
          {cases.length ? cases.map((item) => (
            <button key={item.id} className={`case-list-item ${item.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}>
              <div className="case-list-top"><span className={`case-severity severity-${item.severity || "medium"}`} /><span>CASE-{String(item.id).padStart(4, "0")}</span><ChevronRight size={14} /></div>
              <strong>{item.segment}</strong>
              <div className="case-rate"><ArrowDownRight size={13} />{item.baseline_rate}% <span>→</span> <b>{item.current_rate}%</b><em>{Math.round(item.baseline_rate - item.current_rate)}pt drop</em></div>
              <Badge status={item.status} reverted={item.reverted} />
            </button>
          )) : <div className="no-results"><Search size={20} /><span>No cases match your filter.</span></div>}
        </div>
        <div className="queue-footnote"><Activity size={13} /> Ranking by severity and revenue impact</div>
      </aside>

      {selectedDetail ? <DiagnosisWorkspace detail={selectedDetail} doAction={doAction} /> : (
        <section className="diagnosis-empty panel"><div className="empty-visual"><ListFilter size={23} /></div><h2>Select an investigation</h2><p>Choose a case from the queue to inspect the evidence and recovery recommendation.</p></section>
      )}
    </div>
  );
}

function DiagnosisWorkspace({ detail, doAction }) {
  const topHypothesis = detail.hypotheses?.[0];
  const meta = statusMeta(detail.status, detail.reverted);
  return (
    <section className="diagnosis-workspace">
      <div className="diagnosis-header panel">
        <div className="diagnosis-title"><span className="case-id">CASE-{String(detail.id).padStart(4, "0")}</span><h2>{detail.segment}</h2><div className="diagnosis-meta"><span><Database size={13} /> Payment segment</span><span><Clock3 size={13} /> Live case</span></div></div>
        <div className="diagnosis-header-right"><Badge status={detail.status} reverted={detail.reverted} /><div className={`severity-label severity-text-${detail.severity || "medium"}`}>{(detail.severity || "medium").toUpperCase()} SEVERITY</div></div>
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
          <div className="panel-heading"><div><div className="section-kicker"><BarChart3 size={14} /> EVIDENCE</div><h3>Signal composition</h3></div><span className="evidence-count">{detail.evidence?.length || 0} signals</span></div>
          {(detail.evidence || []).length ? <div className="evidence-list">{detail.evidence.map((evidence, index) => <div className="evidence-row" key={evidence.code || index}><div className="evidence-marker" style={{ background: SEGMENT_LINE_COLORS[index % SEGMENT_LINE_COLORS.length] }} /><div><strong>{CODE_LABEL[evidence.code] || evidence.code}</strong><span>{evidence.count} observed failures</span></div><b>{Math.round(evidence.share * 100)}%</b></div>)}</div> : <div className="evidence-empty">Evidence detail is not available for this case.</div>}
          <div className="evidence-foot"><ShieldAlert size={14} /> Scores are transparent and traceable to transaction rows.</div>
        </section>
      </div>

      <section className="recovery-panel panel">
        <div className="recovery-copy"><div className="section-kicker"><Zap size={14} /> OPERATOR GATE</div><h3>Recommended recovery action</h3><p>{detail.diagnosis_summary || (topHypothesis ? ACTION_LABEL[topHypothesis.code] : "No action recommendation available.")}</p><div className="recovery-boundary"><ShieldAlert size={14} />Nothing executes without explicit approval.</div></div>
        <div className="recovery-action">
          <div className="action-label">PROPOSED ACTION</div>
          <strong>{detail.recommendation?.label || (topHypothesis ? ACTION_LABEL[topHypothesis.code] : "Manual review required")}</strong>
          {detail.status === "pending" && <div className="operator-actions"><button className="action-button approve" style={btnStyle(C.green, true)} onClick={() => doAction(detail.id, "approve")}><CheckCircle2 size={15} />Approve recovery</button><button className="action-button reject" style={btnStyle(C.red)} onClick={() => doAction(detail.id, "reject")}><XCircle size={15} />Reject</button></div>}
          {detail.status === "abstained" && <div className="abstain-block"><AlertTriangle size={16} /><div><strong>Confidence below the {Math.round(CONFIDENCE_FLOOR * 100)}% automation floor.</strong><span>{detail.abstain_reason || "No automated recovery was attempted. This case was escalated for manual review instead of guessing."}</span><button className="text-button" onClick={() => doAction(detail.id, "mark-reviewed")}>Mark reviewed by ops <ArrowUpRight size={13} /></button></div></div>}
          {detail.status === "approved" && <div className={`outcome-block ${detail.reverted ? "reverted" : ""}`}><Check size={16} /><div><strong>{detail.reverted ? "Recovery reverted" : `${formatCurrency(detail.recovered_amount)} recovered`}</strong><span>{detail.reverted ? "The action was marked ineffective and removed from recovered totals." : `Across ${detail.recovered_tx} transactions · outcome logged`}</span>{!detail.reverted && <button className="text-button" onClick={() => doAction(detail.id, "revert")}><RotateCcw size={13} />Mark ineffective / revert</button>}</div></div>}
          {detail.status === "rejected" && <div className="rejected-note"><XCircle size={16} />No recovery action was taken for this case.</div>}
        </div>
      </section>

      <div className="detail-footer-note"><span className={`footer-status-dot status-${meta.tone}`} />{meta.label} · all actions are written to the audit trail</div>
    </section>
  );
}

function AuditTrail({ cases }) {
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
        {cases.map((item) => <AuditCard key={item.id} caseId={item.id} summary={item} />)}
      </div>
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
    <article className="audit-card panel">
      <div className="audit-card-head"><div className="audit-card-title"><span className="case-id">CASE-{String(caseId).padStart(4, "0")}</span><h3>{summary.segment}</h3><span className="audit-card-rate">{summary.baseline_rate}% <ArrowDownRight size={12} /> {summary.current_rate}%</span></div><Stamp status={summary.status} reverted={summary.reverted} /></div>
      <div className="timeline">
        {detail ? detail.timeline.map((t, i) => <TimelineEntry key={i} ts={new Date(t.ts).toLocaleString()} text={t.event} index={i} />) : <div className="timeline-loading"><Loader2 size={15} className="spin" />Loading timeline…</div>}
      </div>
    </article>
  );
}