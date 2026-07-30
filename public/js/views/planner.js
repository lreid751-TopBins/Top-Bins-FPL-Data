import { S, f1, f2, n } from "../store.js";
import {
  PL, SQUAD_RULES, POSITION_ORDER,
  draftPlayers, countByPosition, spend, budgetLeft, canAdd, addPlayer,
  removePlayer, isComplete, needed, squadTotals,
  loadSquads, loadIntoDraft, newDraft, saveDraft, deleteSquad,
} from "../planner.js";
import { $, $$, esc, fixtureStrip, availabilityFlag, sparkline } from "../ui.js";

export function renderPlanner(root) {
  const rerender = () => renderPlanner(root);

  if (!PL.loaded && !PL.loading) loadSquads().then(rerender);
  if (PL.loading && !PL.loaded) {
    root.innerHTML = `<div class="empty"><div class="anton">Opening the planner</div>Loading your saved squads.</div>`;
    return;
  }

  const totals = squadTotals();
  const pos = countByPosition();
  const left = budgetLeft();
  const complete = isComplete();

  root.innerHTML = `
    <div class="eyebrow">Planning</div>
    <div class="section-head">
      <h2>Squad Planner</h2>
      <div class="controls">
        <button class="btn ghost" id="plNew">+ New squad</button>
      </div>
    </div>
    ${PL.error ? `<p class="neg" style="margin-top:-6px">${esc(PL.error)}</p>` : ""}

    ${savedSquadsBar()}

    <div class="planner-grid">
      <div class="planner-build">
        ${draftHeader()}
        ${budgetBar(left)}
        ${positionRows()}
        ${addRow()}
      </div>
      <aside class="planner-side">
        ${totalsPanel(totals, complete)}
      </aside>
    </div>
  `;

  wire(root, rerender);
}

/* ---------------- Saved squads selector ---------------- */
function savedSquadsBar() {
  if (!PL.squads.length) {
    return `<p class="hint" style="margin-bottom:14px">No saved squads yet. Build one below and save it — you can keep several side by side to compare.</p>`;
  }
  return `<div class="squad-tabs">
    ${PL.squads
      .map(
        (sq) => `<button class="squad-tab ${sq.id === PL.activeId ? "on" : ""}" data-load="${sq.id}">
          <span class="st-name">${esc(sq.name)}</span>
          <span class="st-meta">${sq.picks.length}/15</span>
          <span class="st-x" data-del="${sq.id}" title="Delete" role="button">×</span>
        </button>`
      )
      .join("")}
  </div>`;
}

/* ---------------- Draft header (name + note) ---------------- */
function draftHeader() {
  return `<div class="draft-head">
    <input id="plName" class="draft-name" value="${esc(PL.draft.name)}" maxlength="60" aria-label="Squad name">
    <input id="plNote" class="draft-note" placeholder="Optional note — e.g. GW1 wildcard draft" value="${esc(PL.draft.note)}" maxlength="400" aria-label="Squad note">
  </div>`;
}

/* ---------------- Budget bar ---------------- */
function budgetBar(left) {
  const used = spend();
  const pct = Math.min(100, (used / SQUAD_RULES.budget) * 100);
  const over = left < -1e-9;
  return `<div class="budget">
    <div class="budget-line">
      <span>Spent <b class="mono">£${f1(used)}</b></span>
      <span class="${over ? "neg" : left < 0.5 ? "" : "pos"}">
        ${over ? "Over by £" + f1(-left) : "£" + f1(left) + " left"}
      </span>
    </div>
    <div class="budget-track"><span class="budget-fill ${over ? "over" : ""}" style="width:${pct}%"></span></div>
  </div>`;
}

/* ---------------- Position rows ---------------- */
function positionRows() {
  const byPos = {};
  POSITION_ORDER.forEach((k) => (byPos[k] = []));
  draftPlayers().forEach((p) => byPos[p.pos].push(p));

  return `<div class="pos-rows">
    ${POSITION_ORDER.map((posKey) => {
      const have = byPos[posKey].length;
      const want = SQUAD_RULES.positions[posKey];
      const slots = [];
      for (let i = 0; i < want; i++) {
        const p = byPos[posKey][i];
        slots.push(p ? filledSlot(p) : emptySlot(posKey));
      }
      return `<div class="pos-row">
        <div class="pos-label"><span class="pos-chip pos-${posKey}">${posKey}</span>
          <span class="hint">${have}/${want}</span></div>
        <div class="slot-strip">${slots.join("")}</div>
      </div>`;
    }).join("")}
  </div>`;
}

function filledSlot(p) {
  const isC = PL.draft.captain === p.id;
  const isV = PL.draft.vice === p.id;
  const jersey = p.jersey
    ? `<img class="slot-jersey" src="${p.jersey}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : "";
  return `<div class="slot filled">
    <div class="slot-top">
      ${isC ? '<span class="cap-badge c">C</span>' : isV ? '<span class="cap-badge v">V</span>' : ""}
      <button class="slot-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
    </div>
    ${jersey}
    <div class="slot-name">${esc(p.name)}${availabilityFlag(p)}</div>
    <div class="slot-meta">${esc(p.short)} · £${f1(p.price)}</div>
    <div class="slot-stats">
      <span title="Expected goal involvements">xGI ${f2(p.xgi)}</span>
      <span title="Expected minutes next GW">${p.xMin}'</span>
    </div>
    <div class="slot-fx">${fixtureStrip(p.teamId, 5)}</div>
    <div class="slot-cap">
      <button class="mini ${isC ? "on" : ""}" data-cap="${p.id}">C</button>
      <button class="mini ${isV ? "on" : ""}" data-vice="${p.id}">V</button>
    </div>
  </div>`;
}

function emptySlot(posKey) {
  return `<div class="slot empty" data-addpos="${posKey}">
    <div class="slot-plus">+</div>
    <div class="slot-meta">${posKey}</div>
  </div>`;
}

/* ---------------- Add-player search ---------------- */
function addRow() {
  return `<div class="add-row">
    <div class="cand-search">
      <input id="plSearch" placeholder="Search a player to add…" autocomplete="off" aria-label="Add player">
      <div id="plDrop"></div>
    </div>
  </div>`;
}

/* ---------------- Totals / analysis panel ---------------- */
function totalsPanel(t, complete) {
  const needs = needed();
  return `<div class="totals-card">
    <div class="totals-head">
      <span class="anton">Squad analysis</span>
      <span class="hint">${t.count}/15</span>
    </div>

    ${
      complete
        ? `<div class="totals-ok">Full, legal squad ✓</div>`
        : `<div class="totals-need">Still need: ${needs.map((x) => `${x.want} ${x.pos}`).join(", ")}</div>`
    }

    <div class="totals-grid">
      ${totalStat("Squad xGI", f2(t.xgi), "season expected goal involvements")}
      ${totalStat("Total DEFCON", Math.round(t.defcon), "defensive contributions")}
      ${totalStat("Avg xMin", t.xMin + "'", "mean expected minutes")}
      ${totalStat("Threat", Math.round(t.threat), "attacking threat index")}
      ${totalStat("Fixture ease", f2(t.avgFdr), "avg difficulty next 5, lower is kinder")}
      ${totalStat("Pen takers", t.penTakers, "first-choice penalties in squad")}
    </div>

    <div class="totals-foot">
      <div class="budget-line" style="font-size:12px">
        <span>Spent £${f1(t.spend)}</span>
        <span class="${t.left < 0 ? "neg" : "pos"}">£${f1(t.left)} left</span>
      </div>
    </div>

    <button class="btn primary" id="plSave" style="width:100%;margin-top:12px" ${PL.saving ? "disabled" : ""}>
      ${PL.saving ? "Saving…" : PL.activeId ? "Save changes" : "Save squad"}
    </button>
    ${PL.formError ? `<p class="neg" style="margin-top:10px;font-size:12px">${esc(PL.formError)}</p>` : ""}
    <p class="hint" style="margin-top:10px">Prices and stats are always live — a saved squad stores only who's in it, never a frozen number.</p>
  </div>`;
}

function totalStat(label, value, help) {
  return `<div class="tstat" title="${esc(help)}">
    <div class="tstat-v">${value}</div>
    <div class="tstat-l">${esc(label)}</div>
  </div>`;
}

/* ---------------- Events ---------------- */
function wire(root, rerender) {
  const bind = (sel, ev, fn) => { const el = $(sel, root); if (el) el[ev] = fn; };

  bind("#plNew", "onclick", () => { newDraft(); rerender(); });
  bind("#plName", "oninput", (e) => { PL.draft.name = e.target.value; });
  bind("#plNote", "oninput", (e) => { PL.draft.note = e.target.value; });

  // Load / delete saved squads
  $$("[data-load]", root).forEach((b) => {
    b.onclick = (e) => {
      if (e.target.closest("[data-del]")) return; // let delete handle it
      const sq = PL.squads.find((s) => s.id === b.dataset.load);
      if (sq) { loadIntoDraft(sq); rerender(); }
    };
  });
  $$("[data-del]", root).forEach((x) => {
    x.onclick = async (e) => {
      e.stopPropagation();
      if (confirm("Delete this squad?")) { await deleteSquad(x.dataset.del); rerender(); }
    };
  });

  // Remove / captain / vice
  $$("[data-remove]", root).forEach((b) => {
    b.onclick = () => { removePlayer(+b.dataset.remove); rerender(); };
  });
  $$("[data-cap]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.cap;
      PL.draft.captain = PL.draft.captain === id ? null : id;
      if (PL.draft.vice === id) PL.draft.vice = null;
      rerender();
    };
  });
  $$("[data-vice]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.vice;
      PL.draft.vice = PL.draft.vice === id ? null : id;
      if (PL.draft.captain === id) PL.draft.captain = null;
      rerender();
    };
  });

  // Empty slot click → focus search
  $$("[data-addpos]", root).forEach((s) => {
    s.onclick = () => { const el = $("#plSearch", root); if (el) el.focus(); };
  });

  // Player search
  const search = $("#plSearch", root);
  const drop = $("#plDrop", root);
  if (search)
    search.oninput = () => {
      const q = search.value.toLowerCase().trim();
      if (!q) { drop.innerHTML = ""; return; }
      const inSquad = new Set(PL.draft.picks.map((pk) => pk.id));
      const hits = S.players
        .filter((p) => !inSquad.has(p.id) &&
          (p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
        .sort((a, b) => b.total_points - a.total_points)
        .slice(0, 10);
      drop.innerHTML = `<div class="cand-drop">${
        hits.length
          ? hits.map((p) => {
              const check = canAdd(p);
              return `<button data-add="${p.id}" ${check.ok ? "" : "disabled"}>
                <span>${esc(p.name)} <span class="sub-t">${p.short} · ${p.pos}</span></span>
                <span class="m">£${f1(p.price)}${check.ok ? "" : " · " + esc(check.reason)}</span>
              </button>`;
            }).join("")
          : `<button disabled style="color:var(--muted)">No player by that name</button>`
      }</div>`;
      $$("[data-add]", drop).forEach((b) => {
        b.onclick = () => {
          const p = S.playerById[b.dataset.add];
          if (p) addPlayer(p);
          rerender();
          $("#plSearch", root)?.focus();
        };
      });
    };

  bind("#plSave", "onclick", async () => {
    PL.saving = true; rerender();
    await saveDraft();
    rerender();
  });
}
