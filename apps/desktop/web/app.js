// aice desktop SPA (P7.3) — zero-dep ES-module UI over the hardened bridge.
// XSS posture: ALL dynamic content goes through textContent (never innerHTML).
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k ?? "");
  return n;
};
const txt = (v) => (v === null || v === undefined ? "" : String(v));

async function bridge(command, args = {}) {
  const res = await fetch("/api/bridge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const reply = await res.json();
  if (!reply.ok) throw new Error(`${reply.code}: ${reply.message}`);
  return reply.data;
}

const state = {
  projects: [],
  projectId: null,
  tasks: [],
  taskId: null,
  view: "projects",
};

const NEXT_STATES = [
  "CLASSIFYING", "INVESTIGATING", "PLANNING", "WAITING_APPROVAL", "PREPARING_WORKSPACE",
  "IMPLEMENTING", "TESTING", "SECURITY_REVIEW", "AI_REVIEW", "VERIFYING", "READY", "APPROVED", "MERGED",
];

function tag(kind, label) { return el("span", { class: `tag ${kind}` }, label); }
function stateTag(s) {
  const map = { MERGED: "ok", APPROVED: "ok", READY: "ok", READY_FOR_MERGE: "ok", BLOCKED: "bad", FAILED: "bad", CANCELLED: "bad", ROLLBACK_REQUIRED: "bad", ROLLED_BACK: "warn" };
  return el("span", { class: `tag ${map[s] ?? "info"}` }, txt(s));
}

async function refreshProjects() {
  state.projects = await bridge("projects.list");
  if (state.projectId === null && state.projects.length > 0) state.projectId = state.projects[0].id;
}

async function renderProjects(main) {
  await refreshProjects();
  const form = el("form", { class: "inline", onsubmit: async (e) => {
    e.preventDefault();
    const name = $("#p-name").value.trim();
    const path = $("#p-path").value.trim();
    if (name === "" || path === "") return;
    const p = await bridge("projects.create", { name, rootPath: path });
    state.projectId = p.id;
    await render();
  } });
  form.append(
    el("label", {}, "new project"),
    el("input", { type: "text", id: "p-name", placeholder: "name (e.g. my-service)" }),
    el("input", { type: "text", id: "p-path", placeholder: "absolute repo path" }),
    el("button", { class: "act", type: "submit" }, "create"),
  );
  const table = el("table");
  table.append(
    el("tr", {}, el("th", {}, "name"), el("th", {}, "classification"), el("th", {}, "root path"), el("th", {}, "id")),
  );
  for (const p of state.projects) {
    const openProject = () => { state.projectId = p.id; state.taskId = null; state.view = "tasks"; render(); };
    const row = el("tr",
      { class: p.id === state.projectId ? "flash" : "", role: "button", tabindex: "0", "aria-label": `open project ${p.name}`,
        onclick: openProject,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProject(); } } },
      el("td", {}, txt(p.name)),
      el("td", {}, tag("info", p.classification)),
      el("td", {}, txt(p.rootPath)),
      el("td", {}, el("code", {}, p.id)),
    );
    table.append(row);
  }
  main.append(el("div", { class: "panel" }, el("h3", {}, `projects (${state.projects.length})`,), form, table));
}

async function renderTasks(main) {
  await refreshProjects();
  if (state.projectId === null && state.projects.length > 0) state.projectId = state.projects[0].id;
  const picker = el("select", { onchange: async (e) => { state.projectId = e.target.value; state.taskId = null; await render(); } });
  for (const p of state.projects) picker.append(el("option", { value: p.id, ...(p.id === state.projectId ? { selected: "" } : {}) }, ` ${p.name}` ));
  const create = el("form", { class: "inline", onsubmit: async (e) => {
    e.preventDefault();
    const title = $("#t-title").value.trim();
    if (title === "" || state.projectId === null) return;
    const risk = $("#t-risk").value;
    await bridge("tasks.create", { projectId: state.projectId, title, risk });
    $("#t-title").value = "";
    await render();
  } });
  const riskSel = el("select", { id: "t-risk" },
    el("option", { value: "low" }, "low"), el("option", { value: "medium", selected: "" }, "medium"), el("option", { value: "high" }, "high"));
  create.append(
    el("label", {}, "new task"), el("input", { type: "text", id: "t-title", placeholder: "title" }),
    riskSel, el("button", { class: "act", type: "submit" }, "create"),
  );
  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "state"), el("th", {}, "risk"), el("th", {}, "class"), el("th", {}, "title"), el("th", {}, "")));
  let tasks = [];
  if (state.projectId !== null) tasks = await bridge("tasks.list", { projectId: state.projectId });
  for (const t of tasks) {
    const open = el("button", { class: "act", onclick: () => { state.taskId = t.id; state.view = "tasks"; render(); } }, "open");
    table.append(el("tr", {},
      el("td", {}, stateTag(t.state)),
      el("td", {}, txt(t.risk)),
      el("td", {}, tag("info", t.classification)),
      el("td", {}, txt(t.title)),
      el("td", {}, open),
    ));
  }
  main.append(el("div", { class: "panel" },
    el("h3", {}, "tasks"),
    picker,
    create,
    state.projectId === null ? el("p", { class: "muted" }, "create a project first (Projects tab)") : el("div", {}, table),
  ));
  if (state.taskId !== null) await renderTaskDetail(main, state.taskId);
}

async function renderTaskDetail(main, taskId) {
  const b = await bridge("tasks.bundle", { taskId });
  const wrap = el("div", { class: "panel" });
  wrap.append(el("h3", {}, `task ${b.task.title}`), el("div", { class: "detail-block" }, stateTag(b.task.state), el("span", { class: "muted" }, ` ${b.task.id} · risk ${b.task.risk} · ${b.task.classification}`)));
  // actions
  const actions = el("div", {});
  const adv = el("select", { id: "adv-to" });
  for (const s of NEXT_STATES) adv.append(el("option", { value: s }, s));
  actions.append(
    adv,
    el("button", { class: "act", onclick: async () => { try { await bridge("tasks.advance", { taskId, to: adv.value }); } catch (e) { alert(e.message); } await render(); } }, "guard-advance"),
    el("button", { class: "act", onclick: async () => { try { await bridge("approvals.record", { taskId, kind: "plan" }); } catch (e) { alert(e.message); } await render(); } }, "approve plan"),
    el("button", { class: "act", onclick: async () => { try { await bridge("approvals.record", { taskId, kind: "final" }); } catch (e) { alert(e.message); } await render(); } }, "approve final"),
    el("button", { class: "act", onclick: async () => { const r = prompt("reason (BLOCKED):") ?? ""; try { await bridge("tasks.fail", { taskId, to: "BLOCKED", reason: r }); } catch (e) { alert(e.message); } await render(); } }, "block"),
  );
  wrap.append(el("h4", {}, "evidence & actions"), actions);
  // runs timeline
  wrap.append(el("h4", {}, "transitions"));
  const runsT = el("table"); runsT.append(el("tr", {}, el("th", {}, "at"), el("th", {}, "from → to"), el("th", {}, "agent/model"), el("th", {}, "summary")));
  for (const r of b.runs) runsT.append(el("tr", {}, el("td", {}, txt(r.startedAt)), el("td", {}, `${r.fromState} → ${r.toState}`), el("td", {}, txt(r.modelId ?? r.agent)), el("td", { class: "muted" }, txt(r.summary ?? ""))));
  wrap.append(runsT);
  // agent sessions
  wrap.append(el("h4", {}, `agent sessions (${b.agentRuns.length})`));
  for (const ar of b.agentRuns) {
    wrap.append(el("div", { class: "detail-block" },
      el("div", {}, tag("info", ar.phase), tag(ar.status === "completed" ? "ok" : "warn", ar.status), el("span", { class: "muted" }, ` rounds ${ar.rounds} · tools ${ar.toolCalls} · denials ${ar.denials} · ${ar.modelId ?? "script-replay"} · ${ar.createdAt}`)),
      ar.finalText !== null ? el("pre", {}, ar.finalText) : "",
      el("details", {}, el("summary", { class: "muted" }, "transcript (display-only, untrusted)"), el("pre", {}, ar.transcriptJson)),
    ));
  }
  // test results + findings
  wrap.append(el("h4", {}, `test results (${b.testResults.length}) · findings (${b.findings.length})`));
  const tr = el("table"); tr.append(el("tr", {}, el("th", {}, "suite"), el("th", {}, "passed"), el("th", {}, "failed"), el("th", {}, "skipped"), el("th", {}, "at")));
  for (const t of b.testResults) tr.append(el("tr", {}, el("td", {}, txt(t.suite)), el("td", {}, String(t.passed)), el("td", {}, String(t.failed)), el("td", {}, String(t.skipped)), el("td", { class: "muted" }, txt(t.recordedAt ?? t.at ?? ""))));
  wrap.append(tr);
  wrap.append(el("h4", {}, "audit (content-free)"));
  for (const ev of b.audit) wrap.append(el("div", { class: "muted" }, `#${ev.id} ${ev.at} ${ev.actor} · ${ev.action} ${ev.decision ?? ""}`));
  main.append(wrap);
}

async function renderAgents(main) {
  await refreshProjects();
  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "phase"), el("th", {}, "status"), el("th", {}, "rounds/tools/denials"), el("th", {}, "model"), el("th", {}, "created"), el("th", {}, "final")));
  for (const p of state.projects) {
    let tasks;
    try { tasks = await bridge("tasks.list", { projectId: p.id }); } catch { continue; }
    for (const t of tasks) {
      const sessions = await bridge("agents.sessions", { taskId: t.id });
      for (const ar of sessions) {
        const openSession = () => { state.projectId = p.id; state.taskId = t.id; state.view = "tasks"; render(); };
        table.append(el("tr", { role: "button", tabindex: "0", "aria-label": `open session for task ${ar.phase}`,
          onclick: openSession,
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSession(); } } },
          el("td", {}, tag("info", ar.phase)), el("td", {}, stateTag(ar.status)),
          el("td", {}, `${ar.rounds}/${ar.toolCalls}/${ar.denials}`),
          el("td", {}, txt(ar.modelId ?? "script-replay")),
          el("td", { class: "muted" }, txt(ar.createdAt)),
          el("td", { class: "muted" }, txt((ar.finalText ?? "").slice(0, 120))),
        ));
      }
    }
  }
  main.append(el("div", { class: "panel" }, el("h3", {}, "agent sessions (all projects)"), table));
}

async function renderMcp(main) {
  const rows = await bridge("mcp.list");
  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "name"), el("th", {}, "transport/trust"), el("th", {}, "enabled"), el("th", {}, "config (display-only)"), el("th", {}, "")));
  for (const r of rows) {
    table.append(el("tr", {}, el("td", {}, txt(r.name)), el("td", {}, `${r.transport} · ${r.trust}`),
      el("td", {}, r.enabled ? tag("ok", "enabled") : tag("bad", "disabled")),
      el("td", {}, el("pre", {}, r.configJson)),
      el("td", {}, el("button", { class: "act", onclick: async () => { await bridge("mcp.toggle", { id: r.id, enabled: !r.enabled }); await render(); } }, r.enabled ? "disable" : "enable")),
    ));
  }
  main.append(el("div", { class: "panel" }, el("h3", {}, `mcp servers (${rows.length})`), table, el("p", { class: "muted" }, "add/invoke via: aice mcp add & aice mcp invoke (gates, audit, approvals)")));
}

async function renderSkills(main) {
  const rows = await bridge("skills.list");
  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "name"), el("th", {}, "status"), el("th", {}, "digest"), el("th", {}, "path"), el("th", {}, "reviewed")));
  for (const r of rows) {
    table.append(el("tr", {}, el("td", {}, txt(r.name)),
      el("td", {}, tag(r.status === "approved" ? "ok" : r.status === "blocked" ? "bad" : "warn", r.status)),
      el("td", {}, el("code", {}, r.sha256.slice(0, 16) + "…")),
      el("td", { class: "muted" }, txt(r.sourcePath)),
      el("td", { class: "muted" }, txt(r.reviewedBy ?? "—")),
    ));
  }
  main.append(el("div", { class: "panel" }, el("h3", {}, `skills (${rows.length})`), table, el("p", { class: "muted" }, "tamper-check + consent travel through: aice skill review → aice skill approve (digest mismatch = automatic block)")));
}

async function renderAudit(main) {
  await refreshProjects();
  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "#"), el("th", {}, "at"), el("th", {}, "actor"), el("th", {}, "action"), el("th", {}, "decision"), el("th", {}, "detail (redacted)")));
  for (const p of state.projects) {
    let tasks;
    try { tasks = await bridge("tasks.list", { projectId: p.id }); } catch { continue; }
    for (const t of tasks) {
      const rows = await bridge("audit.list", { taskId: t.id, limit: 300 });
      for (const ev of rows) {
        table.append(el("tr", {}, el("td", {}, String(ev.id)), el("td", { class: "muted" }, txt(ev.at)), el("td", {}, txt(ev.actor)),
          el("td", {}, txt(ev.action)), el("td", {}, txt(ev.decision ?? "")), el("td", { class: "muted" }, txt(ev.detailText ?? "")),
        ));
      }
    }
  }
  main.append(el("div", { class: "panel" }, el("h3", {}, "audit trail (redacted, append-only)"), table));
}

const views = {
  projects: renderProjects,
  tasks: renderTasks,
  agents: renderAgents,
  mcp: renderMcp,
  skills: renderSkills,
  audit: renderAudit,
};

async function render() {
  for (const b of document.querySelectorAll("#nav button")) b.classList.toggle("active", b.dataset.view === state.view);
  const main = $("#main");
  main.replaceChildren();
  try {
    await views[state.view](main);
  } catch (err) {
    main.append(el("div", { class: "panel" }, el("p", { class: "bad" }, `error: ${err.message}`),
      el("p", { class: "muted" }, "bridge unreachable? run: node apps/desktop/src/server.ts (binds 0.0.0.0; DB_PATH env points at the db)")));
  }
}

for (const b of document.querySelectorAll("#nav button")) {
  b.addEventListener("click", () => { state.view = b.dataset.view; render(); });
}
render();
