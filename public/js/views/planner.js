import { S, f1, f2 } from "../store.js";
import {
  PL, SQUAD_RULES, POSITION_ORDER, STARTING_XI_SIZE,
  draftPlayers, countByPosition, spend, budgetLeft, canAdd, addPlayer,
  removePlayer, isComplete, needed, squadTotals,
  startingPlayers, benchPlayers, isValidLineup, formationLabel, swapLineup,
  branchSquad, setCompare, compareTotals, transferLogDraft,
  loadSquads, loadIntoDraft, newDraft, saveDraft, deleteSquad,
} from "../planner.js";
import { J, blankDraft as blankJournalDraft } from "../journal.js";
import { $, $$, esc, fixtureChips, availabilityFlag, sparkline } from "../ui.js";
import { divergingBars } from "../charts.js";

export function renderPlanner(root) {
  const rerender = () => renderPlanner(root);

  if (!PL.loaded && !PL.loading) loadSquads().then(rerender);
  if (PL.loading && !PL.loaded) {
    root.innerHTML = `<div class="empty"><div class="anton">Opening the planner</div>Loading your saved squads.</div>`;
    return;
  }
  if (PL.error && !PL.squads.length) {
    root.innerHTML = `<div class="empty"><div class="anton">Couldn't open the planner</div>
      <p style="max-width:440px;margin:0 auto">${esc(PL.error)}</p>
      <button class="btn primary" id="plRetry" style="margin-top:14px">Try again</button></div>`;
    const r = $("#plRetry", root);
    if (r) r.onclick = () => { PL.loaded = false; PL.error = ""; rerender(); };
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
        ${squadSection()}
        ${addRow()}
        ${lineupSection(complete)}
      </div>
      <aside class="planner-side">
        ${totalsPanel(totals, complete)}
      </aside>
    </div>

    ${compareSection()}
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
          <span class="st-branch" data-branch="${sq.id}" title="Branch: clone this squad to try a swap against it">⑂</span>
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

/* ---------------- Squad list: cards (jerseys) or table (dense stats) ---------------- */
function squadSection() {
  return `<div class="squad-section-head">
    <span class="hint">Squad</span>
    <div class="seg" role="group" aria-label="Squad view">
      <button data-squadview="cards" ${PL.squadView === "cards" ? 'aria-pressed="true"' : ""}>Cards</button>
      <button data-squadview="table" ${PL.squadView === "table" ? 'aria-pressed="true"' : ""}>Table</button>
    </div>
  </div>
  ${PL.squadView === "table" ? squadTable() : squadCards()}`;
}

function squadCards() {
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

function squadTable() {
  const players = draftPlayers();
  const needs = needed();

  if (!players.length) {
    return `<p class="hint" style="margin-bottom:16px">No players yet — search below to start building.</p>`;
  }

  return `<div class="twrap" style="margin-bottom:16px">
    <table>
      <thead><tr>
        <th style="text-align:left">Player</th><th>Team</th><th>Pos</th><th>£</th>
        <th>xMin</th><th>xGI</th><th>xG</th><th>xA</th><th>DEFCON</th><th>Next 5</th><th></th>
      </tr></thead>
      <tbody>${players.map(squadTableRow).join("")}</tbody>
    </table>
  </div>
  ${needs.length ? `<p class="hint" style="margin:-10px 0 16px">Still need: ${needs.map((x) => `${x.want} ${x.pos}`).join(", ")}</p>` : ""}`;
}

function squadTableRow(p) {
  return `<tr>
    <td class="name">${esc(p.name)}${availabilityFlag(p)}</td>
    <td class="sub-t">${esc(p.short)}</td>
    <td><span class="pos-chip pos-${p.pos}">${p.pos}</span></td>
    <td>£${f1(p.price)}</td>
    <td>${p.xMin}'</td>
    <td>${f2(p.xgi)}</td>
    <td>${f2(p.xg)}</td>
    <td>${f2(p.xa)}</td>
    <td>${Math.round(p.defcon)}</td>
    <td><span style="display:inline-flex;gap:3px">${fixtureChips(p.teamId, 5)}</span></td>
    <td><button class="slot-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></td>
  </tr>`;
}

function filledSlot(p) {
  const jersey = p.jersey
    ? `<img class="slot-jersey" src="${p.jersey}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : "";
  return `<div class="slot filled">
    <div class="slot-top">
      <span></span>
      <button class="slot-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
    </div>
    ${jersey}
    <div class="slot-name">${esc(p.name)}${availabilityFlag(p)}</div>
    <div class="slot-meta">${esc(p.short)} · £${f1(p.price)}</div>
    <div class="slot-stats">
      <span title="Expected goal involvements">xGI ${f2(p.xgi)}</span>
      <span title="Expected minutes next GW">${p.xMin}'</span>
    </div>
    <div class="slot-fx">${fixtureChips(p.teamId, 5)}</div>
  </div>`;
}

function emptySlot(posKey) {
  return `<div class="slot empty" data-addpos="${posKey}">
    <div class="slot-plus">+</div>
    <div class="slot-meta">${posKey}</div>
  </div>`;
}

/* ---------------- Starting XI (lineup layer) ---------------- */
function lineupSection(complete) {
  if (!complete) {
    return `<div class="lineup-section">
      <div class="lineup-head"><span class="anton">Starting XI</span></div>
      <p class="hint">Complete your 15 to set a lineup.</p>
    </div>`;
  }

  const valid = isValidLineup();
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  startingPlayers().forEach((p) => byPos[p.pos].push(p));
  const bench = benchPlayers();

  return `<div class="lineup-section">
    <div class="lineup-head">
      <span class="anton">Starting XI</span>
      <span class="hint mono">${formationLabel()}</span>
    </div>
    ${
      valid
        ? ""
        : `<p class="totals-need">Formation isn't legal — click a bench player, then a starter, to swap them.</p>`
    }
    ${PL.lineupError ? `<p class="neg">${esc(PL.lineupError)}</p>` : ""}
    <div class="pos-rows">
      ${POSITION_ORDER.map((posKey) => `<div class="pos-row">
        <div class="pos-label"><span class="pos-chip pos-${posKey}">${posKey}</span>
          <span class="hint">${byPos[posKey].length}</span></div>
        <div class="slot-strip">${byPos[posKey].map((p) => lineupSlot(p, true)).join("")}</div>
      </div>`).join("")}
    </div>
    <div class="pos-row lineup-bench">
      <div class="pos-label"><span class="hint">Bench</span></div>
      <div class="slot-strip">${bench.map((p) => lineupSlot(p, false)).join("")}</div>
    </div>
    <p class="hint">Click a player, then click one from the other side to swap them. Captain and vice can only be a starter.</p>
  </div>`;
}

function lineupSlot(p, starting) {
  const isC = PL.draft.captain === p.id;
  const isV = PL.draft.vice === p.id;
  const selected = PL.lineupSelect === p.id;
  const jersey = p.jersey
    ? `<img class="slot-jersey" src="${p.jersey}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : "";
  return `<div class="slot filled ${starting ? "" : "bench"} ${selected ? "selected" : ""}" data-lineup="${p.id}">
    <div class="slot-top">
      ${isC ? '<span class="cap-badge c">C</span>' : isV ? '<span class="cap-badge v">V</span>' : "<span></span>"}
    </div>
    ${jersey}
    <div class="slot-name">${esc(p.name)}${availabilityFlag(p)}</div>
    <div class="slot-meta">${esc(p.short)} · £${f1(p.price)}</div>
    <div class="slot-stats">
      <span title="Expected goal involvements">xGI ${f2(p.xgi)}</span>
      <span title="Expected minutes next GW">${p.xMin}'</span>
    </div>
    <div class="slot-fx">${fixtureChips(p.teamId, 5)}</div>
    ${
      starting
        ? `<div class="slot-cap">
      <button class="mini ${isC ? "on" : ""}" data-cap="${p.id}">C</button>
      <button class="mini ${isV ? "on" : ""}" data-vice="${p.id}">V</button>
    </div>`
        : ""
    }
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

    <div class="proj-headline">
      <div class="proj-num">${t.projected.toFixed(1)}<span class="proj-unit">pts</span></div>
      <div class="proj-sub">
        projected over
        <select id="plWindow" class="proj-window" aria-label="Projection window">
          ${[3, 5, 8, 10].map((w) => `<option value="${w}" ${w === t.projWindow ? "selected" : ""}>next ${w} GWs</option>`).join("")}
        </select>
      </div>
    </div>
    <p class="proj-note">An estimate from xGI, expected minutes and fixtures — a sensible baseline for comparing options, not a forecast of any single week.</p>

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

/* ---------------- Branching (compare two squads) ---------------- */
function compareSection() {
  const others = PL.squads.filter((s) => s.id !== PL.activeId);
  const cmp = PL.compareId ? compareTotals() : null;

  return `<div class="compare-section">
    <div class="lineup-head">
      <span class="anton">Compare</span>
      ${
        others.length
          ? `<select id="plCompare" class="proj-window" aria-label="Compare against">
        <option value="">— pick a saved squad —</option>
        ${others.map((s) => `<option value="${s.id}" ${s.id === PL.compareId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
      </select>`
          : ""
      }
    </div>
    ${
      !others.length
        ? `<p class="hint">Save a second squad, or branch one from the tabs above (⑂), to compare it against what you're building.</p>`
        : !cmp
        ? `<p class="hint">Pick a saved squad to compare against your current draft, over the same window as the projection above.</p>`
        : compareBody(cmp)
    }
  </div>`;
}

function compareBody(cmp) {
  const deltaPos = cmp.delta >= 0;
  const movers = [
    ...cmp.onlyA.map((p) => ({ label: p.name, value: p.contribution, side: "a" })),
    ...cmp.onlyB.map((p) => ({ label: p.name, value: -p.contribution, side: "b" })),
  ].sort((x, y) => Math.abs(y.value) - Math.abs(x.value));

  return `
    <div class="compare-heads">
      <div class="compare-head">
        <div class="compare-name">${esc(cmp.aName)}</div>
        <div class="compare-total">${cmp.aTotal.toFixed(1)}<span class="proj-unit">pts</span></div>
        ${cmp.aValid ? "" : `<div class="hint">no legal XI set — using full squad</div>`}
      </div>
      <div class="compare-vs">
        <div class="compare-delta ${deltaPos ? "pos" : "neg"}">${deltaPos ? "+" : ""}${cmp.delta.toFixed(1)}</div>
        <div class="hint">over ${cmp.span} GWs</div>
      </div>
      <div class="compare-head">
        <div class="compare-name">${esc(cmp.bName)}</div>
        <div class="compare-total">${cmp.bTotal.toFixed(1)}<span class="proj-unit">pts</span></div>
        ${cmp.bValid ? "" : `<div class="hint">no legal XI set — using full squad</div>`}
      </div>
    </div>

    ${
      movers.length
        ? `<div class="compare-log">
             <button class="btn primary" id="plLogDecision">Log this as a decision →</button>
             <p class="hint">Sends it to the Journal, pre-filled with who's in and who's out — set your confidence and reasoning there.</p>
           </div>
           <h3 class="compare-sub">Who's driving the difference</h3>
           ${divergingBars(movers, {
             meta: (m) => (m.side === "a" ? `only in ${cmp.aName}` : `only in ${cmp.bName}`),
             empty: "Same 15 players in both.",
           })}`
        : `<p class="hint">Same players in both squads — the difference is entirely lineup and captaincy.</p>`
    }

    <h3 class="compare-sub">Per gameweek</h3>
    ${divergingBars(
      cmp.byGw.map((row) => ({ label: `GW${row.gw}`, value: row.a - row.b })),
      { meta: () => "", empty: "Nothing scheduled in this window." }
    )}
  `;
}

/* ---------------- Events ---------------- */
function wire(root, rerender) {
  const bind = (sel, ev, fn) => { const el = $(sel, root); if (el) el[ev] = fn; };

  bind("#plNew", "onclick", () => { newDraft(); rerender(); });
  bind("#plName", "oninput", (e) => { PL.draft.name = e.target.value; });
  bind("#plNote", "oninput", (e) => { PL.draft.note = e.target.value; });

  $$("[data-squadview]", root).forEach((b) => {
    b.onclick = () => { PL.squadView = b.dataset.squadview; rerender(); };
  });

  // Load / branch / delete saved squads
  $$("[data-load]", root).forEach((b) => {
    b.onclick = (e) => {
      if (e.target.closest("[data-del]") || e.target.closest("[data-branch]")) return;
      const sq = PL.squads.find((s) => s.id === b.dataset.load);
      if (sq) { loadIntoDraft(sq); rerender(); }
    };
  });
  $$("[data-branch]", root).forEach((x) => {
    x.onclick = (e) => {
      e.stopPropagation();
      const sq = PL.squads.find((s) => s.id === x.dataset.branch);
      if (sq) { branchSquad(sq); rerender(); }
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

  // Lineup: click a player, then one from the other side (bench/starting) to swap
  $$("[data-lineup]", root).forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("[data-cap],[data-vice]")) return;
      const id = +el.dataset.lineup;
      if (PL.lineupSelect == null) {
        PL.lineupSelect = id;
      } else if (PL.lineupSelect === id) {
        PL.lineupSelect = null;
      } else {
        const res = swapLineup(PL.lineupSelect, id);
        PL.lineupSelect = null;
        PL.lineupError = res.ok ? "" : res.reason;
      }
      rerender();
    };
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

  const win = $("#plWindow", root);
  if (win) win.onchange = () => { PL.projWindow = +win.value; rerender(); };

  const cmp = $("#plCompare", root);
  if (cmp) cmp.onchange = () => { setCompare(cmp.value); rerender(); };

  bind("#plLogDecision", "onclick", () => {
    const draft = transferLogDraft(compareTotals());
    if (!draft) return;
    J.draft = { ...blankJournalDraft(), ...draft };
    document.querySelector('[data-tab="journal"]')?.click();
  });

  bind("#plSave", "onclick", async () => {
    PL.saving = true; rerender();
    await saveDraft();
    rerender();
  });
}
