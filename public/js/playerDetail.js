/* =========================================================
   Player profile drawer

   A single shared panel any tab can open by player id - My Team and
   Planner both call openPlayerDetail(id) rather than each view building
   its own popover. Lives entirely outside the normal render cycle
   (no host view "owns" it), so its own open/close listeners are wired
   once, at module load, rather than per-render like everything else.
   ========================================================= */
import { S, f1, f2, n, upcoming, difficultyOf } from "./store.js";
import { $, esc, teamCrest, availabilityFlag, setPieceFlag } from "./ui.js";

export const PD = {
  openId: null,
};

function panelEl() {
  return document.getElementById("playerDetail");
}
function backdropEl() {
  return document.getElementById("pdBackdrop");
}

export function openPlayerDetail(id) {
  PD.openId = id;
  render();
  const panel = panelEl();
  const backdrop = backdropEl();
  if (!panel || !backdrop) return;
  panel.hidden = false;
  backdrop.hidden = false;
  // hidden -> visible has to happen on a prior frame for the transform
  // transition to actually play, rather than snapping straight to .show.
  // Falls back to a plain callback where rAF isn't available (test DOMs).
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();
  raf(() => {
    panel.classList.add("show");
    backdrop.classList.add("show");
    panel.setAttribute("aria-hidden", "false");
  });
}

export function closePlayerDetail() {
  const panel = panelEl();
  const backdrop = backdropEl();
  if (!panel || !backdrop) return;
  panel.classList.remove("show");
  backdrop.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (PD.openId == null) return; // reopened before the close animation finished
    panel.hidden = true;
    backdrop.hidden = true;
  }, 300);
  PD.openId = null;
}

function statBlock(label, value, help = "", cls = "") {
  return `<div class="pd-stat" ${help ? `title="${esc(help)}"` : ""}>
    <div class="pd-stat-v mono${cls ? " " + cls : ""}">${value}</div>
    <div class="pd-stat-l">${esc(label)}</div>
  </div>`;
}

function statGroup(title, blocksHtml) {
  return `<h3 class="pd-h3 pd-h3-tight">${esc(title)}</h3><div class="pd-stats">${blocksHtml}</div>`;
}

// One row of a vertical fixture/result list - shared shape for both the
// "Fixtures ahead" (difficulty dot) and "Recent results" (points) lists,
// so a blank gameweek or a missing opponent renders identically either way.
function fixtureRow(gw, list, { pts, mins } = {}) {
  const f = list[0];
  const oppHtml = f
    ? `${teamCrest(f.opp, 16)} ${esc(S.teams[f.opp]?.short || "?")} <i>${f.home ? "H" : "A"}</i>${
        list.length > 1 ? ` <span class="pd-row-extra">+${list.length - 1}</span>` : ""
      }`
    : `<span class="sub-t">Blank gameweek</span>`;

  let right = "";
  if (pts !== undefined) {
    const played = (mins ?? 0) > 0;
    right = played
      ? `<span class="pd-row-pts ${n(pts) >= 6 ? "hit" : n(pts) <= 1 ? "low" : ""}">${n(pts)}</span>`
      : `<span class="pd-row-pts blank">DNP</span>`;
  } else if (f) {
    const d = difficultyOf(f, S.ui.fdrMode);
    right = `<span class="pd-row-fdr" style="background:var(--fdr-${d})" title="Difficulty ${d}/5"></span>`;
  }

  return `<div class="pd-row${f ? "" : " blank"}">
    <span class="pd-row-gw">GW${gw}</span>
    <span class="pd-row-opp">${oppHtml}</span>
    ${right}
  </div>`;
}

function render() {
  const panel = panelEl();
  if (!panel) return;
  const p = PD.openId != null ? S.playerById[PD.openId] : null;
  if (!p) { panel.innerHTML = ""; return; }

  const team = S.teams[p.teamId];
  const defensive = p.pos === "GKP" || p.pos === "DEF";

  // Layered under the img rather than swapped in by hand: a headshot 404
  // falls back to the jersey graphic, and if THAT fails too (mock/dev data,
  // or a player with no kit image either), the img just hides itself and
  // this placeholder - always present underneath - shows through instead
  // of a broken-image icon.
  const headImg = p.photo
    ? `<img class="pd-photo" src="${p.photo}" alt="" loading="lazy" onerror="this.onerror=function(){this.style.display='none'};this.src='${p.jersey}';this.classList.add('pd-photo-fallback')">`
    : p.jersey
      ? `<img class="pd-photo pd-photo-fallback" src="${p.jersey}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : "";

  const resultsRows = p.formSeries.length
    ? p.formSeries
        .map((pts, i) => ({ gw: S.form.gws[i], pts, mins: p.formMins[i] }))
        .filter((r) => r.gw != null)
        .reverse()
        .map((r) => fixtureRow(r.gw, S.fxByTeamGw[p.teamId]?.[r.gw] || [], { pts: r.pts, mins: r.mins }))
        .join("")
    : `<p class="pd-cap">No matches played yet this season.</p>`;

  const fixturesRows = upcoming(p.teamId, 6)
    .map((r) => fixtureRow(r.gw, r.list))
    .join("");

  const netCls = p.netTransfers > 0 ? "pos" : p.netTransfers < 0 ? "neg" : "";
  const moveCls = p.priceMove > 0 ? "pos" : p.priceMove < 0 ? "neg" : "";

  panel.innerHTML = `
    <button class="pd-close" id="pdClose" aria-label="Close player profile">×</button>
    <div class="pd-head">
      <div class="pd-photo-wrap">
        <div class="pd-photo-placeholder">${esc(p.pos)}</div>
        ${headImg}
        <span class="pd-photo-crest">${teamCrest(p.teamId, 18)}</span>
      </div>
      <div class="pd-head-text">
        <div class="pd-name">${esc(p.name)}${availabilityFlag(p)}${setPieceFlag(p)}</div>
        <div class="pd-sub">${esc(team?.name || p.teamName)} · <span class="pos-chip pos-${p.pos}">${p.pos}</span> · £${f1(p.price)}</div>
      </div>
    </div>
    ${
      p.status !== "a"
        ? `<p class="pd-news">${esc(p.news || (p.status === "d" ? "Doubtful for the next match." : "Unavailable."))}</p>`
        : ""
    }

    ${statGroup(
      "Underlying",
      statBlock("xG", f2(p.xg), "Expected goals, season") +
        statBlock("xA", f2(p.xa), "Expected assists, season") +
        statBlock("xGI", f2(p.xgi), "Expected goal involvements, season") +
        (defensive
          ? statBlock("xGC", f2(p.xgc), "Expected goals conceded while on the pitch")
          : statBlock("DEFCON", Math.round(p.defcon), "Defensive contributions, season"))
    )}

    ${statGroup(
      "Returns",
      statBlock("Total pts", p.total_points) +
        statBlock("PPG", f1(p.ppg), "Points per game played") +
        statBlock("Form", f1(p.form), "Points per match, last 30 days") +
        statBlock("Pts/£m", f1(p.ppm), "Total points per million spent")
    )}

    ${statGroup(
      "Ownership & risk",
      statBlock("Owned", f1(p.selected) + "%", "Selected by") +
        statBlock(
          "Net transfers",
          (p.netTransfers > 0 ? "+" : "") + n(p.netTransfers).toLocaleString(),
          "Transfers in minus out, this gameweek",
          netCls
        ) +
        statBlock(
          "Price move",
          (p.priceMove > 0 ? "+" : "") + f1(p.priceMove),
          "Price change since the season started",
          moveCls
        ) +
        statBlock("xMin", p.xMin + "'", "Expected minutes next gameweek")
    )}

    <h3 class="pd-h3">Recent results</h3>
    <p class="pd-cap">Points in each of the last six gameweeks, most recent first.</p>
    <div class="pd-list">${resultsRows}</div>

    <h3 class="pd-h3">Fixtures ahead</h3>
    <div class="pd-list">${fixturesRows}</div>
  `;

  $("#pdClose", panel).onclick = closePlayerDetail;
}

// Wired once, at module load - the panel has no view of its own to run a
// per-render wire() pass, so its own dismiss interactions (backdrop click,
// Escape) are set up as soon as this module is first imported.
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (e.target.id === "pdBackdrop") closePlayerDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && PD.openId != null) closePlayerDetail();
  });
}
