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

function wireTabs() {
  $$(".tab").forEach((t) => {
    t.onclick = () => {
      S.ui.tab = t.dataset.tab;
      $$(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      renderActive();
      playPanelEnter(PANELS[t.dataset.tab].el());
      trackTab(t.dataset.tab);
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
