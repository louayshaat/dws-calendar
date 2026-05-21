import { useState, useRef, useCallback, useEffect } from "react";

// ─── Palette & shared styles ───────────────────────────────────────────────
const C = {
  bg: "#0a0c10", surface: "#111318", border: "#1e2330", borderBright: "#2a3347",
  accent: "#00d4ff", accentDim: "#0099bb", green: "#00e676", yellow: "#ffc107",
  red: "#ff5252", muted: "#4a5568", text: "#e2e8f0", textDim: "#8892a4",
  fontMono: "'JetBrains Mono', 'Fira Mono', monospace",
  fontUI:   "'DM Sans', 'Segoe UI', sans-serif",
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${C.bg}; color: ${C.text}; font-family: ${C.fontUI}; min-height: 100vh; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: ${C.surface}; }
  ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
  @keyframes pulse-ring {
    0%   { box-shadow: 0 0 0 0 ${C.accent}44; }
    70%  { box-shadow: 0 0 0 10px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  @keyframes fadeSlideIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  @keyframes spin  { to { transform: rotate(360deg); } }
  @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }
`;

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month:"short", day:"numeric", year:"numeric",
      hour:"2-digit", minute:"2-digit", timeZoneName:"short",
    });
  } catch { return iso; }
}

const FALLBACK_REGIONS = [
  "us-central1","us-east1","us-east4","us-east5","us-south1","us-west1",
  "us-west2","us-west3","us-west4","northamerica-northeast1","northamerica-northeast2",
  "southamerica-east1","southamerica-west1","europe-central2","europe-north1",
  "europe-southwest1","europe-west1","europe-west2","europe-west3","europe-west4",
  "europe-west6","europe-west8","europe-west9","europe-west10","europe-west12",
  "asia-east1","asia-east2","asia-northeast1","asia-northeast2","asia-northeast3",
  "asia-south1","asia-south2","asia-southeast1","asia-southeast2",
  "australia-southeast1","australia-southeast2","me-central1","me-central2",
  "me-west1","africa-south1",
];

// ─── Reusable components ───────────────────────────────────────────────────
function Field({ label, hint, children }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <label style={{ fontSize:11, fontWeight:600, letterSpacing:"0.1em",
        textTransform:"uppercase", color:C.textDim }}>{label}</label>
      {children}
      {hint && <span style={{ fontSize:11, color:C.muted }}>{hint}</span>}
    </div>
  );
}

const inputStyle = {
  background:"#0d1018", border:`1px solid ${C.border}`, borderRadius:6,
  color:C.text, fontFamily:C.fontMono, fontSize:13, padding:"9px 12px",
  outline:"none", transition:"border-color 0.2s", width:"100%",
};

function Input({ style, ...props }) {
  const [f,setF] = useState(false);
  return <input {...props}
    onFocus={e=>{setF(true);props.onFocus?.(e);}}
    onBlur={e=>{setF(false);props.onBlur?.(e);}}
    style={{...inputStyle, borderColor:f?C.accent:C.border,
      boxShadow:f?`0 0 0 2px ${C.accent}22`:"none", ...style}} />;
}

function Select({ children, style, ...props }) {
  const [f,setF] = useState(false);
  return (
    <select {...props} onFocus={()=>setF(true)} onBlur={()=>setF(false)}
      style={{...inputStyle, cursor:"pointer", borderColor:f?C.accent:C.border,
        boxShadow:f?`0 0 0 2px ${C.accent}22`:"none", ...style}}>
      {children}
    </select>
  );
}

function StatusBadge({ status }) {
  const map = {
    available:{ color:C.green,  bg:`${C.green}18`,  label:"AVAILABLE"     },
    empty:    { color:C.yellow, bg:`${C.yellow}18`, label:"NO CAPACITY"   },
    error:    { color:C.red,    bg:`${C.red}18`,    label:"NOT SUPPORTED" },
    checking: { color:C.accent, bg:`${C.accent}18`, label:"CHECKING…"     },
  };
  const s = map[status] || map.error;
  return (
    <span style={{ fontFamily:C.fontMono, fontSize:10, fontWeight:600,
      letterSpacing:"0.08em", padding:"3px 8px", borderRadius:4,
      color:s.color, background:s.bg, border:`1px solid ${s.color}44` }}>
      {s.label}
    </span>
  );
}

function Spinner() {
  return <span style={{ display:"inline-block", width:13, height:13,
    border:`2px solid ${C.accent}44`, borderTopColor:C.accent, borderRadius:"50%",
    animation:"spin 0.7s linear infinite", verticalAlign:"middle", marginRight:6 }} />;
}

function ProgressBar({ done, total }) {
  const pct = total > 0 ? (done/total)*100 : 0;
  return (
    <div style={{ width:"100%", height:3, background:C.border, borderRadius:2 }}>
      <div style={{ height:"100%", borderRadius:2, width:`${pct}%`, transition:"width 0.3s ease",
        background:`linear-gradient(90deg, ${C.accentDim}, ${C.accent})`,
        boxShadow:`0 0 8px ${C.accent}88` }} />
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  // Search params (no token / project — handled by backend)
  const [nodes,        setNodes]        = useState("1");
  const [days,         setDays]         = useState("7");
  const [acceleratorId,setAcceleratorId]= useState("a3-ultragpu-8g");
  const [workloadType, setWorkloadType] = useState("BATCH");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
  const [endOffset,    setEndOffset]    = useState("60");
  const [regionFilter, setRegionFilter] = useState("all");

  // Server-supplied config
  const [projectId,    setProjectId]    = useState(null);
  const [accelerators, setAccelerators] = useState([]);
  const [configError,  setConfigError]  = useState(null);

  // Runtime
  const [running,  setRunning]  = useState(false);
  const [results,  setResults]  = useState([]);
  const [progress, setProgress] = useState({ done:0, total:0 });
  const [log,      setLog]      = useState([]);
  const abortRef = useRef(false);

  const addLog = useCallback((msg, type="info") => {
    setLog(l => [...l.slice(-200), { msg, type, t:Date.now() }]);
  }, []);

  // The currently-selected accelerator object (for kind, note, workload flag)
  const selected = accelerators.find(a => a.id === acceleratorId) || null;
  const isTpu    = selected?.kind === "tpu";
  const needsWorkload = !!selected?.needsWorkloadType;

  // Load config from backend on mount
  useEffect(() => {
    fetch("/api/config")
      .then(r => r.json())
      .then(d => {
        setProjectId(d.projectId);
        setAccelerators(d.accelerators || []);
        if (d.accelerators?.[0]) setAcceleratorId(d.accelerators[0].id);
      })
      .catch(() => setConfigError("Cannot reach backend. Is the server running?"));
  }, []);

  async function getRegions() {
    try {
      const r = await fetch("/api/regions");
      if (!r.ok) throw new Error();
      const d = await r.json();
      return d.regions || FALLBACK_REGIONS;
    } catch {
      addLog("Could not fetch regions from backend — using built-in list.", "warn");
      return FALLBACK_REGIONS;
    }
  }

  function applyFilter(regions) {
    if (regionFilter === "all") return regions;
    const prefix = regionFilter === "us" ? "us-"
      : regionFilter === "europe" ? "europe-"
      : regionFilter === "asia"   ? "asia-" : "";
    return regions.filter(r => r.startsWith(prefix));
  }

  async function run() {
    setRunning(true);
    setResults([]);
    setLog([]);
    abortRef.current = false;

    const duration  = `${parseInt(days,10) * 86400}s`;
    const now       = new Date();
    // startDate is YYYY-MM-DD; treat as midnight UTC so the full day is available
    const startTime = new Date(startDate + "T00:00:00Z").toISOString().replace(".000Z", "Z");
    const endTime   = new Date(now.getTime() + parseInt(endOffset, 10)*86400000).toISOString().replace(".000Z","Z");

    const label = selected?.label || acceleratorId;
    const unit  = isTpu ? "chip(s)" : "instance(s)";
    addLog(`Starting search — ${nodes} ${unit} of ${label} for ${days} day(s)`, "info");
    if (needsWorkload) addLog(`Workload type: ${workloadType}`, "info");
    addLog(`Window: ${startTime} → ${endTime}`, "info");

    const rawRegions = await getRegions();
    const allRegions = applyFilter(rawRegions);

    setProgress({ done:0, total:allRegions.length });
    addLog(`Scanning ${allRegions.length} region(s)…`, "info");
    setResults(allRegions.map(r => ({ region:r, status:"checking", earliest:null, msg:"" })));

    for (let i = 0; i < allRegions.length; i++) {
      if (abortRef.current) { addLog("Search cancelled.", "warn"); break; }

      const region = allRegions[i];
      try {
        const payload = {
          region, acceleratorId,
          kind: selected?.kind || "gpu",
          nodes, startTime, endTime, duration,
        };
        if (needsWorkload) payload.workloadType = workloadType;

        const res  = await fetch("/api/check", {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (data.status === "available") {
          const zoneStr = data.zones?.length ? ` [${data.zones.join(", ")}]` : "";
          addLog(`${region}: ✓ AVAILABLE — earliest ${fmtDate(data.earliest)}${zoneStr}`, "success");
          setResults(r => r.map(x => x.region===region ? {...x, status:"available", earliest:data.earliest, zones:data.zones||[]} : x));
        } else if (data.status === "error") {
          addLog(`${region}: ✗ ${data.message}`, "error");
          setResults(r => r.map(x => x.region===region ? {...x, status:"error", msg:data.message} : x));
        } else {
          addLog(`${region}: ~ No capacity in window`, "warn");
          setResults(r => r.map(x => x.region===region ? {...x, status:"empty"} : x));
        }
      } catch (err) {
        addLog(`${region}: ✗ Network error — ${err.message}`, "error");
        setResults(r => r.map(x => x.region===region ? {...x, status:"error", msg:err.message} : x));
      }

      setProgress({ done:i+1, total:allRegions.length });
      await new Promise(res => setTimeout(res, 60));
    }

    setRunning(false);
    addLog("Search complete.", "info");
  }

  function stop() { abortRef.current = true; }

  const available = results.filter(r => r.status==="available");
  const pct = progress.total > 0 ? Math.round(progress.done/progress.total*100) : 0;

  return (
    <>
      <style>{css}</style>
      <div style={{ minHeight:"100vh", background:C.bg, padding:"24px 16px" }}>

        {/* Header */}
        <div style={{ maxWidth:960, margin:"0 auto 28px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:6 }}>
            <div style={{ width:36, height:36, borderRadius:8,
              background:`linear-gradient(135deg, ${C.accentDim}, ${C.accent})`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:18, boxShadow:`0 0 20px ${C.accent}55` }}>⚡</div>
            <div>
              <h1 style={{ fontFamily:C.fontMono, fontSize:18, fontWeight:600,
                color:C.text, letterSpacing:"-0.02em" }}>
                DWS Calendar Mode Search
              </h1>
              <p style={{ fontSize:12, color:C.textDim, marginTop:2 }}>
                GCP Accelerator Capacity · Dynamic Workload Scheduler
                {projectId && (
                  <span style={{ marginLeft:10, color:C.accent, fontFamily:C.fontMono }}>
                    [{projectId}]
                  </span>
                )}
              </p>
            </div>
          </div>
          <div style={{ height:1, background:`linear-gradient(90deg, ${C.accent}44, transparent)` }} />
        </div>

        {/* Config error banner */}
        {configError && (
          <div style={{ maxWidth:960, margin:"0 auto 16px", background:`${C.red}15`,
            border:`1px solid ${C.red}44`, borderRadius:8, padding:"10px 16px",
            fontSize:12, color:C.red }}>
            ⚠ {configError}
          </div>
        )}

        <div style={{ maxWidth:960, margin:"0 auto", display:"grid",
          gridTemplateColumns:"300px 1fr", gap:16, alignItems:"start" }}>

          {/* Config Panel — no auth fields */}
          <div style={{ background:C.surface, border:`1px solid ${C.border}`,
            borderRadius:12, padding:20, display:"flex", flexDirection:"column", gap:18 }}>

            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.12em",
              textTransform:"uppercase", color:C.accent }}>Search Parameters</div>

            <Field label="Accelerator">
              <Select value={acceleratorId} onChange={e => setAcceleratorId(e.target.value)}>
                {accelerators.length === 0 && (
                  <option value="a3-ultragpu-8g">H200 (A3 Ultra) ×8</option>
                )}
                {accelerators.some(a => a.kind === "gpu") && (
                  <optgroup label="GPUs (8-GPU shapes)">
                    {accelerators.filter(a => a.kind === "gpu").map(a => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </optgroup>
                )}
                {accelerators.some(a => a.kind === "tpu") && (
                  <optgroup label="TPUs">
                    {accelerators.filter(a => a.kind === "tpu").map(a => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </Field>

            {/* Caveat note for the selected accelerator */}
            {selected?.note && (
              <div style={{ marginTop:-8, fontSize:11, color:C.yellow,
                background:`${C.yellow}10`, border:`1px solid ${C.yellow}33`,
                borderRadius:6, padding:"6px 10px", lineHeight:1.5 }}>
                ⚠ {selected.note}
              </div>
            )}

            {/* TPU v5e workload type — only shown when required */}
            {needsWorkload && (
              <Field label="Workload Type" hint="Required for TPU v5e">
                <Select value={workloadType} onChange={e => setWorkloadType(e.target.value)}>
                  <option value="BATCH">BATCH — training / bulk</option>
                  <option value="SERVING">SERVING — inference (1, 4, or 8 chips)</option>
                </Select>
              </Field>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <Field label={isTpu ? "Chips" : "Nodes"} hint={isTpu ? "TPU chip count" : "VM instances"}>
                <Input type="number" min="1" max="512"
                  value={nodes} onChange={e => setNodes(e.target.value)} />
              </Field>
              <Field label="Duration (days)" hint="Reservation">
                <Input type="number" min="1" max="365"
                  value={days} onChange={e => setDays(e.target.value)} />
              </Field>
            </div>

            <div style={{ height:1, background:C.border }} />
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.12em",
              textTransform:"uppercase", color:C.textDim }}>Time Window</div>

            <Field label="Start Date" hint="Earliest start date for the reservation (DWS requires ≥ 87h from now)">
              <Input
                type="date"
                value={startDate}
                min={(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0,10); })()}
                onChange={e => setStartDate(e.target.value)}
              />
            </Field>

            <Field label="End offset (days)" hint="How many days ahead to search (max 60)">
              <Input type="number" min="1" max="60"
                value={endOffset} onChange={e => setEndOffset(e.target.value)} />
            </Field>

            <Field label="Region Filter">
              <Select value={regionFilter} onChange={e => setRegionFilter(e.target.value)}>
                <option value="all">All Regions</option>
                <option value="us">US only</option>
                <option value="europe">Europe only</option>
                <option value="asia">Asia only</option>
              </Select>
            </Field>

            <button onClick={running ? stop : run}
              style={{ padding:"11px 0", borderRadius:8, border:"none", cursor:"pointer",
                fontFamily:C.fontMono, fontSize:13, fontWeight:600, letterSpacing:"0.05em",
                background: running ? `${C.red}22` : `linear-gradient(135deg, ${C.accentDim}, ${C.accent})`,
                color: running ? C.red : C.bg,
                border: running ? `1px solid ${C.red}66` : "none",
                boxShadow: running ? "none" : `0 0 20px ${C.accent}44`,
                transition:"all 0.2s",
                animation: running ? "" : "pulse-ring 2s infinite" }}>
              {running ? "⏹  Stop Search" : "▶  Run Search"}
            </button>
          </div>

          {/* Results Panel */}
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

            {results.length > 0 && (
              <div style={{ background:C.surface, border:`1px solid ${C.border}`,
                borderRadius:12, padding:"14px 18px", display:"flex", gap:24,
                alignItems:"center", animation:"fadeSlideIn 0.3s ease" }}>
                {running && <Spinner />}
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", justifyContent:"space-between",
                    marginBottom:6, fontSize:12 }}>
                    <span style={{ color:C.textDim }}>
                      {running ? `Scanning… ${progress.done} / ${progress.total}` : "Scan complete"}
                    </span>
                    <span style={{ fontFamily:C.fontMono, color:C.accent }}>{pct}%</span>
                  </div>
                  <ProgressBar done={progress.done} total={progress.total} />
                </div>
                <div style={{ display:"flex", gap:16, fontSize:12 }}>
                  {[
                    { color:C.green,  label:"Available", count:results.filter(r=>r.status==="available").length },
                    { color:C.yellow, label:"No Cap.",   count:results.filter(r=>r.status==="empty").length },
                    { color:C.red,    label:"Errors",    count:results.filter(r=>r.status==="error").length },
                    { color:C.accent, label:"Checking",  count:results.filter(r=>r.status==="checking").length },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign:"center" }}>
                      <div style={{ fontFamily:C.fontMono, fontSize:18, fontWeight:700, color:s.color }}>{s.count}</div>
                      <div style={{ color:C.muted, fontSize:10 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {available.length > 0 && (
              <div style={{ background:`${C.green}0c`, border:`1px solid ${C.green}33`,
                borderRadius:12, padding:16, animation:"fadeSlideIn 0.3s ease" }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em",
                  textTransform:"uppercase", color:C.green, marginBottom:10 }}>
                  ✓ Capacity Found — {available.length} Region{available.length>1?"s":""}
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {available.map(r => (
                    <div key={r.region} style={{ background:`${C.green}08`,
                      border:`1px solid ${C.green}22`, borderRadius:8, padding:"8px 12px" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontFamily:C.fontMono, fontSize:13, color:C.green, fontWeight:600 }}>
                          {r.region}
                        </span>
                        <span style={{ fontSize:12, color:C.textDim }}>{fmtDate(r.earliest)}</span>
                      </div>
                      {r.zones?.length > 0 && (
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:6 }}>
                          {r.zones.map(z => (
                            <span key={z} style={{ fontFamily:C.fontMono, fontSize:10,
                              background:`${C.accent}18`, border:`1px solid ${C.accent}33`,
                              color:C.accent, borderRadius:4, padding:"2px 7px" }}>
                              {z}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {results.length > 0 && (
              <div style={{ background:C.surface, border:`1px solid ${C.border}`,
                borderRadius:12, overflow:"hidden" }}>
                <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`,
                  fontSize:11, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase",
                  color:C.textDim, display:"grid", gridTemplateColumns:"1fr 130px 1fr 1fr", gap:12 }}>
                  <span>Region</span><span>Status</span><span>Earliest Available</span><span>Zones</span>
                </div>
                <div style={{ maxHeight:420, overflowY:"auto" }}>
                  {results.map((r,i) => (
                    <div key={r.region} style={{ display:"grid",
                      gridTemplateColumns:"1fr 130px 1fr 1fr", gap:12,
                      padding:"9px 16px", alignItems:"center",
                      borderBottom: i<results.length-1 ? `1px solid ${C.border}` : "none",
                      background: r.status==="available" ? `${C.green}07`
                        : r.status==="checking" ? `${C.accent}05` : "transparent",
                      animation:"fadeSlideIn 0.2s ease" }}>
                      <span style={{ fontFamily:C.fontMono, fontSize:12,
                        color: r.status==="available" ? C.green
                          : r.status==="checking" ? C.accent
                          : r.status==="error" ? C.red : C.textDim }}>
                        {r.status==="checking" && <Spinner />}{r.region}
                      </span>
                      <StatusBadge status={r.status} />
                      <span style={{ fontSize:12, color:C.textDim, fontFamily:C.fontMono }}>
                        {r.status==="available" ? fmtDate(r.earliest)
                          : r.status==="error" ? <span style={{color:C.red,fontSize:11}}>{r.msg?.slice(0,60)}</span>
                          : r.status==="checking" ? <span style={{color:C.accent,animation:"blink 1s infinite"}}>…</span>
                          : "—"}
                      </span>
                      <span style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
                        {r.status==="available" && r.zones?.map(z => (
                          <span key={z} style={{ fontFamily:C.fontMono, fontSize:10,
                            background:`${C.accent}18`, border:`1px solid ${C.accent}33`,
                            color:C.accent, borderRadius:4, padding:"1px 5px",
                            whiteSpace:"nowrap" }}>
                            {z}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {log.length > 0 && (
              <div style={{ background:"#080a0e", border:`1px solid ${C.border}`,
                borderRadius:12, overflow:"hidden" }}>
                <div style={{ padding:"8px 14px", borderBottom:`1px solid ${C.border}`,
                  fontSize:10, fontWeight:700, letterSpacing:"0.12em",
                  textTransform:"uppercase", color:C.muted }}>Console Log</div>
                <div style={{ maxHeight:180, overflowY:"auto", padding:"10px 14px",
                  display:"flex", flexDirection:"column", gap:3 }}>
                  {log.map((l,i) => (
                    <div key={i} style={{ fontFamily:C.fontMono, fontSize:11,
                      color: l.type==="success"?C.green : l.type==="error"?C.red
                        : l.type==="warn"?C.yellow : C.textDim }}>
                      <span style={{ color:C.muted, marginRight:8 }}>
                        {new Date(l.t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
                      </span>
                      {l.msg}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {results.length === 0 && (
              <div style={{ background:C.surface, border:`1px solid ${C.border}`,
                borderRadius:12, padding:48, display:"flex", flexDirection:"column",
                alignItems:"center", gap:12, color:C.muted }}>
                <div style={{ fontSize:40 }}>🔍</div>
                <div style={{ fontFamily:C.fontMono, fontSize:13 }}>
                  Configure and run to search for GPU capacity
                </div>
                <div style={{ fontSize:12, textAlign:"center", maxWidth:360, lineHeight:1.7 }}>
                  Calls GCP <code style={{ fontFamily:C.fontMono, background:"#0008",
                    padding:"1px 4px", borderRadius:3 }}>advice/calendarMode</code> via
                  the backend proxy. No credentials required.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
