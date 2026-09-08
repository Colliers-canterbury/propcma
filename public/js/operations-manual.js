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
    syncing: false,            // "Sync now" (Roster & Compliance) in progress
    syncNote: null,            // last sync result/error message
    syncNoteType: null,        // "ok" | "bad"
    editingSectionId: null,    // "Edit this page" — id of the section currently being edited, else null
    editDraft: null,           // { num, title, html } — last-known-good copy of what's in the editor
    saving: false,             // Save in progress
    saveError: null,
  };

  // A save is in flight or an edit is open — used to lock sidebar
  // navigation (see .navLocked in the CSS) so a click elsewhere can't
  // silently discard an in-progress edit.
  function isEditLocked() { return !!state.editingSectionId; }

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
  // manual roster sync — "Sync now" button on Roster & Compliance,
  // calls the same GET /api/manual/sync-roster?force=1 endpoint the
  // Friday cron uses (requires role accounts/manager, same as this
  // whole page). On success, reloads /api/manual so the new snapshot
  // date and rows show immediately without a page refresh.
  // ---------------------------------------------------------------
  async function runManualSync() {
    if (state.syncing) return;
    state.syncing = true;
    state.syncNote = null;
    state.syncNoteType = null;
    render();
    try {
      const token = await window.DealSheetAuth.getToken();
      const res = await fetch(`${cfg.apiBase}/api/manual/sync-roster?force=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let body = null;
      try { body = await res.json(); } catch { /* empty */ }
      if (!res.ok) throw new Error(body?.error || `Sync failed (${res.status})`);

      const data = await loadData();
      state.manual = data.manual;
      state.dashboard = data.dashboard;

      const c = body?.counts;
      state.syncNote = c
        ? `Synced — ${c.roster} roster, ${c.brokerContractAudits} audit, ${c.openIssuesRegister} issue, ${c.suppliersSponsors} supplier row(s).`
        : "Sync complete.";
      state.syncNoteType = "ok";
    } catch (e) {
      state.syncNote = e.message || "Sync failed.";
      state.syncNoteType = "bad";
    } finally {
      state.syncing = false;
      render();
    }
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

  // dd/mm/yyyy — used for Work Anniversary specifically, where (unlike
  // DOB/license expiry elsewhere on this tab) the year is the point: it's
  // shown alongside the completed-years count, e.g. "04/10/1996 (29)".
  function fmtDDMMYYYY(s) {
    const d = parseISO(s);
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  // Full years completed as of today — counts down until the date's
  // month+day has actually occurred this year (so someone whose
  // anniversary hasn't happened yet this calendar year still shows last
  // year's completed count, not this year's not-yet-reached one).
  function yearsCompleted(dateStr) {
    const d = parseISO(dateStr);
    if (!d) return null;
    const t = today();
    let years = t.getFullYear() - d.getFullYear();
    const hadAnniversaryThisYear =
      t.getMonth() > d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() >= d.getDate());
    if (!hadAnniversaryThisYear) years--;
    return years;
  }

  function licenseExpiryStatus(dateStr) {
    if (!dateStr) return { cls: "dim", label: "—" };
    const d = parseISO(dateStr), t = today();
    const thisMonth = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth();
    // Simple monthly check, matching how the team actually works the list:
    // red + "Due dd/mm" only for a renewal due in the CURRENT calendar
    // month (whatever the day), everything else — future or past — shows
    // green with just the plain date.
    if (thisMonth) return { cls: "bad", label: `Due ${fmtDDMM(dateStr)}` };
    return { cls: "ok", label: fmtDDMM(dateStr) };
  }

  // Work Anniversary column (Roster & Compliance) — red when the
  // anniversary falls in the current calendar month (any year), green
  // otherwise; always shows the date plus the completed-years count,
  // e.g. "04/10/1996 (29)".
  function workAnniversaryStatus(dateStr) {
    if (!dateStr) return { cls: "dim", label: "—" };
    const years = yearsCompleted(dateStr);
    const label = `${fmtDDMMYYYY(dateStr)}${years != null ? ` (${years})` : ""}`;
    return { cls: isThisMonth(dateStr) ? "bad" : "ok", label };
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
  // sidebar icons — small stroke-style SVGs (mirrors the icon-led
  // nav pattern from the reference dashboard design). Chapter icons
  // are picked by keyword match against the chapter title, since the
  // manual's chapters/sections come from the API at runtime rather
  // than being hardcoded here; a generic document icon is the
  // fallback for anything that doesn't match.
  // ---------------------------------------------------------------
  function svgIcon(paths) {
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }
  const ICON = {
    doc: svgIcon(`<path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>`),
    shield: svgIcon(`<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>`),
    people: svgIcon(`<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.9.4 5 2.6 5 5.8"/>`),
    briefcase: svgIcon(`<rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>`),
    megaphone: svgIcon(`<path d="M3 10v4a1 1 0 0 0 1 1h2l4 4V5l-4 4H4a1 1 0 0 0-1 1z"/><path d="M14 8.5a4 4 0 0 1 0 7"/><path d="M17.5 6a8 8 0 0 1 0 12"/>`),
    dollar: svgIcon(`<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M15 9.2c0-1.2-1.3-2.2-3-2.2-1.8 0-3 1-3 2.4 0 3 6 1.4 6 4.4 0 1.4-1.4 2.4-3 2.4-1.8 0-3-1-3-2.2"/>`),
    lock: svgIcon(`<rect x="4.5" y="10.5" width="15" height="9.5" rx="1.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>`),
    book: svgIcon(`<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 5.5v15.5"/>`),
    alert: svgIcon(`<path d="M12 3l10 18H2z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/>`),
    truck: svgIcon(`<rect x="2" y="7" width="13" height="10" rx="1"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="7" cy="19" r="1.6"/><circle cx="18" cy="19" r="1.6"/>`),
    trophy: svgIcon(`<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4"/><path d="M12 13v3M9 20h6M10 16.5h4v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z"/>`),
    grid: svgIcon(`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`),
    chevron: svgIcon(`<path d="M9 6l6 6-6 6"/>`),
  };
  const CHAPTER_ICON_RULES = [
    [/govern|complian|code of conduct|conduct|policy|policies/i, "shield"],
    [/hr|people|staff|team|culture|induction|onboard/i, "people"],
    [/brokerage|sales|listing|deal|operation/i, "briefcase"],
    [/marketing|brand|communicat/i, "megaphone"],
    [/finance|account|invoice|budget|commission/i, "dollar"],
    [/risk|it\b|technology|system|security|privacy/i, "lock"],
    [/award|recognit/i, "trophy"],
  ];
  function chapterIcon(title) {
    const t = title || "";
    for (const [re, key] of CHAPTER_ICON_RULES) if (re.test(t)) return ICON[key];
    return ICON.doc;
  }
  const DASH_ICON = {
    roster: ICON.people, supervision: ICON.shield, audits: ICON.briefcase,
    issues: ICON.alert, suppliers: ICON.truck, reinz: ICON.trophy,
  };

  // A chapter with no explicit entry in state.collapsedChapters starts
  // collapsed, EXCEPT the chapter holding whatever manual section is
  // currently open — so landing on a section always shows it in
  // context, but the rest of the nav stays tidy (accordion / cascading
  // dropdown behaviour) instead of dumping all ~30 sections at once.
  function isChapterCollapsed(ch) {
    if (Object.prototype.hasOwnProperty.call(state.collapsedChapters, ch.id)) {
      return state.collapsedChapters[ch.id];
    }
    return !(state.view === "manual" && ch.sections.some((s) => s.id === state.sectionId));
  }

  // ---------------------------------------------------------------
  // render: shell
  // ---------------------------------------------------------------
  function render() {
    const locked = isEditLocked();
    $("app").innerHTML = `
      <aside class="sidebar ${locked ? "navLocked" : ""}">
        <a class="backLink" href="accounts.html">&larr; Back to Deal Sheets</a>
        <div class="sideBrand">
          <img src="img/colliers-logo.png" alt="" onerror="this.style.display='none'">
          <div class="t"><strong>Operations Manual</strong><span>Colliers Canterbury</span></div>
        </div>
        ${locked ? `<div class="navLockedNote">Finish or cancel your edit to navigate away</div>` : ""}
        <div class="searchBox">
          <span class="ico">&#128269;</span>
          <input id="manualSearch" type="search" placeholder="Search the manual…" value="${esc(state.query)}" autocomplete="off" ${locked ? "disabled" : ""} />
          ${state.query ? `<button class="clearBtn" id="clearSearch" title="Clear">&times;</button>` : ""}
        </div>
        ${renderToc()}
        <div class="tocDashDivider">
          <div class="tocGroupBtn tocGroupHeading"><span class="tocIcon">${ICON.grid}</span><span class="tocLabel">Team Dashboard</span></div>
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
    return `<button class="dashNavBtn ${on ? "on" : ""}" data-dash="${key}">
      <span class="tocIcon">${DASH_ICON[key] || ICON.doc}</span>
      <span class="tocLabel">${esc(label)}</span>
      <span class="cnt">${count}</span>
    </button>`;
  }

  function renderToc() {
    if (state.query.trim()) {
      const results = searchManual(state.query);
      return `<div class="searchMeta">${results.length} result${results.length === 1 ? "" : "s"}</div>`;
    }
    return `<nav class="toc">${state.manual.chapters.map((ch) => {
      const open = !isChapterCollapsed(ch);
      return `
      <div class="tocGroup">
        <button class="tocGroupBtn ${open ? "open" : ""}" data-chapter="${ch.id}" aria-expanded="${open}">
          <span class="tocIcon">${chapterIcon(ch.title)}</span>
          <span class="tocLabel">${esc(ch.title)}</span>
          <span class="tocChevron">${ICON.chevron}</span>
        </button>
        <div class="tocSubList ${open ? "open" : ""}">
          <div class="tocSubInner">
            ${ch.sections.map((sec) => `
              <button class="tocSection ${state.view === "manual" && state.sectionId === sec.id ? "on" : ""}" data-section="${sec.id}">
                <span class="num">${esc(sec.num)}</span><span>${esc(sec.title)}</span>
              </button>`).join("")}
          </div>
        </div>
      </div>`;
    }).join("")}</nav>`;
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
      const ch = state.manual.chapters.find((c) => c.id === b.dataset.chapter);
      state.collapsedChapters[b.dataset.chapter] = !isChapterCollapsed(ch);
      render();
    });
    $("app").querySelectorAll("[data-section]").forEach((b) => b.onclick = () => {
      state.view = "manual"; state.sectionId = b.dataset.section; state.query = "";
      render(); window.scrollTo(0, 0);
    });
    $("app").querySelectorAll("[data-dash]").forEach((b) => b.onclick = () => {
      state.view = "dashboard"; state.dashTab = b.dataset.dash; state.dashQuery = ""; state.selectedAgent = null;
      state.syncNote = null; state.syncNoteType = null;
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
    wireManualSection();
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

  // Sections the in-page editor can't safely handle yet:
  //  - anything containing a <table> (Document Control's version table,
  //    4.8's PI insurance staff table) — Quill 1.x has no table support.
  //  - "1-4" (Org Directory) — its stored html contains the
  //    <div id="orgDirectory"> placeholder that renderOrgDirectory()
  //    fills in live from the roster; editing it in Quill risks
  //    deleting that placeholder and silently breaking the directory.
  // Both are v1 limitations, not permanent — flagged in the build log.
  function sectionEditLimitation(sec) {
    if (sec.id === "1-4") return "This page shows the live team directory and can't be edited here yet.";
    if (/<table[\s>]/i.test(sec.html)) return "This page contains a table, which the in-page editor can't handle yet — edit the Word doc backup and ask your developer to update it, or contact support.";
    return null;
  }

  function renderManualSection() {
    const { chapter, sec } = currentSection();
    if (!state.sectionId) state.sectionId = sec.id;
    const editing = state.editingSectionId === sec.id;

    if (editing) {
      const d = state.editDraft || { num: sec.num || "", title: sec.title, html: sec.html };
      return `
        <div class="contentHead">
          <div>
            <p class="crumb">${esc(chapter.title)}</p>
            <div class="editTitleRow">
              <input class="editNumInput" id="editNumInput" value="${esc(d.num)}" placeholder="No." aria-label="Section number" ${state.saving ? "disabled" : ""} />
              <input class="editTitleInput" id="editTitleInput" value="${esc(d.title)}" placeholder="Section title" aria-label="Section title" ${state.saving ? "disabled" : ""} />
            </div>
          </div>
          <div class="metaRight editActions">
            <button class="editCancelBtn" id="editCancelBtn" ${state.saving ? "disabled" : ""}>Cancel</button>
            <button class="editSaveBtn" id="editSaveBtn" ${state.saving ? "disabled" : ""}>${state.saving ? `<span class="spinner"></span>Saving…` : "Save"}</button>
          </div>
        </div>
        <div class="manualBody editingBody">
          <div id="quillToolbar">
            <span class="ql-formats">
              <select class="ql-header">
                <option value="4">Sub-heading</option>
                <option selected>Normal</option>
              </select>
            </span>
            <span class="ql-formats">
              <button class="ql-bold" title="Bold"></button>
              <button class="ql-italic" title="Italic"></button>
              <button class="ql-underline" title="Underline"></button>
              <button class="ql-code" title="Inline code"></button>
            </span>
            <span class="ql-formats">
              <button class="ql-list" value="ordered" title="Numbered list"></button>
              <button class="ql-list" value="bullet" title="Bullet list"></button>
            </span>
            <span class="ql-formats">
              <button class="ql-link" title="Link"></button>
            </span>
            <span class="ql-formats">
              <button type="button" class="ql-noteBox manualFmtBtn" title="Highlighted note box">Note box</button>
              <button type="button" class="ql-warnBoxInline manualFmtBtn" title="Inline warning highlight">Warning text</button>
            </span>
            <span class="ql-formats">
              <button class="ql-clean" title="Clear formatting"></button>
            </span>
          </div>
          <div id="quillEditor"></div>
        </div>
      `;
    }

    const limitation = sectionEditLimitation(sec);
    return `
      <div class="contentHead">
        <div><p class="crumb">${esc(chapter.title)}</p><h1>${esc(sec.num ? `${sec.num} ` : "")}${esc(sec.title)}</h1></div>
        <div class="metaRight">
          <div class="metaRightTop">
            <span>Last updated ${esc(state.manual.updated)}</span>
            <button class="editBtn" id="editSectionBtn" ${limitation ? `disabled title="${esc(limitation)}"` : ""}>
              <span class="editIco">&#9998;</span>Edit this page
            </button>
          </div>
        </div>
      </div>
      <div class="manualBody">${sec.html}</div>
    `;
  }

  // ---------------------------------------------------------------
  // in-place editing — "Edit this page" / Save / Cancel. The web page
  // is the source of truth for manual content (2026-09-07 on); saves
  // go to POST /api/manual/save-section, which records the previous
  // version to manual_section_history before overwriting. The Word
  // doc backup is kept for reference only and is no longer wired to
  // anything.
  // ---------------------------------------------------------------
  let quillInstance = null;

  function registerQuillFormats() {
    if (window.__manualFormatsRegistered || !window.Quill) return;
    try {
      const Parchment = window.Quill.import("parchment");
      class BoolClassAttributor extends Parchment.Attributor.Class {
        add(node, value) {
          if (value) { node.classList.add(this.keyName); return true; }
          this.remove(node);
          return true;
        }
        remove(node) { node.classList.remove(this.keyName); }
        value(node) { return node.classList.contains(this.keyName) ? true : undefined; }
      }
      const scope = Parchment.Scope;
      const formats = [
        new BoolClassAttributor("noteBox", "noteBox", { scope: scope.BLOCK }),
        new BoolClassAttributor("stub", "stub", { scope: scope.BLOCK }),
        new BoolClassAttributor("warnBoxInline", "warnBoxInline", { scope: scope.INLINE }),
        new BoolClassAttributor("youAreHere", "youAreHere", { scope: scope.INLINE }),
      ];
      formats.forEach((f) => window.Quill.register(f, true));
      window.__manualFormatsRegistered = true;
    } catch (e) {
      console.error("Operations Manual: custom Quill formats failed to register — noteBox/warnBox styling may not round-trip.", e);
    }
  }

  function initQuill() {
    const el = $("quillEditor");
    if (!el || !window.Quill) return;
    registerQuillFormats();
    try {
      quillInstance = new window.Quill(el, {
        theme: "snow",
        modules: { toolbar: "#quillToolbar" },
      });
      try {
        quillInstance.clipboard.addMatcher("p.noteBox", (node, delta) => applyBoolFormat(delta, "noteBox"));
        quillInstance.clipboard.addMatcher("p.stub", (node, delta) => applyBoolFormat(delta, "stub"));
        quillInstance.clipboard.addMatcher("span.warnBoxInline", (node, delta) => applyBoolFormat(delta, "warnBoxInline"));
        quillInstance.clipboard.addMatcher("span.youAreHere", (node, delta) => applyBoolFormat(delta, "youAreHere"));
      } catch (e) { console.error("Operations Manual: Quill clipboard matchers failed to register.", e); }

      const html = (state.editDraft && state.editDraft.html) || "";
      quillInstance.setContents(quillInstance.clipboard.convert(html));
      quillInstance.history.clear();
    } catch (e) {
      console.error("Operations Manual: Quill failed to initialise.", e);
      el.innerHTML = `<p class="dimText">The editor couldn't load. Try Cancel and Edit this page again, or reload the page.</p>`;
    }
  }

  function applyBoolFormat(delta, name) {
    const Delta = window.Quill.import("delta");
    return delta.compose(new Delta().retain(delta.length(), { [name]: true }));
  }

  function destroyQuill() { quillInstance = null; }

  function showEditError(msg) {
    const head = document.querySelector(".editActions");
    if (!head) return;
    let box = $("editErrorBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "editErrorBox";
      box.className = "syncNote bad editErrorBox";
      head.prepend(box);
    }
    box.textContent = msg;
  }
  function clearEditError() {
    const box = $("editErrorBox");
    if (box) box.remove();
  }

  function wireManualSection() {
    const editBtn = $("editSectionBtn");
    if (editBtn && !editBtn.disabled) {
      editBtn.onclick = () => {
        const { sec } = currentSection();
        state.editingSectionId = sec.id;
        state.editDraft = { num: sec.num || "", title: sec.title, html: sec.html };
        state.saveError = null;
        render();
      };
    }

    const cancelBtn = $("editCancelBtn");
    if (cancelBtn) cancelBtn.onclick = () => {
      if (state.saving) return;
      state.editingSectionId = null;
      state.editDraft = null;
      state.saveError = null;
      destroyQuill();
      render();
    };

    const saveBtn = $("editSaveBtn");
    if (saveBtn) saveBtn.onclick = () => saveManualSection();

    if (state.editingSectionId) initQuill();
  }

  async function saveManualSection() {
    if (state.saving || !quillInstance) return;
    const { sec } = currentSection();
    const numInput = $("editNumInput");
    const titleInput = $("editTitleInput");
    const saveBtn = $("editSaveBtn");
    const cancelBtn = $("editCancelBtn");

    const num = (numInput ? numInput.value : "").trim();
    const title = (titleInput ? titleInput.value : "").trim();
    if (!title) { showEditError("Title can't be empty."); return; }
    if (!quillInstance.getText().trim()) { showEditError("Content can't be empty."); return; }
    const html = quillInstance.root.innerHTML;

    clearEditError();
    state.saving = true;
    state.editDraft = { num, title, html };
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = `<span class="spinner"></span>Saving…`; }
    if (cancelBtn) cancelBtn.disabled = true;
    if (numInput) numInput.disabled = true;
    if (titleInput) titleInput.disabled = true;

    try {
      if (cfg.DEMO_MODE) throw new Error("Editing is disabled in demo mode.");
      const token = await window.DealSheetAuth.getToken();
      const res = await fetch(`${cfg.apiBase}/api/manual/save-section`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: sec.id, num, title, html }),
      });
      let respBody = null;
      try { respBody = await res.json(); } catch { /* empty */ }
      if (!res.ok) throw new Error(respBody?.error || `Save failed (${res.status})`);

      const saved = respBody?.section || {};
      sec.num = saved.num ?? num;
      sec.title = saved.title ?? title;
      sec.html = saved.html ?? html;
      sec.text = saved.text ?? sec.text;
      if (saved.updated_at) state.manual.updated = String(saved.updated_at).slice(0, 10);

      state.saving = false;
      state.editingSectionId = null;
      state.editDraft = null;
      destroyQuill();
      render();
      window.scrollTo(0, 0);
    } catch (e) {
      state.saving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = "Save"; }
      if (cancelBtn) cancelBtn.disabled = false;
      if (numInput) numInput.disabled = false;
      if (titleInput) titleInput.disabled = false;
      showEditError(e.message || "Save failed.");
    }
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
    const showSync = state.dashTab === "roster" && !cfg.DEMO_MODE;
    return `
      <div class="contentHead">
        <div><p class="crumb">Team Dashboard</p><h1>${esc(heads[state.dashTab])}</h1></div>
        <div class="metaRight">
          <div class="metaRightTop">
            <span>Data as of ${esc(fmtDate(d.snapshotDate))}</span>
            ${showSync ? `
              <button class="syncBtn" id="syncRosterBtn" ${state.syncing ? "disabled" : ""} title="Pull the latest data from Real Estate Agent Management Dashboard.xlsx">
                ${state.syncing ? `<span class="spinner"></span>Syncing…` : `<span class="syncIco">&#8635;</span>Sync now`}
              </button>` : ""}
          </div>
          <div>from Real Estate Agent Management Dashboard.xlsx</div>
          ${showSync && state.syncNote ? `<div class="syncNote ${state.syncNoteType}">${esc(state.syncNote)}</div>` : ""}
        </div>
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
    const anniversaryAgents = d.roster.filter((a) => isThisMonth(a.workAnniversary));
    const anniversaries = anniversaryAgents.length;
    const anniversaryTitle = anniversaryAgents
      .map((a) => `${a.firstName} ${a.surname} — ${fmtDayMonth(a.workAnniversary)} (${yearsCompleted(a.workAnniversary)} yrs)`).join("\n");
    const suspended = d.roster.filter(isSuspended).length;

    const selected = state.selectedAgent ? d.roster.find((a) => `${a.firstName}|${a.surname}` === state.selectedAgent) : null;

    return `
      <div class="statGrid">
        <div class="statCard"><div class="n">${d.roster.length}</div><div class="l">Team members</div></div>
        <div class="statCard ${expiringSoon ? "bad" : "ok"}"><div class="n">${expiringSoon}</div><div class="l">Licenses due this month</div></div>
        <div class="statCard ${trainingBehind ? "warn" : "ok"}"><div class="n">${trainingBehind}</div><div class="l">Behind on verifiable training</div></div>
        <div class="statCard ${suspended ? "bad" : "ok"}"><div class="n">${suspended}</div><div class="l">Suspended licenses</div></div>
        <div class="statCard"${birthdays ? ` title="${esc(birthdayTitle)}"` : ""}><div class="n">${birthdays}</div><div class="l">Birthdays this month</div></div>
        <div class="statCard"${anniversaries ? ` title="${esc(anniversaryTitle)}"` : ""}><div class="n">${anniversaries}</div><div class="l">Work anniversaries this month</div></div>
      </div>
      <div class="dashHead">
        <input class="dashSearch" id="dashSearch" placeholder="Search name, role, email…" value="${esc(state.dashQuery)}" />
      </div>
      <div class="dashTableWrap"><table class="dashTable">
        <thead><tr>
          <th data-sort="firstName">Name</th><th data-sort="jobTitle">Role</th>
          <th data-sort="workAnniversary">Work Anniversary</th><th>Licence #</th>
          <th data-sort="licenseExpiry">Licence Expiry</th><th>Verifiable</th><th>Non-Verifiable</th>
          <th data-sort="supervisionLevel">Supervision</th><th>Mobile</th>
        </tr></thead>
        <tbody>
          ${rows.map((a) => `
            <tr class="agentRow" data-agent="${esc(a.firstName)}|${esc(a.surname)}">
              <td><strong>${esc(a.firstName)} ${esc(a.surname)}</strong>${isThisMonth(a.dob) ? ` <span class="pill ok" title="Birthday: ${esc(fmtDayMonth(a.dob))}">🎂 this month</span>` : ""}</td>
              <td>${esc(a.jobTitle || "—")}</td>
              <td>${pill(workAnniversaryStatus(a.workAnniversary))}</td>
              <td class="mono">${esc(a.licenceNumber || "—")}${isSuspended(a) ? ' <span class="pill warn">Suspended</span>' : ""}</td>
              <td>${a.licenceNumber ? pill(licenseExpiryStatus(a.licenseExpiry)) : '<span class="dimText">—</span>'}</td>
              <td>${a.licenceNumber ? pill(hoursStatus(a.verifiableHours)) : '<span class="dimText">—</span>'}</td>
              <td>${a.licenceNumber ? pill(hoursStatus(a.nonVerifiableHours)) : '<span class="dimText">—</span>'}</td>
              <td>${esc(a.supervisionLevel || "—")}${a.supervisionFrequency ? ` <span class="dimText">(${esc(a.supervisionFrequency)})</span>` : ""}</td>
              <td class="mono">${esc(a.mobile || "—")}</td>
            </tr>`).join("") || `<tr><td colspan="9"><div class="emptyState">No matches.</div></td></tr>`}
        </tbody>
      </table></div>
      <p class="smallNote">Red = license renewal or work anniversary falling this calendar month; work anniversary shows the completed years in brackets. Verifiable/non-verifiable training hours are green at 10+ hours, red below — each broker needs 10 verifiable CPD hours completed by 31 December.</p>
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
    const syncBtn = $("syncRosterBtn");
    if (syncBtn) syncBtn.onclick = () => runManualSync();
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

  // Warn before an accidental tab close/refresh drops an open edit —
  // there's no autosave/draft-recovery in v1.
  window.addEventListener("beforeunload", (e) => {
    if (isEditLocked() && !state.saving) { e.preventDefault(); e.returnValue = ""; }
  });

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
