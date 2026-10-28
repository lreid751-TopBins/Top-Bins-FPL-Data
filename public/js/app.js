import { S, load, applyTheme } from "./store.js";
import { $, $$, untilDeadline } from "./ui.js";
import { renderHub } from "./views/hub.js";
import { renderSquad, loadManager } from "./views/squad.js";
import { renderScout } from "./views/scout.js";
import { renderFixtures } from "./views/fixtures.js";
import { renderTeams } from "./views/teams.js";
import { renderJournal } from "./views/journal.js";
import { renderPlanner } from "./views/planner.js";
import { renderAnalytics } from "./views/analytics.js";
// No panel of its own - importing it wires up its close interactions
// (backdrop click, Escape) once, regardless of which tab loads first.
import "./playerDetail.js";

const PANELS = {
  hub: { el: () => $("#panel-hub"), render: renderHub, label: "Hub" },
  squad: { el: () => $("#panel-squad"), render: renderSquad, label: "My Team" },
  scout: { el: () => $("#panel-scout"), render: renderScout, label: "Player Finder" },
  fixtures: { el: () => $("#panel-fixtures"), render: renderFixtures, label: "Fixture Ticker" },
  teams: { el: () => $("#panel-teams"), render: renderTeams, label: "Teams" },
  planner: { el: () => $("#panel-planner"), render: renderPlanner, label: "Planner" },
  analytics: { el: () => $("#panel-analytics"), render: renderAnalytics, label: "Analytics" },
  journal: { el: () => $("#panel-journal"), render: renderJournal, label: "Journal" },
};

// GoatCounter's script is loaded with no_onload (see index.html) since this
// is a single-page app - tabs are JS state, not real URL changes, so its
// own automatic pageview would only ever fire once and never say which tab
// someone's actually on. This fires a virtual pageview per tab instead,
// which is the whole point of tracking a tabbed app at all. Guarded so a
// blocked/not-yet-loaded script (ad blockers, slow network) never breaks
// tab switching itself - analytics failing silently beats analytics
// breaking the app.
function trackTab(tab) {
  try {
    window.goatcounter?.count({ path: tab, title: PANELS[tab]?.label || tab, event: false });
  } catch {
    // best-effort only
  }
}

function setStatus(state, text) {
  $("#statusTxt").textContent = text;
  $("#statusDot").className = "dot" + (state ? ` ${state}` : "");
}

function showOverlay(title, sub) {
  const o = $("#overlay");
  o.hidden = false;
  $("#loadTxt").textContent = title;
  $("#loadSub").textContent = sub;
}
const hideOverlay = () => ($("#overlay").hidden = true);

function renderMasthead() {
  const badge = $("#gwBadge");
  badge.hidden = false;
  $("#gwVal").textContent = "GW" + (S.nextGw || S.currentGw || "—");
  $("#gwDeadline").textContent = untilDeadline(S.nextDeadline);
}

function renderActive() {
  const tab = S.ui.tab;
  Object.entries(PANELS).forEach(([key, p]) => (p.el().hidden = key !== tab));
  PANELS[tab].render(PANELS[tab].el());
}

// A short fade-in when a tab is actually switched to - kept out of
// renderActive() itself, since that also runs on the 90s live-score
// refresh, and re-fading a panel the user is already reading would read
// as a flicker rather than a transition.
function playPanelEnter(el) {
  el.classList.remove("panel-enter");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add("panel-enter");
}

const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
// How long the outgoing panel's fade (.panel-exit, see styles.css) gets to
// play before it's actually hidden and the next one renders. 0 under
// reduced-motion so switching stays instant rather than an unexplained
// pause with nothing visibly animating.
const PANEL_EXIT_MS = REDUCED_MOTION ? 0 : 110;
let exitTimer = null;

function wireTabs() {
  $$(".tab").forEach((t) => {
    t.onclick = () => {
      const nextTab = t.dataset.tab;
      S.ui.tab = nextTab;
      $$(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      trackTab(nextTab);
      // The nav itself scrolls horizontally once it's got more tabs than
      // fit (mobile, mainly) - clicking Hub right after manually scrolling
      // to reach Journal left the now-active tab, and its gold pill,
      // scrolled off-screen with nothing on screen showing what's selected.
      // behavior must stay "auto" (instant) - a smooth scrollIntoView here
      // gets cancelled by the window.scrollTo() right below it, so nothing
      // moves at all.
      t.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "auto" });
      // Each panel's own scroll-fade / chart-box content was fine, but the
      // *page* kept whatever scroll depth the previous tab was left at - so
      // switching to Analytics from three screens down the Hub dropped you
      // mid-scroll into Analytics with no heading in view. A tab switch
      // should read as a new section, not a scroll jump cosmetically
      // disguised as a different page.
      window.scrollTo(0, 0);

      clearTimeout(exitTimer);
      exitTimer = null;
      // Found by what's actually visible in the DOM right now, not by the
      // previous S.ui.tab value - a second click fired while the first
      // panel is still mid-fade-out needs to find that same still-visible
      // panel again, not the (not-yet-shown) one the first click targeted.
      const prevEl = Object.values(PANELS).map((p) => p.el()).find((el) => !el.hidden);
      const nextEl = PANELS[nextTab].el();
      if (!prevEl || prevEl === nextEl) {
        prevEl?.classList.remove("panel-exit");
        return;
      }
      prevEl.classList.add("panel-exit");
      exitTimer = setTimeout(() => {
        prevEl.hidden = true;
        prevEl.classList.remove("panel-exit");
        exitTimer = null;
        renderActive();
        playPanelEnter(nextEl);
      }, PANEL_EXIT_MS);
    };
  });
}

async function boot() {
  showOverlay("Warming up the data room", "Connecting to the FPL API…");
  try {
    await load({ onProgress: (msg) => ($("#loadSub").textContent = msg) });
  } catch (err) {
    hideOverlay();
    setStatus("err", "Couldn't load FPL data");
    $("#panel-hub").hidden = false;
    $("#panel-hub").innerHTML = `<div class="empty">
      <div class="anton">The FPL API didn't answer</div>
      <p style="max-width:440px;margin:0 auto">This is usually the API being briefly unavailable around a deadline,
      or the server losing its connection. Reload to try again.</p>
      <button class="btn primary" onclick="location.reload()">Reload</button>
    </div>`;
    return;
  }

  renderMasthead();
  hideOverlay();
  setStatus(
    "live",
    `${S.players.length} players · ${S.teamList.length} teams · GW${S.currentGw} scored`
  );

  wireTabs();
  renderActive();
  trackTab(S.ui.tab);

  // Auto-load a previously saved manager ID - the Hub (now the default tab)
  // needs S.entry/S.history for its rank widget just as much as My Team does.
  if (S.ui.managerId) {
    loadManager(S.ui.managerId, () => renderActive());
  }

  // Keep live scores fresh while a gameweek is in play, but never redraw
  // the page while someone is mid-keystroke or has the tab in the background.
  // Hub gets the same refresh as My Team - its "Your season" card reads the
  // same S.entry/S.history this call updates, so it can otherwise sit stale
  // for as long as Marina leaves the tab open during a live gameweek.
  setInterval(() => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (document.hidden || typing) return;
    if ((S.ui.tab === "squad" || S.ui.tab === "hub") && S.ui.managerId && S.entry) {
      loadManager(S.ui.managerId, () => renderActive());
    }
  }, 90_000);
}

// Apply a saved club theme immediately, before the FPL fetch even starts -
// a returning visitor shouldn't see a flash of the default gold first.
applyTheme();
boot();
