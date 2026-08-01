import { S, saveManagerId, runDifficulty, n, f1, f2, signed } from "../store.js";
import { api } from "../api.js";
import {
  $, $$, esc, statCard, emptyState, fixtureStrip,
  availabilityFlag, playerSearchResults, dropdownHTML, sparkline,
} from "../ui.js";

let liveById = {};
let loadError = "";
let loading = false;

/* =========================================================
   Loading
   ========================================================= */
export async function loadManager(id, rerender) {
  loading = true;
  loadError = "";
  rerender();

  try {
    // The profile is the thing that proves the ID is real. If this fails,
    // the ID is wrong; everything else is best-effort on top of it.
    const [entry, history] = await Promise.all([api.entry(id), api.history(id)]);
    S.entry = entry;
    S.history = history;

    // Find the most recent gameweek this manager has picks for. The endpoint
    // 404s for gameweeks that haven't been played, and between seasons it can
    // 404 or error for all of them — so we step back a bounded number of
    // times and treat ANY failure as "not this gameweek", never as fatal.
    let gw = S.currentGw || 38;
    let picks = null;
    let tries = 0;
    while (gw >= 1 && !picks && tries < 40) {
      tries++;
      try {
        picks = await api.picks(id, gw);
        if (picks) break;
      } catch {
        // 404, network hiccup, between-seasons weirdness — all the same here.
      }
      gw -= 1;
    }
    S.picks = picks;
    S.picksGw = picks ? gw : 0;

    if (picks && gw) {
      const live = await api.live(gw).catch(() => null);
      liveById = {};
      (live?.elements || []).forEach((el) => (liveById[el.id] = el.stats || {}));
    }
    saveManagerId(id);
  } catch (err) {
    // Only a failed profile lookup lands here now.
    loadError =
      err.status === 404
        ? "No manager with that ID. Check the number in your team's URL."
        : "Couldn't reach the FPL API just now. Try again in a moment.";
    S.entry = null;
    S.picks = null;
  } finally {
    loading = false;
    rerender();
  }
}

/* =========================================================
   Render
   ========================================================= */
export function renderSquad(root) {
  const rerender = () => renderSquad(root);

  if (loading) {
    root.innerHTML = `<div class="empty"><div class="anton">Fetching your team</div>Reading picks, live scores and fixtures.</div>`;
    return;
  }

  if (!S.entry) {
    root.innerHTML = `
      <div class="eyebrow">Your season</div>
      <div class="section-head"><h2>My Team</h2></div>
      ${emptyState(
        "Connect your FPL team",
        `<p style="max-width:460px;margin:0 auto 4px">Open your team on the FPL site. The number in the address bar
        after <code class="mono">/entry/</code> is your manager ID.</p>
        ${loadError ? `<p class="neg" style="margin-top:12px">${esc(loadError)}</p>` : ""}`,
        `<div style="display:flex;gap:8px;justify-content:center;margin-top:16px;flex-wrap:wrap">
          <input id="mgrId" inputmode="numeric" placeholder="e.g. 1234567" value="${esc(S.ui.managerId)}" style="width:170px" aria-label="Manager ID">
          <button class="btn primary" id="mgrGo">Load my team</button>
        </div>`
      )}
    `;
    const go = () => {
      const v = $("#mgrId", root).value.replace(/\D/g, "");
      if (v) loadManager(v, rerender);
    };
    $("#mgrGo", root).onclick = go;
    $("#mgrId", root).onkeydown = (e) => {
      // A bare `e.key === "Enter" && go()` returns false for every other key,
      // and returning false from an onX handler calls preventDefault — which
      // silently blocked all typing. Keep the body a statement, return nothing.
      if (e.key === "Enter") go();
    };
    return;
  }

  // Profile loaded, but no squad yet — between seasons, or before the first
  // deadline. Show who they are and say so, rather than dead-ending.
  if (!S.picks) {
    root.innerHTML = `
      <div class="eyebrow">Your season</div>
      <div class="section-head">
        <h2>${esc(S.entry.name || "My Team")}</h2>
        <div class="controls">
          <span class="hint">${esc(S.entry.player_first_name || "")} ${esc(S.entry.player_last_name || "")} · ID ${S.entry.id}</span>
          <button class="btn ghost" id="mgrSwitch">Change team</button>
        </div>
      </div>
      ${emptyState(
        "Squad not available yet",
        `<p style="max-width:480px;margin:0 auto">Your team loaded, but there are no picks to show for a played
        gameweek yet. This is normal between seasons or before the first deadline — your full squad, live points
        and transfer tools will appear here automatically once a gameweek is in play.</p>`
      )}
    `;
    const sw = $("#mgrSwitch", root);
    if (sw)
      sw.onclick = () => {
        S.entry = null;
        S.picks = null;
        rerender();
      };
    return;
  }

  const eh = S.picks.entry_history || {};
  const picks = S.picks.picks || [];
  const starters = picks.filter((p) => p.position <= 11);
  const bench = picks.filter((p) => p.position > 11);

  const livePts = (pick) => {
    const stats = liveById[pick.element];
    const base = stats ? n(stats.total_points) : 0;
    return base * (pick.multiplier || 0);
  };
  const gwPoints =
    starters.reduce((a, p) => a + livePts(p), 0) - n(eh.event_transfers_cost);
  const benchPoints = bench.reduce(
    (a, p) => a + n(liveById[p.element]?.total_points || 0),
    0
  );

  const chip = S.picks.active_chip;
  const rankMove =
    n(S.entry.summary_overall_rank) && S.history?.current?.length > 1
      ? n(S.history.current.at(-2).overall_rank) - n(S.entry.summary_overall_rank)
      : 0;

  root.innerHTML = `
    <div class="eyebrow">Your season</div>
    <div class="section-head">
      <h2>${esc(S.entry.name || "My Team")}</h2>
      <div class="controls">
        <span class="hint">${esc(S.entry.player_first_name || "")} ${esc(S.entry.player_last_name || "")} · ID ${S.entry.id}</span>
        <button class="btn ghost" id="mgrSwitch">Change team</button>
      </div>
    </div>

    <div class="cards">
      ${statCard(
        `GW${S.picksGw} points`,
        `<span style="color:var(--gold)">${gwPoints}</span>`,
        `${benchPoints} on the bench${n(eh.event_transfers_cost) ? ` · −${eh.event_transfers_cost} hit` : ""}`
      )}
      ${statCard("Overall rank", fmtRank(S.entry.summary_overall_rank),
        rankMove ? `${rankMove > 0 ? "▲" : "▼"} ${Math.abs(rankMove).toLocaleString()} last GW` : "")}
      ${statCard("Total points", n(S.entry.summary_overall_points).toLocaleString(), `GW rank ${fmtRank(eh.rank)}`)}
      ${statCard("Squad value", `£${f1(n(eh.value) / 10)}`, `£${f1(n(eh.bank) / 10)} in the bank`)}
      ${statCard("Transfers", eh.event_transfers ?? 0, chip ? `${chipName(chip)} active` : "no chip active")}
    </div>

    <div class="squad-pitch">
      <div class="pitch-lines" aria-hidden="true">
        <span class="pl-touch"></span>
        <span class="pl-goal"></span>
        <span class="pl-six"></span>
        <span class="pl-box"></span>
        <span class="pl-half"></span>
        <span class="pl-circle"></span>
      </div>
      ${["GKP", "DEF", "MID", "FWD"]
        .map((pos) => {
          const line = starters.filter((p) => S.playerById[p.element]?.pos === pos);
          if (!line.length) return "";
          return `<div class="row-line">${line.map((p) => playerCard(p, false)).join("")}</div>`;
        })
        .join("")}
      <div class="bench-line">
        <div class="bench-label">Bench</div>
        <div class="row-line">${bench.map((p) => playerCard(p, true)).join("")}</div>
      </div>
    </div>

    ${scratchpad(picks)}

    <p class="hint">
      Live points update while matches are on and include provisional bonus once a game finishes.
      Fixture bars run left to right over the next five gameweeks.
    </p>
  `;

  wire(root, rerender, picks);
}

function playerCard(pick, benched) {
  const p = S.playerById[pick.element];
  if (!p) return "";
  const stats = liveById[pick.element] || {};
  const pts = n(stats.total_points) * (benched ? 1 : pick.multiplier || 1);
  const playing = n(stats.minutes) > 0;
  const tag = pick.is_captain
    ? `<span class="tag">${pick.multiplier === 3 ? "TC" : "C"}</span>`
    : pick.is_vice_captain
    ? `<span class="tag v">V</span>`
    : "";

  const jersey = p.jersey
    ? `<img class="jersey" src="${p.jersey}" alt="" loading="lazy"
         onerror="this.style.display='none'">`
    : "";

  return `<div class="plr ${benched ? "benched" : ""} ${playing ? "playing" : ""}">
    ${tag}
    ${jersey}
    <div class="pts">${pts}</div>
    <div class="nm">${esc(p.name)}${availabilityFlag(p)}</div>
    <div class="nx">${gwOpponent(p.teamId, S.picksGw)}</div>
    <div class="fx">${fixtureStrip(p.teamId, 5)}</div>
  </div>`;
}

/** Who a team played (or is playing) in one specific gameweek, e.g. "MUN (H)" -
    the actual fixture behind this gameweek's live or final points, not the
    upcoming one. Joins multiple fixtures for a double gameweek. */
function gwOpponent(teamId, gw) {
  const list = S.fxByTeamGw[teamId]?.[gw] || [];
  if (!list.length) return "—";
  return list.map((f) => `${S.teams[f.opp]?.short || "?"} (${f.home ? "H" : "A"})`).join(", ");
}

/* =========================================================
   Transfer scratchpad
   ========================================================= */
function scratchpad(picks) {
  const out = S.ui.swapOut ? S.playerById[S.ui.swapOut] : null;
  const inc = S.ui.swapIn ? S.playerById[S.ui.swapIn] : null;

  const squadOptions = picks
    .map((pk) => S.playerById[pk.element])
    .filter(Boolean)
    .sort((a, b) => a.pos.localeCompare(b.pos) || b.total_points - a.total_points);

  return `<div class="chart-box">
    <h3>Transfer scratchpad</h3>
    <p class="cap">Put a name in each slot to see what the swap actually buys you before you spend the transfer.</p>

    <div class="swap">
      <div class="swap-slot out">
        <div class="lab">Out</div>
        <select id="swapOut" aria-label="Player to transfer out">
          <option value="">Pick from your squad…</option>
          ${squadOptions
            .map(
              (p) =>
                `<option value="${p.id}" ${String(p.id) === String(S.ui.swapOut) ? "selected" : ""}>${esc(p.name)} · ${p.pos} · £${f1(p.price)}</option>`
            )
            .join("")}
        </select>
        ${out ? slotDetail(out) : ""}
      </div>

      <div class="swap-arrow">→</div>

      <div class="swap-slot in">
        <div class="lab">In</div>
        <div class="cand-search">
          <input id="swapSearch" placeholder="${out ? `Search a ${out.pos}…` : "Search any player…"}" autocomplete="off" aria-label="Player to transfer in">
          <div id="swapDrop"></div>
        </div>
        ${inc ? slotDetail(inc) : ""}
      </div>
    </div>

    ${out && inc ? deltas(out, inc) : `<p class="hint">Pick both sides to compare.</p>`}
  </div>`;
}

function slotDetail(p) {
  return `<div style="margin-top:10px">
    <div style="font-weight:600;font-size:14px">${esc(p.name)} <span class="sub-t">${p.short} · ${p.pos}</span></div>
    <div class="mono" style="font-size:11px;color:var(--muted);margin-top:4px">
      £${f1(p.price)} · ${p.total_points} pts · ${Math.round(p.minutes)} mins
    </div>
    <div style="margin-top:6px">${sparkline(p.formSeries, p.formMins)}</div>
    <div class="fx" style="display:flex;gap:2px;margin-top:6px">${fixtureStrip(p.teamId, 5)}</div>
  </div>`;
}

function deltas(out, inc) {
  const dPrice = inc.price - out.price;
  const dForm = (inc.form6 ?? 0) - (out.form6 ?? 0);
  const dXgi = inc.xgi90 - out.xgi90;
  const fOut = runDifficulty(out.teamId, 5, S.ui.fdrMode);
  const fIn = runDifficulty(inc.teamId, 5, S.ui.fdrMode);
  const dFix = fOut - fIn; // positive means the incoming run is kinder

  const cell = (lab, val, good) =>
    `<div class="delta"><div class="l">${esc(lab)}</div>
      <div class="v ${good === null ? "" : good ? "pos" : "neg"}">${val}</div></div>`;

  return `<div class="delta-grid">
    ${cell("Cost", `${dPrice > 0 ? "−" : "+"}£${f1(Math.abs(dPrice))}`, dPrice <= 0)}
    ${cell("Last 6 GW pts", signed(dForm), dForm >= 0)}
    ${cell("xGI per 90", signed(+f2(dXgi)), dXgi >= 0)}
    ${cell("Fixture swing", signed(+f2(dFix)), dFix >= 0)}
    ${cell("Ownership", `${f1(inc.selected)}%`, null)}
    ${cell("Minutes risk", inc.starts >= out.starts ? "Similar or better" : "More", inc.starts >= out.starts)}
  </div>
  <p class="hint" style="margin-top:10px">
    Fixture swing is the difference in average difficulty over the next five gameweeks. Positive means the
    player coming in has the kinder run.
  </p>`;
}

/* =========================================================
   Events
   ========================================================= */
function wire(root, rerender, picks) {
  const sw = $("#mgrSwitch", root);
  if (sw)
    sw.onclick = () => {
      S.entry = null;
      S.picks = null;
      S.ui.swapOut = S.ui.swapIn = null;
      rerender();
    };

  const out = $("#swapOut", root);
  if (out)
    out.onchange = () => {
      S.ui.swapOut = out.value ? +out.value : null;
      S.ui.swapIn = null;
      rerender();
    };

  const search = $("#swapSearch", root);
  const drop = $("#swapDrop", root);
  if (search)
    search.oninput = () => {
      const outP = S.ui.swapOut ? S.playerById[S.ui.swapOut] : null;
      const exclude = new Set(picks.map((p) => p.element));
      const hits = playerSearchResults(search.value, {
        exclude,
        pos: outP ? outP.pos : null,
      });
      drop.innerHTML = search.value.trim() ? dropdownHTML(hits) : "";
      $$("[data-add]", drop).forEach((b) => {
        b.onclick = () => {
          S.ui.swapIn = +b.dataset.add;
          rerender();
        };
      });
    };
}

/* ---------------- Formatting ---------------- */
export function fmtRank(r) {
  const v = n(r);
  if (!v) return "—";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1000) return Math.round(v / 1000) + "k";
  return String(v);
}

function chipName(code) {
  return (
    {
      "3xc": "Triple Captain",
      bboost: "Bench Boost",
      freehit: "Free Hit",
      wildcard: "Wildcard",
      manager: "Assistant Manager",
    }[code] || code
  );
}
