// /public/js/operations-manual.js — Operations Manual + Team Dashboard
// Same MSAL auth stack as the rest of PropCMA (js/config.js, js/auth.js).
// Content and dashboard data are fetched from /api/manual, which itself
// requires role "accounts" or "manager" — the same two roles the rest of
// accounts.html is restricted to.
(function () {
  const cfg = window.DealSheetConfig;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------------------------------------------------------------
  // Demo content — used only when DEMO_MODE is on (js/config.js),
  // so this page is still clickable with zero setup, same as the
  // rest of PropCMA. Real use always goes through /api/manual.
  // ---------------------------------------------------------------
  const DEMO_DATA = {
    manual: {
      version: "demo", updated: "—",
      chapters: [
        { id: "demo", title: "Demo Mode", sections: [
          { id: "demo-1", num: "", title: "Demo Mode", text: "This is a demo.",
            html: "<p>DEMO_MODE is on in <code>js/config.js</code>, so this page is showing placeholder content instead of calling <code>/api/manual</code>. Turn DEMO_MODE off to see the real Operations Manual and Team Dashboard.</p>" },
        ]},
      ],
    },
    dashboard: {
      snapshotDate: "—", roster: [], supervisionProcess: { principles: [], tasks: [] },
      brokerContractAudits: [], openIssuesRegister: [], suppliersSponsors: [],
      reinzAwards: { note: "", categories: [] },
    },
  };

  const state = {
    manual: null, dashboard: null,
    view: "dashboard",        // "manual" | "dashboard" — lands on the Team Dashboard by default
    sectionId: null,
    dashTab: "roster",
    query: "",                // manual search
    dashQuery: "",             // per-tab table search
    issuesFilter: "all",
    sortKey: null, sortDir: 1,
    selectedAgent: null,
    collapsedChapters: {},
  };

  // ---------------------------------------------------------------
  // data loading
  // ---------------------------------------------------------------
  async function loadData() {
    if (cfg.DEMO_MODE) { return DEMO_DATA; }
    const token = await window.DealSheetAuth.getToken();
    const res = await fetch(`${cfg.apiBase}/api/manual`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------
  // helpers: dates & status pills
  // ---------------------------------------------------------------
  function parseISO(s) { return s ? new Date(s + "T00:00:00") : null; }
  function fmtDate(s) {
    const d = parseISO(s);
    return d ? d.toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  }
  function fmtDateShort(s) {
    const d = parseISO(s);
    return d ? d.toLocaleDateString("en-NZ", { day: "2-digit", month: "short" }) : "—";
  }
  // Day + month only, no year — birthdays/anniversaries recur every year,
  // so the year on file (often decades old for DOB) isn't the point.
  function fmtDayMonth(s) {
    const d = parseISO(s);
    return d ? d.toLocaleDateString("en-NZ", { day: "numeric", month: "long" }) : "—";
  }
  // dd/mm, no year — used for License Expiry specifically, since the year
  // isn't what staff scan for; the day/month is what tells you "is this
  // due soon".
  function fmtDDMM(s) {
    const d = parseISO(s);
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  }
  function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

  function licenseExpiryStatus(dateStr) {
    if (!dateStr) return { cls: "dim", label: "—" };
    const d = parseISO(dateStr), t = today();
    const thisMonth = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth();
    const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    const nextMonth = d.getFullYear() === next.getFullYear() && d.getMonth() === next.getMonth();
    if (d < t) return { cls: "bad", label: `Expired ${fmtDDMM(dateStr)}` };
    if (thisMonth || nextMonth) return { cls: "bad", label: `Due ${fmtDDMM(dateStr)}` };
    return { cls: "ok", label: fmtDDMM(dateStr) };
  }
  function hoursStatus(hrs) {
    if (hrs == null || hrs === "") return { cls: "dim", label: "—" };
    const n = Number(hrs);
    return n >= 10 ? { cls: "ok", label: `${n} hrs` } : { cls: "bad", label: `${n} hrs` };
  }
  function isThisMonth(dateStr) {
    if (!dateStr) return false;
    const d = parseISO(dateStr), t = today();
    return d.getMonth() === t.getMonth(); // birthdays/anniversaries recur yearly — compare month only
  }
  function isSuspended(agent) {
    return /suspend/i.test(agent.licenceNumber || "");
  }
  function pill(status) { return `<span class="pill ${status.cls}">${esc(status.label)}</span>`; }

  // ---------------------------------------------------------------
  // manual search
  // ---------------------------------------------------------------
  function allSections() {
    const out = [];
    for (const ch of state.manual.chapters) {
      for (const sec of ch.sections) out.push({ chapter: ch, sec });
    }
    return out;
  }
  function searchManual(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const results = [];
    for (const { chapter, sec } of allSections()) {
      const title = sec.title.toLowerCase();
      const text = sec.text.toLowerCase();
      const ti = title.indexOf(needle);
      const bi = text.indexOf(needle);
      if (ti === -1 && bi === -1) continue;
      const score = (ti !== -1 ? 2 : 0) + (bi !== -1 ? 1 : 0);
      let snippet = sec.text.slice(0, 160);
      if (bi !== -1) {
        const start = Math.max(0, bi - 60);
        snippet = (start > 0 ? "…" : "") + sec.text.slice(start, start + 160) + "…";
      }
      results.push({ chapter, sec, score, snippet });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 40);
  }
  function highlight(text, q) {
    if (!q.trim()) return esc(text);
    const re = new RegExp(`(${q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    return esc(text).replace(re, "<mark>$1</mark>");
  }

  // ---------------------------------------------------------------
  // org directory (manual section 1.4, filled in from roster data)
  // ---------------------------------------------------------------
  const GROUP_ORDER = [
    "Managing Director", "General Manager", "Director", "Director/Broker",
    "Chief Operating Officer", "Financial Controller",
    "Broker", "Debt Advisory",
    "Marketing Executive", "Executive Assistant", "Broker Support", "Receptionist",
  ];
  function renderOrgDirectory() {
    const el = $("orgDirectory");
    if (!el) return;
    const roster = state.dashboard.roster;
    if (!roster.length) { el.innerHTML = `<p class="stub">Team directory unavailable (demo mode).</p>`; return; }
    const groups = {};
    roster.forEach((a) => {
      const key = a.jobTitle || "Other";
      (groups[key] = groups[key] || []).push(a);
    });
    const order = Object.keys(groups).sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    el.innerHTML = order.map((title) => `
      <div class="orgGroup">
        <h5>${esc(title)}${groups[title].length > 1 ? ` (${groups[title].length})` : ""}</h5>
        <div class="orgGrid">
          ${groups[title].map((a) => `
            <div class="orgCard">
              <div class="nm">${esc(a.firstName)} ${esc(a.surname)}</div>
              <div class="rl">${esc(title)}</div>
              ${a.email ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : ""}
              ${a.mobile ? `<a href="tel:${esc(String(a.mobile).replace(/\s/g, ""))}">${esc(a.mobile)}</a>` : ""}
            </div>`).join("")}
        </div>
      </div>`).join("") + `
      <p class="smallNote">Financial Manager note: the manual (§7.5 / Finance) references Nishu Singh as current Finance Manager — the roster spreadsheet still lists Maree Crocker as Financial Controller. Worth reconciling next time the dashboard is updated.</p>`;
  }

  // ---------------------------------------------------------------
  // render: shell
  // ---------------------------------------------------------------
  function render() {
    $("app").innerHTML = `
      <aside class="sidebar">
        <a class="backLink" href="accounts.html">&larr; Back to Deal Sheets</a>
        <div class="sideBrand">
          <img src="img/colliers-logo.png" alt="" onerror="this.style.display='none'">
          <div class="t"><strong>Operations Manual</strong><span>Colliers Canterbury</span></div>
        </div>
        <div class="searchBox">
          <span class="ico">&#128269;</span>
          <input id="manualSearch" type="search" placeholder="Search the manual…" value="${esc(state.query)}" autocomplete="off" />
          ${state.query ? `<button class="clearBtn" id="clearSearch" title="Clear">&times;</button>` : ""}
        </div>
        ${renderToc()}
        <div class="tocDashDivider">
          <button class="tocGroupBtn" style="padding-left:8px">Team Dashboard</button>
          <nav class="dashNav">
            ${dashNavItem("roster", "Roster & Compliance", state.dashboard.roster.length)}
            ${dashNavItem("supervision", "Supervision", state.dashboard.roster.length)}
            ${dashNavItem("audits", "Broker Contract Audits", state.dashboard.brokerContractAudits.length)}
            ${dashNavItem("issues", "Open Issues Register", state.dashboard.openIssuesRegister.length)}
            ${dashNavItem("suppliers", "Suppliers & Sponsors", state.dashboard.suppliersSponsors.length)}
            ${dashNavItem("reinz", "REINZ Awards", state.dashboard.reinzAwards.categories.length)}
          </nav>
        </div>
      </aside>
      <main class="content" id="mainContent"></main>
    `;
    wireSidebar();
    renderMain();
  }

  function dashNavItem(key, label, count) {
    const on = state.view === "dashboard" && state.dashTab === key;
    return `<button class="dashNavBtn ${on ? "on" : ""}" data-dash="${key}">${esc(label)}<span class="cnt">${count}</span></button>`;
  }

  function renderToc() {
    if (state.query.trim()) {
      const results = searchManual(state.query);
      return `<div class="searchMeta">${results.length} result${results.length === 1 ? "" : "s"}</div>`;
    }
    return `<nav class="toc">${state.manual.chapters.map((ch) => `
      <div class="tocGroup">
        <button class="tocGroupBtn" data-chapter="${ch.id}">${esc(ch.title)}</button>
        ${!state.collapsedChapters[ch.id] ? ch.sections.map((sec) => `
          <button class="tocSection ${state.view === "manual" && state.sectionId === sec.id ? "on" : ""}" data-section="${sec.id}">
            <span class="num">${esc(sec.num)}</span><span>${esc(sec.title)}</span>
          </button>`).join("") : ""}
      </div>`).join("")}</nav>`;
  }

  function wireSidebar() {
    const input = $("manualSearch");
    input.oninput = () => {
      // render() rebuilds the whole sidebar via innerHTML, which destroys
      // this <input> and creates a fresh one — so refocus the NEW element
      // (re-queried from the live DOM), not this now-detached `input`
      // reference. Focusing the stale node was silently a no-op, which
      // dropped focus after every keystroke (bug: only one letter at a
      // time would register before you had to click back into the box).
      state.query = input.value;
      render();
      const el = $("manualSearch");
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    };
    const clearBtn = $("clearSearch");
    if (clearBtn) clearBtn.onclick = () => { state.query = ""; render(); };
    $("app").querySelectorAll("[data-chapter]").forEach((b) => b.onclick = () => {
      state.collapsedChapters[b.dataset.chapter] = !state.collapsedChapters[b.dataset.chapter];
      render();
    });
    $("app").querySelectorAll("[data-section]").forEach((b) => b.onclick = () => {
      state.view = "manual"; state.sectionId = b.dataset.section; state.query = "";
      render(); window.scrollTo(0, 0);
    });
    $("app").querySelectorAll("[data-dash]").forEach((b) => b.onclick = () => {
      state.view = "dashboard"; state.dashTab = b.dataset.dash; state.dashQuery = ""; state.selectedAgent = null;
      render(); window.scrollTo(0, 0);
    });
  }

  // ---------------------------------------------------------------
  // render: main content
  // ---------------------------------------------------------------
  function renderMain() {
    const el = $("mainContent");
    if (state.query.trim()) { el.innerHTML = renderSearchResults(); wireSearchResults(); return; }
    if (state.view === "dashboard") { el.innerHTML = renderDashboard(); wireDashboard(); return; }
    el.innerHTML = renderManualSection();
    if (state.sectionId === "1-4") renderOrgDirectory();
  }

  function renderSearchResults() {
    const results = searchManual(state.query);
    if (!results.length) return `<div class="contentHead"><h1>No results</h1></div><p class="dimText">Try a different search term.</p>`;
    return `
      <div class="contentHead"><h1>Search results</h1></div>
      <div class="searchResultsView">
        ${results.map((r) => `
          <div class="srItem">
            <div class="srCrumb">${esc(r.chapter.title)}</div>
            <h4><button data-goto="${r.sec.id}">${highlight(r.sec.title, state.query)}</button></h4>
            <p>${highlight(r.snippet, state.query)}</p>
          </div>`).join("")}
      </div>`;
  }
  function wireSearchResults() {
    $("mainContent").querySelectorAll("[data-goto]").forEach((b) => b.onclick = () => {
      state.view = "manual"; state.sectionId = b.dataset.goto; state.query = "";
      render(); window.scrollTo(0, 0);
    });
  }

  function currentSection() {
    for (const ch of state.manual.chapters) {
      const sec = ch.sections.find((s) => s.id === state.sectionId);
      if (sec) return { chapter: ch, sec };
    }
    const ch = state.manual.chapters[0];
    return { chapter: ch, sec: ch.sections[0] };
  }

  function renderManualSection() {
    const { chapter, sec } = currentSection();
    if (!state.sectionId) state.sectionId = sec.id;
    return `
      <div class="contentHead">
        <div><p class="crumb">${esc(chapter.title)}</p><h1>${esc(sec.num ? `${sec.num} ` : "")}${esc(sec.title)}</h1></div>
        <div class="metaRight">Manual v${esc(state.manual.version)} &middot; updated ${esc(state.manual.updated)}</div>
      </div>
      <div class="manualBody">${sec.html}</div>
    `;
  }

  // ---------------------------------------------------------------
  // render: dashboard
  // ---------------------------------------------------------------
  function renderDashboard() {
    const d = state.dashboard;
    const heads = {
      roster: "Roster & Compliance", supervision: "Supervision",
      audits: "Broker Contract Audits", issues: "Open Issues Register",
      suppliers: "Suppliers & Sponsors", reinz: "REINZ Awards",
    };
    const body = {
      roster: renderRosterTab, supervision: renderSupervisionTab, audits: renderAuditsTab,
      issues: renderIssuesTab, suppliers: renderSuppliersTab, reinz: renderReinzTab,
    }[state.dashTab](d);
    return `
      <div class="contentHead">
        <div><p class="crumb">Team Dashboard</p><h1>${esc(heads[state.dashTab])}</h1></div>
        <div class="metaRight">Data as of ${esc(fmtDate(d.snapshotDate))}<br>from Real Estate Agent Management Dashboard.xlsx</div>
      </div>
      ${body}`;
  }

  function sortRows(rows, key, dir) {
    if (!key) return rows;
    return [...rows].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1; if (bv == null) return -1;
      return av > bv ? dir : av < bv ? -dir : 0;
    });
  }

  function renderRosterTab(d) {
    const q = state.dashQuery.trim().toLowerCase();
    let rows = d.roster.filter((a) =>
      !q || `${a.firstName} ${a.surname} ${a.email} ${a.jobTitle}`.toLowerCase().includes(q));
    rows = sortRows(rows, state.sortKey, state.sortDir);

    const licensed = d.roster.filter((a) => a.licenceNumber && !isSuspended(a));
    const expiringSoon = licensed.filter((a) => licenseExpiryStatus(a.licenseExpiry).cls === "bad").length;
    const trainingBehind = licensed.filter((a) => Number(a.verifiableHours || 0) < 10).length;
    const birthdayAgents = d.roster.filter((a) => isThisMonth(a.dob));
    const birthdays = birthdayAgents.length;
    const birthdayTitle = birthdayAgents
      .map((a) => `${a.firstName} ${a.surname} — ${fmtDayMonth(a.dob)}`).join("\n");
    const suspended = d.roster.filter(isSuspended).length;

    const selected = state.selectedAgent ? d.roster.find((a) => `${a.firstName}|${a.surname}` === state.selectedAgent) : null;

    return `
      <div class="statGrid">
        <div class="statCard"><div class="n">${d.roster.length}</div><div class="l">Team members</div></div>
        <div class="statCard ${expiringSoon ? "bad" : "ok"}"><div class="n">${expiringSoon}</div><div class="l">Licenses due this/next month</div></div>
        <div class="statCard ${trainingBehind ? "warn" : "ok"}"><div class="n">${trainingBehind}</div><div class="l">Behind on verifiable training</div></div>
        <div class="statCard ${suspended ? "bad" : "ok"}"><div class="n">${suspended}</div><div class="l">Suspended licenses</div></div>
        <div class="statCard"${birthdays ? ` title="${esc(birthdayTitle)}"` : ""}><div class="n">${birthdays}</div><div class="l">Birthdays this month</div></div>
      </div>
      <div class="dashHead">
        <input class="dashSearch" id="dashSearch" placeholder="Search name, role, email…" value="${esc(state.dashQuery)}" />
      </div>
      <div class="dashTableWrap"><table class="dashTable">
        <thead><tr>
          <th data-sort="firstName">Name</th><th data-sort="jobTitle">Role</th><th>Licence #</th>
          <th data-sort="licenseExpiry">Licence Expiry</th><th>Verifiable</th><th>Non-Verifiable</th>
          <th data-sort="supervisionLevel">Supervision</th><th>Mobile</th>
        </tr></thead>
        <tbody>
          ${rows.map((a) => `
            <tr class="agentRow" data-agent="${esc(a.firstName)}|${esc(a.surname)}">
              <td><strong>${esc(a.firstName)} ${esc(a.surname)}</strong>${isThisMonth(a.dob) ? ` <span class="pill ok" title="Birthday: ${esc(fmtDayMonth(a.dob))}">🎂 this month</span>` : ""}</td>
              <td>${esc(a.jobTitle || "—")}</td>
              <td class="mono">${esc(a.licenceNumber || "—")}${isSuspended(a) ? ' <span class="pill warn">Suspended</span>' : ""}</td>
              <td>${a.licenceNumber ? pill(licenseExpiryStatus(a.licenseExpiry)) : '<span class="dimText">—</span>'}</td>
              <td>${a.licenceNumber ? pill(hoursStatus(a.verifiableHours)) : '<span class="dimText">—</span>'}</td>
              <td>${a.licenceNumber ? pill(hoursStatus(a.nonVerifiableHours)) : '<span class="dimText">—</span>'}</td>
              <td>${esc(a.supervisionLevel || "—")}${a.supervisionFrequency ? ` <span class="dimText">(${esc(a.supervisionFrequency)})</span>` : ""}</td>
              <td class="mono">${esc(a.mobile || "—")}</td>
            </tr>`).join("") || `<tr><td colspan="8"><div class="emptyState">No matches.</div></td></tr>`}
        </tbody>
      </table></div>
      <p class="smallNote">Red = license expired, or due this month or next month (matches the spreadsheet's own highlighting). Verifiable/non-verifiable training hours are green at 10+ hours, red below — each broker needs 10 verifiable CPD hours completed by 31 December.</p>
      ${selected ? renderAgentDetail(selected) : ""}
    `;
  }

  function renderAgentDetail(a) {
    return `
      <div class="detailCard">
        <h4>${esc(a.firstName)} ${esc(a.surname)} <span class="dimText">— ${esc(a.jobTitle || "")}</span></h4>
        <dl class="detailGrid">
          <div><dt>Email</dt><dd>${a.email ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : "—"}</dd></div>
          <div><dt>Mobile</dt><dd>${esc(a.mobile || "—")}</dd></div>
          <div><dt>Date of birth</dt><dd>${fmtDateShort(a.dob)}</dd></div>
          <div><dt>Work anniversary</dt><dd>${fmtDateShort(a.workAnniversary)}</dd></div>
          <div><dt>Years with Colliers</dt><dd>${esc(a.yearsWithColliers || "—")}</dd></div>
          <div><dt>Experience (real estate)</dt><dd>${esc(a.experience || "—")}</dd></div>
          <div><dt>Licence number</dt><dd>${esc(a.licenceNumber || "—")}</dd></div>
          <div><dt>Licence expiry</dt><dd>${fmtDDMM(a.licenseExpiry)}</dd></div>
          <div><dt>Supervision level</dt><dd>${esc(a.supervisionLevel || "—")}</dd></div>
          <div><dt>Supervision plan start</dt><dd>${fmtDate(a.supervisionPlanStart)}</dd></div>
          <div><dt>Review date</dt><dd>${fmtDate(a.reviewDate)}</dd></div>
          <div><dt>Active listings</dt><dd>${esc(a.activeListings ?? "—")}</dd></div>
          <div><dt>Address</dt><dd>${esc(a.address || "—")}</dd></div>
        </dl>
      </div>`;
  }

  function renderSupervisionTab(d) {
    const sp = d.supervisionProcess;
    const rows = d.roster.filter((a) => a.licenceNumber);
    return `
      <div class="infoCard">
        <h4>How supervision works here</h4>
        <ul>${(sp.principles || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
      </div>
      <div class="infoCard">
        <h4>Rollout tasks</h4>
        <ul>${(sp.tasks || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>
      <div class="dashTableWrap"><table class="dashTable">
        <thead><tr><th>Name</th><th>Level</th><th>Frequency</th><th>Plan Start</th><th>Review Date</th></tr></thead>
        <tbody>${rows.map((a) => `
          <tr><td><strong>${esc(a.firstName)} ${esc(a.surname)}</strong></td>
            <td>${esc(a.supervisionLevel || "—")}</td><td>${esc(a.supervisionFrequency || "—")}</td>
            <td>${fmtDate(a.supervisionPlanStart)}</td><td>${fmtDate(a.reviewDate)}</td></tr>`).join("") || `<tr><td colspan="5"><div class="emptyState">No data.</div></td></tr>`}
        </tbody>
      </table></div>`;
  }

  function renderAuditsTab(d) {
    const rows = d.brokerContractAudits;
    const withIssues = rows.filter((r) => r.issuesIdentified).length;
    return `
      <div class="statGrid">
        <div class="statCard"><div class="n">${rows.length}</div><div class="l">Brokers on the audit list</div></div>
        <div class="statCard ${withIssues ? "warn" : "ok"}"><div class="n">${withIssues}</div><div class="l">With issues logged</div></div>
      </div>
      <div class="dashTableWrap"><table class="dashTable">
        <thead><tr><th>Name</th><th>Issues Identified</th><th>Training Given</th><th>Comments</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr><td><strong>${esc(r.firstName)} ${esc(r.surname)}</strong></td>
            <td>${esc(r.issuesIdentified ?? "—")}</td><td>${esc(r.trainingGiven ?? "—")}</td><td>${esc(r.comments ?? "—")}</td></tr>`).join("")}
        </tbody>
      </table></div>
      <p class="smallNote">No issues logged yet on most brokers — this list is ready to use for ongoing contract audit notes.</p>`;
  }

  function renderIssuesTab(d) {
    const statuses = ["all", "Open", "Underway", "CLOSED"];
    const q = state.dashQuery.trim().toLowerCase();
    let rows = d.openIssuesRegister.filter((r) =>
      (state.issuesFilter === "all" || (r.Status || "").toLowerCase() === state.issuesFilter.toLowerCase()) &&
      (!q || JSON.stringify(r).toLowerCase().includes(q)));
    return `
      <div class="dashHead">
        <div class="filterRow">
          ${statuses.map((s) => `<button class="fchip ${state.issuesFilter === s ? "on" : ""}" data-issuefilter="${s}">${s === "all" ? "All" : s}</button>`).join("")}
        </div>
        <input class="dashSearch" id="dashSearch" placeholder="Search issues…" value="${esc(state.dashQuery)}" />
      </div>
      <div class="dashTableWrap"><table class="dashTable">
        <thead><tr><th>Pri.</th><th>Category</th><th>Description</th><th>Impact</th><th>Urgency</th><th>Status</th><th>Owner</th><th>Notes</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r.Priority ?? "—")}</td>
            <td>${esc(r.Category || "—")}</td>
            <td style="min-width:280px">${esc(r["Issue/Opportunity Description"] || "—")}</td>
            <td>${esc(r["Impact (High/Medium/Low)"] || "—")}</td>
            <td>${esc(r["Urgency (High/Medium/Low)"] || "—")}</td>
            <td>${statusPillForIssue(r.Status)}</td>
            <td>${esc(r.Owner || "—")}</td>
            <td>${esc(r.Notes || "—")}</td>
          </tr>`).join("") || `<tr><td colspan="8"><div class="emptyState">No matches.</div></td></tr>`}
        </tbody>
      </table></div>`;
  }
  function statusPillForIssue(status) {
    const s = (status || "").toLowerCase();
    if (s === "closed") return `<span class="pill ok">Closed</span>`;
    if (s === "open") return `<span class="pill warn">Open</span>`;
    if (s === "underway") return `<span class="pill bad">Underway</span>`;
    return `<span class="pill dim">${esc(status || "—")}</span>`;
  }

  function renderSuppliersTab(d) {
    const q = state.dashQuery.trim().toLowerCase();
    const rows = d.suppliersSponsors.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q));
    return `
      <div class="dashHead">
        <input class="dashSearch" id="dashSearch" placeholder="Search suppliers…" value="${esc(state.dashQuery)}" />
      </div>
      <div class="dashTableWrap"><table class="dashTable">
        <thead><tr><th>Service</th><th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>Type</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r["Service/Product Provided"] || "—")}</td>
            <td><strong>${esc(r["Company Name"] || "—")}</strong></td>
            <td>${esc(r["Contact Person"] || "—")}</td>
            <td>${r["Email Address"] ? `<a href="mailto:${esc(r["Email Address"])}">${esc(r["Email Address"])}</a>` : "—"}</td>
            <td class="mono">${esc(r["Phone Number"] || "—")}</td>
            <td>${esc(r["Type (Supplier/Partner)"] || "—")}</td>
            <td>${r["Status (Active/Pending/Expired)"] ? `<span class="pill ${/active/i.test(r["Status (Active/Pending/Expired)"]) ? "ok" : "warn"}">${esc(r["Status (Active/Pending/Expired)"])}</span>` : "—"}</td>
            <td style="min-width:220px">${esc(r.Notes || "—")}</td>
          </tr>`).join("") || `<tr><td colspan="8"><div class="emptyState">No matches.</div></td></tr>`}
        </tbody>
      </table></div>`;
  }

  function renderReinzTab(d) {
    const r = d.reinzAwards;
    return `
      <div class="infoCard">
        <h4>Award categories</h4>
        <ul>${r.categories.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>
      ${r.note ? `<p class="smallNote">${esc(r.note)}</p>` : ""}`;
  }

  function wireDashboard() {
    const dashSearch = $("dashSearch");
    if (dashSearch) dashSearch.oninput = () => {
      state.dashQuery = dashSearch.value; render();
      const el = $("dashSearch"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    };
    $("mainContent").querySelectorAll("[data-issuefilter]").forEach((b) => b.onclick = () => {
      state.issuesFilter = b.dataset.issuefilter; render();
    });
    $("mainContent").querySelectorAll("[data-sort]").forEach((th) => th.onclick = () => {
      const key = th.dataset.sort;
      state.sortDir = state.sortKey === key ? -state.sortDir : 1;
      state.sortKey = key; render();
    });
    $("mainContent").querySelectorAll(".agentRow").forEach((tr) => tr.onclick = () => {
      state.selectedAgent = state.selectedAgent === tr.dataset.agent ? null : tr.dataset.agent;
      render();
    });
  }

  // ---------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------
  (async function boot() {
    if (cfg.DEMO_MODE) $("demoBadge").classList.remove("hidden");
    try {
      const account = await window.DealSheetAuth.init();
      if (!account) return; // page will redirect to Microsoft sign-in
    } catch (e) {
      $("gate").innerHTML = `<div class="inner">Sign-in failed: ${esc(e.message)}</div>`;
      return;
    }
    try {
      const data = await loadData();
      state.manual = data.manual;
      state.dashboard = data.dashboard;
    } catch (e) {
      if (e.status === 403) {
        const notSetUp = /Object ID/i.test(e.message || "");
        $("gate").innerHTML = notSetUp
          ? `<div class="inner"><h2>Access not set up yet</h2><p>${esc(e.message)}</p>
             <p class="dimText">Send the Object ID above to your administrator.</p></div>`
          : `<div class="inner"><h2>Operations Manual access required</h2>
             <p>This page is for Accounts and Managers. Your account doesn't have that role.</p>
             <p><a href="accounts.html">Back to Deal Sheets</a></p></div>`;
        return;
      }
      $("gate").innerHTML = `<div class="inner">Couldn't load the Operations Manual: ${esc(e.message)}</div>`;
      return;
    }
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    render();
  })();
})();
