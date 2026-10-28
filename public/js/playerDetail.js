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
  PD.openId = null;
  window.setTimeout(() => {
    if (PD.openId != null) return; // reopened before the close animation finished
    panel.hidden = true;
    backdrop.hidden = true;
  }, 300);
}

function statBlock(label, value, help = "", cls = "") {
  return `<div class="pd-stat" ${help ? `title="${esc(help)}"` : ""}>
    <div class="pd-stat-v mono${cls ? " " + cls : ""}">${value}</div>
    <div class="pd-stat-l">${esc(label)}</div>
  </div>`;
}

function statGroup(title, blocksHtml) {
  return `<h3 class="pd-h3 pd-h3-tight">${esc(title)}</h3><div class="pd-stats pd-stats-quiet">${blocksHtml}</div>`;
}

/* ---------------- Hero stat ----------------
   One number, not twelve: the single most decision-relevant figure for
   this player's position, shown big with a percentile rank underneath -
   same "Adj xGI/90" and "DEFCON/90" the rest of the site already treats
   as its premier attacking/defensive signals (Analytics' percentile
   section, the Hub's Best Performers panel), just not previously shown
   anywhere in this drawer at all - this is additive, not a promotion of
   one of the twelve tiles below. */
const HERO_STAT = {
  attack: { key: "fixtureAdjXgi90", label: "Adj xGI/90", help: "Fixture-adjusted expected goal involvements per 90" },
  defend: { key: "defcon90", label: "DEFCON/90", help: "Defensive contributions per 90" },
};

// Mirrors analytics.js's own adaptive minutes floor - kept as its own
// couple of lines here rather than imported, since importing across
// playerDetail.js/analytics.js for a four-line formula would be a new
// coupling neither file currently has.
function heroMinMinutes() {
  return Math.min(270, Math.max(45, Math.round(S.currentGw * 60)));
}

function heroPercentile(player, key) {
  const pool = S.players.filter((x) => x.pos === player.pos && x.minutes >= heroMinMinutes());
  const value = player[key];
  if (!pool.length || value == null || !Number.isFinite(value)) return 0;
  const below = pool.filter((x) => x[key] != null && x[key] <= value).length;
  return Math.round((below / pool.length) * 100);
}

function heroSection(p) {
  const defensive = p.pos === "GKP" || p.pos === "DEF";
  const stat = defensive ? HERO_STAT.defend : HERO_STAT.attack;
  const value = p[stat.key];
  const pct = heroPercentile(p, stat.key);
  return `<div class="pd-hero">
    <div class="an-big">${value == null ? "—" : f2(value)}</div>
    <div class="an-big-label" title="${esc(stat.help)}">${esc(stat.label)}</div>
    <div class="an-pctl-track pd-hero-track">
      <span class="an-pctl-fill" style="width:${pct}%"></span>
      <span class="an-pctl-tick" style="left:25%"></span>
      <span class="an-pctl-tick" style="left:50%"></span>
      <span class="an-pctl-tick" style="left:75%"></span>
    </div>
    <div class="pd-hero-pct">${pct}<span>th percentile for a ${esc(p.pos)}</span></div>
  </div>`;
}

/* ---------------- Unified timeline ----------------
   One horizontally-scrolling strip, oldest-recent on the left through
   furthest-future on the right, instead of two stacked vertical lists
   that used the same row shape but never read as connected. */
function timelineItem(gw, list, { pts, mins } = {}) {
  const f = list[0];
  const isPast = pts !== undefined;
  const oppHtml = f
    ? `${teamCrest(f.opp, 16)}<span class="pd-tl-code">${esc(S.teams[f.opp]?.short || "?")}</span><i>${f.home ? "H" : "A"}</i>${
        list.length > 1 ? ` <span class="pd-tl-extra">+${list.length - 1}</span>` : ""
      }`
    : `<span class="sub-t">Blank</span>`;

  let value;
  if (isPast) {
    const played = (mins ?? 0) > 0;
    value = played
      ? `<span class="pd-tl-pts ${n(pts) >= 6 ? "hit" : n(pts) <= 1 ? "low" : ""}">${n(pts)}</span>`
      : `<span class="pd-tl-pts blank">DNP</span>`;
  } else if (f) {
    const d = difficultyOf(f, S.ui.fdrMode);
    value = `<span class="pd-tl-fdr" style="background:var(--fdr-${d})" title="Difficulty ${d}/5"></span>`;
  } else {
    value = `<span class="pd-tl-fdr blank" title="Blank gameweek"></span>`;
  }

  return `<div class="pd-tl-item${f ? "" : " blank"}">
    <div class="pd-tl-gw">GW${gw}</div>
    <div class="pd-tl-opp">${oppHtml}</div>
    ${value}
  </div>`;
}

function timelineSection(p) {
  const pastItems = p.formSeries.length
    ? p.formSeries
        .map((pts, i) => ({ gw: S.form.gws[i], pts, mins: p.formMins[i] }))
        .filter((r) => r.gw != null)
        .map((r) => timelineItem(r.gw, S.fxByTeamGw[p.teamId]?.[r.gw] || [], { pts: r.pts, mins: r.mins }))
    : [];
  const futureItems = upcoming(p.teamId, 6).map((r) => timelineItem(r.gw, r.list));

  if (!pastItems.length && !futureItems.length) {
    return `<h3 class="pd-h3">Form &amp; fixtures</h3><p class="pd-cap">No matches played or scheduled right now.</p>`;
  }

  const divider = pastItems.length && futureItems.length ? `<div class="pd-tl-divider" title="Now"></div>` : "";
  return `<h3 class="pd-h3">Form &amp; fixtures</h3>
    <p class="pd-cap">Points scored, most recent gameweeks through upcoming difficulty.</p>
    <div class="pd-timeline">${pastItems.join("")}${divider}${futureItems.join("")}</div>`;
}

function render() {
  const panel = panelEl();
  if (!panel) return;
  const p = PD.openId != null ? S.playerById[PD.openId] : null;
  if (!p) { panel.innerHTML = ""; return; }

  const team = S.teams[p.teamId];

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

  const defensive = p.pos === "GKP" || p.pos === "DEF";
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

    ${heroSection(p)}

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

    ${timelineSection(p)}
  `;

  $("#pdClose", panel).onclick = closePlayerDetail;
}

// Wired once, at module load - the panel has no view of its own to run a
// per-render wire() pass, so its own dismiss interactions (click outside,
// Escape) are set up as soon as this module is first imported.
if (typeof document !== "undefined") {
  // The backdrop is pointer-events:none (visual dim only), so a click
  // anywhere outside the drawer itself bubbles here uninterrupted - close
  // it, unless the click is on another [data-playerid] trigger, in which
  // case that's a switch to a (possibly different) profile, not a dismiss.
  // Checked directly here rather than trusted to every caller's own click
  // handler stopping propagation - one stray missing stopPropagation()
  // elsewhere would otherwise close the drawer the instant it opens.
  document.addEventListener("click", (e) => {
    if (PD.openId == null) return;
    if (e.target.closest("#playerDetail") || e.target.closest("[data-playerid]")) return;
    closePlayerDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && PD.openId != null) closePlayerDetail();
  });
}
