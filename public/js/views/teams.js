import { S, runDifficulty, n, f1, f2, signed } from "../store.js";
import { $, $$, esc, th, fixtureStrip, statCard } from "../ui.js";

const COLS = [
  { k: "name", l: "Team" },
  { k: "gp", l: "GP" },
  { k: "xg", l: "xG", help: "Sum of every player's expected goals" },
  { k: "gf", l: "G" },
  { k: "gmxg", l: "G−xG", help: "Finishing above or below the chances created" },
  { k: "xa", l: "xA" },
  { k: "xgc", l: "xGC", help: "Estimated team expected goals conceded, scaled from minutes played" },
  { k: "ga", l: "GC" },
  { k: "gcmxgc", l: "GC−xGC", help: "Negative means the goalkeeper and luck are bailing them out" },
  { k: "cs", l: "CS" },
  { k: "defcon", l: "DEFCON" },
  { k: "fdr5", l: "Next 5" },
];

function aggregate() {
  const acc = {};
  S.teamList.forEach((t) => {
    acc[t.id] = {
      id: t.id, name: t.name, short: t.short,
      gp: 0, gf: 0, ga: 0, cs: 0,
      xg: 0, xa: 0, defcon: 0, xgcRaw: 0, mins: 0,
    };
  });

  // Results come from finished fixtures.
  for (const f of S.fixtures) {
    if (!f.finished) continue;
    const h = acc[f.team_h];
    const a = acc[f.team_a];
    if (!h || !a) continue;
    h.gp++; a.gp++;
    h.gf += n(f.team_h_score); h.ga += n(f.team_a_score);
    a.gf += n(f.team_a_score); a.ga += n(f.team_h_score);
    if (n(f.team_a_score) === 0) h.cs++;
    if (n(f.team_h_score) === 0) a.cs++;
  }

  // Expected figures come from summing the squad.
  for (const p of S.players) {
    const t = acc[p.teamId];
    if (!t) continue;
    t.xg += p.xg;
    t.xa += p.xa;
    t.defcon += p.defcon;
    t.xgcRaw += p.xgc;
    t.mins += p.minutes;
  }

  return Object.values(acc).map((t) => {
    // Player xGC is measured while that player is on the pitch, so summing it
    // counts each match roughly eleven times. Dividing by team-minutes/90
    // brings it back to a per-match figure.
    const teamMatches90 = t.mins / 90;
    const xgcPerMatch = teamMatches90 > 0 ? t.xgcRaw / teamMatches90 : 0;
    const xgc = xgcPerMatch * t.gp;
    return {
      ...t,
      xgc,
      gmxg: t.gf - t.xg,
      gcmxgc: t.ga - xgc,
      fdr5: runDifficulty(t.id, 5, S.ui.fdrMode),
    };
  });
}

export function renderTeams(root) {
  const data = aggregate();
  if (!S.ui.teamSort) S.ui.teamSort = { k: "xg", dir: -1 };
  const { k, dir } = S.ui.teamSort;

  data.sort((a, b) =>
    k === "name" ? a.name.localeCompare(b.name) * -dir : (n(a[k]) - n(b[k])) * dir
  );

  const top = (key, asc = false) =>
    [...data].sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]))[0] || {};
  const bestAtk = top("xg");
  const bestDef = top("xgc", true);
  const luckiest = top("gmxg");
  const unlucky = top("gmxg", true);

  root.innerHTML = `
    <div class="eyebrow">Team shape</div>
    <div class="section-head">
      <h2>Team Data Room</h2>
      <div class="hint">Season to date, all competitions excluded — Premier League only.</div>
    </div>

    <div class="cards">
      ${statCard("Most chances created", `<span style="font-size:20px">${esc(bestAtk.name || "—")}</span>`, `${f2(bestAtk.xg || 0)} xG`, true)}
      ${statCard("Meanest defence", `<span style="font-size:20px">${esc(bestDef.name || "—")}</span>`, `${f2(bestDef.xgc || 0)} xGC`)}
      ${statCard("Finishing hot", `<span style="font-size:20px">${esc(luckiest.name || "—")}</span>`, `${signed(+f2(luckiest.gmxg || 0))} G−xG`)}
      ${statCard("Due a correction", `<span style="font-size:20px">${esc(unlucky.name || "—")}</span>`, `${signed(+f2(unlucky.gmxg || 0))} G−xG`)}
    </div>

    <div class="twrap">
      <table>
        <thead><tr>${COLS.map((c) => th(c, k, dir)).join("")}</tr></thead>
        <tbody>${data.map(row).join("")}</tbody>
      </table>
    </div>

    <p class="hint" style="margin-top:10px">
      xGC is an estimate. The FPL API only publishes expected goals conceded per player, measured while they were
      on the pitch, so this scales that total back down by team minutes played. Treat it as a ranking, not a precise number.
    </p>
  `;

  $$("thead th[data-k]", root).forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.k;
      const s = S.ui.teamSort;
      s.dir = s.k === key ? -s.dir : key === "name" ? 1 : -1;
      s.k = key;
      renderTeams(root);
    };
  });
}

function row(t) {
  return `<tr>
    <td class="name">${esc(t.name)} <span class="sub-t">${t.short}</span></td>
    <td>${t.gp}</td>
    <td>${f2(t.xg)}</td>
    <td>${t.gf}</td>
    <td class="${t.gmxg >= 0 ? "pos" : "neg"}">${signed(+f2(t.gmxg))}</td>
    <td>${f2(t.xa)}</td>
    <td>${f2(t.xgc)}</td>
    <td>${t.ga}</td>
    <td class="${t.gcmxgc <= 0 ? "pos" : "neg"}">${signed(+f2(t.gcmxgc))}</td>
    <td>${t.cs}</td>
    <td style="color:var(--gold)">${Math.round(t.defcon)}</td>
    <td><span style="display:inline-flex;gap:2px">${fixtureStrip(t.id, 5)}</span> <span class="sub-t">${f2(t.fdr5)}</span></td>
  </tr>`;
}
