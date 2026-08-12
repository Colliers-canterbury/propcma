// /public/js/deal-board-api.js
//
// Data layer for the deal board. Mirrors js/api.js: DEMO_MODE runs
// against an in-memory mock so the page is fully clickable with no
// backend; otherwise it calls /api/deal-board/*.
//
// Reuses window.DealSheetAuth for tokens — same tenant, same app
// registration, same MSAL instance as the deal sheets.

(function () {
  const cfg = window.DealSheetConfig;

  async function call(path, { method = "GET", body } = {}) {
    const token = await window.DealSheetAuth.getToken();
    const res = await fetch(`${cfg.apiBase}/api/deal-board${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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

  const live = {
    getBoard: (dept) => call(`?dept=${encodeURIComponent(dept)}`),
    addDeal: (dept, stageId, fields) =>
      call("", { method: "POST", body: { dept, stageId, ...fields } }),
    editDeal: (id, fields) =>
      call(`/${id}`, { method: "PATCH", body: fields }),
    moveDeal: (id, stageId, afterId) =>
      call(`/${id}/move`, { method: "POST", body: { stageId, afterId } }),
    removeDeal: (id) => call(`/${id}`, { method: "DELETE" }),

    saveMeeting: (dept, date, patch) =>
      call("/meeting", { method: "POST", body: { dept, date, ...patch } }),
    setFine: (dept, date, brokerCode, amount) =>
      call("/fine", { method: "POST", body: { dept, date, brokerCode, amount } }),

    addRequirement: (dept, fields) =>
      call("/requirements", { method: "POST", body: { dept, ...fields } }),
    editRequirement: (id, fields) =>
      call(`/requirements/${id}`, { method: "PATCH", body: fields }),
    removeRequirement: (id) =>
      call(`/requirements/${id}`, { method: "DELETE" }),

    rollForward: (dept, nextDate) =>
      call("/roll-forward", { method: "POST", body: { dept, nextDate } }),

    listBrokers: () => call("/brokers"),
    addNote: (dept, section, body) =>
      call("/notes", { method: "POST", body: { dept, section, body } }),
    editNote: (id, body) =>
      call(`/notes/${id}`, { method: "PATCH", body: { body } }),
    clearNote: (id) => call(`/notes/${id}`, { method: "DELETE" }),

    settleFine: (dept, brokerCode, amount, note) =>
      call("/settle-fine", { method: "POST", body: { dept, brokerCode, amount, note } }),
    rankings: (dept, year) =>
      call(`/rankings?dept=${encodeURIComponent(dept)}${year?`&year=${year}`:""}`),
    finesYtd: (dept, year) =>
      call(`/fines-ytd?dept=${encodeURIComponent(dept)}${year?`&year=${year}`:""}`),
  };

  // ── demo backend ────────────────────────────────────────────────
  // Seeded from the two meeting workbooks so the page is usable
  // before the importer has run.
  const demoSeed = window.DealBoardDemoSeed || null;
  const demo = (() => {
    if (!demoSeed) return live;
    const store = JSON.parse(JSON.stringify(demoSeed));
    const wait = (v) => new Promise((r) =>
      setTimeout(() => r(JSON.parse(JSON.stringify(v))), 80));
    const board = (dept) => store[dept];
    return {
      getBoard: (dept) => wait(board(dept)),
      addDeal: (dept, stageId, f) => {
        const d = { id: "d" + Date.now(), stage_id: stageId, address: "",
          timing: "", fee_nzd: 0, status_note: "", brokers: "", ...f };
        board(dept).deals.push(d);
        return wait(d);
      },
      editDeal: (id, f) => wait({ id, ...f }),
      moveDeal: (id, stageId) => wait({ id, stage_id: stageId }),
      removeDeal: () => wait({ ok: true }),
      saveMeeting: () => wait({ ok: true }),
      setFine: () => wait({ ok: true }),
      addRequirement: (dept, f) => wait({ id: "r" + Date.now(), ...f }),
      editRequirement: (id, f) => wait({ id, ...f }),
      removeRequirement: () => wait({ ok: true }),
      rollForward: () => wait({ archived_count: 0 }),
      listBrokers: () => wait([]),
      finesYtd: () => wait({ year: new Date().getFullYear(), total: 0, brokers: [] }),
      settleFine: () => wait({ ok: true }),
      addNote: (d, section, body) => wait({ id: "n" + Date.now(), section, body }),
      editNote: (id, body) => wait({ id, body }),
      clearNote: () => wait({ ok: true }),
      rankings: () => wait({ year: new Date().getFullYear(), brokers: [] }),
    };
  })();

  window.DealBoardApi = cfg.DEMO_MODE ? demo : live;
})();
