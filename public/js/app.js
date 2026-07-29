import { S, load } from "./store.js";
import { $, $$, untilDeadline } from "./ui.js";
import { renderSquad, loadManager } from "./views/squad.js";
import { renderScout } from "./views/scout.js";
import { renderFixtures } from "./views/fixtures.js";
import { renderTeams } from "./views/teams.js";
import { renderJournal } from "./views/journal.js";

const PANELS = {
  squad: { el: () => $("#panel-squad"), render: renderSquad },
  scout: { el: () => $("#panel-scout"), render: renderScout },
  fixtures: { el: () => $("#panel-fixtures"), render: renderFixtures },
  teams: { el: () => $("#panel-teams"), render: renderTeams },
  journal: { el: () => $("#panel-journal"), render: renderJournal },
};

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

function wireTabs() {
  $$(".tab").forEach((t) => {
    t.onclick = () => {
      S.ui.tab = t.dataset.tab;
      $$(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      renderActive();
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
    $("#panel-squad").hidden = false;
    $("#panel-squad").innerHTML = `<div class="empty">
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

  // Auto-load a previously saved manager ID.
  if (S.ui.managerId && S.ui.tab === "squad") {
    loadManager(S.ui.managerId, () => renderActive());
  }

  // Keep live scores fresh while a gameweek is in play, but never redraw
  // the page while someone is mid-keystroke or has the tab in the background.
  setInterval(() => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (document.hidden || typing) return;
    if (S.ui.tab === "squad" && S.ui.managerId && S.entry) {
      loadManager(S.ui.managerId, () => renderActive());
    }
  }, 90_000);
}

boot();
