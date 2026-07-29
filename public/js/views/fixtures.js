import { S, difficultyOf, upcoming, runDifficulty, f1, f2 } from "../store.js";
import { $, $$, esc } from "../ui.js";

const MODE_COPY = {
  official: {
    title: "Official difficulty",
    caption:
      "The rating built into the FPL game. Useful as a baseline, but it barely moves all season.",
  },
  attack: {
    title: "How hard to score",
    caption:
      "Built from the opponent's defensive strength at the relevant venue. Read this one for forwards and attacking midfielders.",
  },
  defence: {
    title: "How hard to keep a clean sheet",
    caption:
      "Built from the opponent's attacking strength at the relevant venue. Read this one for defenders and goalkeepers.",
  },
};

export function renderFixtures(root) {
  const { fdrMode: mode, fdrSpan: span, fdrSort: sort } = S.ui;
  const gws = [];
  for (let g = S.nextGw; g < S.nextGw + span; g++) gws.push(g);

  const rows = S.teamList.map((t) => ({
    team: t,
    avg: runDifficulty(t.id, span, mode),
    fixtures: upcoming(t.id, span),
  }));

  if (sort === "avg") rows.sort((a, b) => a.avg - b.avg);
  else if (sort === "name") rows.sort((a, b) => a.team.name.localeCompare(b.team.name));

  const best = rows[0];
  const worst = [...rows].sort((a, b) => b.avg - a.avg)[0];
  const doubles = rows
    .map((r) => ({ team: r.team, count: r.fixtures.filter((f) => f.list.length > 1).length }))
    .filter((x) => x.count > 0);
  const blanks = rows
    .map((r) => ({ team: r.team, count: r.fixtures.filter((f) => !f.list.length).length }))
    .filter((x) => x.count > 0);

  root.innerHTML = `
    <div class="eyebrow">Planning</div>
    <div class="section-head">
      <h2>Fixture Ticker</h2>
      <div class="controls">
        <div class="seg" role="group" aria-label="Difficulty model">
          <button data-mode="official" ${mode === "official" ? 'aria-pressed="true"' : ""}>Official</button>
          <button data-mode="attack" ${mode === "attack" ? 'aria-pressed="true"' : ""}>Attack</button>
          <button data-mode="defence" ${mode === "defence" ? 'aria-pressed="true"' : ""}>Defence</button>
        </div>
        <select id="fdrSpan" aria-label="Number of gameweeks">
          ${[4, 6, 8, 10].map((v) => `<option value="${v}" ${v === span ? "selected" : ""}>Next ${v} GWs</option>`).join("")}
        </select>
        <select id="fdrSort" aria-label="Sort teams">
          <option value="avg" ${sort === "avg" ? "selected" : ""}>Easiest run first</option>
          <option value="name" ${sort === "name" ? "selected" : ""}>A–Z</option>
        </select>
      </div>
    </div>

    <p class="hint" style="margin:-6px 0 14px">
      <b style="color:var(--chalk)">${MODE_COPY[mode].title}.</b> ${MODE_COPY[mode].caption}
    </p>

    <div class="cards">
      ${card("Kindest run", best?.team.name, f2(best?.avg ?? 0), `avg over GW${S.nextGw}–${S.nextGw + span - 1}`, true)}
      ${card("Toughest run", worst?.team.name, f2(worst?.avg ?? 0), "avoid the defence here")}
      ${card("Double gameweeks", doubles.length ? doubles.map((d) => d.team.short).join(" ") : "None scheduled", "", doubles.length ? "extra fixture in the window" : "in this window")}
      ${card("Blanks", blanks.length ? blanks.map((d) => d.team.short).join(" ") : "None scheduled", "", blanks.length ? "no fixture in the window" : "in this window")}
    </div>

    <div class="ticker-wrap">
      <table class="ticker">
        <thead>
          <tr>
            <th class="team-h">Team</th>
            ${gws.map((g) => `<th>GW${g}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => tickerRow(r, mode)).join("")}
        </tbody>
      </table>
    </div>

    <div class="legend">
      <span>Easier</span>
      <span class="swatches">
        ${[1, 2, 3, 4, 5].map((d) => `<span class="sw" style="background:var(--fdr-${d})"></span>`).join("")}
      </span>
      <span>Harder</span>
      <span style="margin-left:8px">Gold outline = double gameweek · hatched = blank</span>
    </div>
  `;

  wire(root);
}

function card(lab, big, small, foot, accent = false) {
  const size = String(big || "").length > 12 ? "font-size:17px" : "";
  return `<div class="card${accent ? " accent" : ""}">
    <div class="lab">${esc(lab)}</div>
    <div class="big" style="${size}">${esc(big || "—")}${small ? `<small>${small}</small>` : ""}</div>
    <div class="foot">${esc(foot)}</div>
  </div>`;
}

function tickerRow(r, mode) {
  const cells = r.fixtures
    .map((slot) => {
      if (!slot.list.length) {
        return `<td><div class="cell blank">blank</div></td>`;
      }
      const isDouble = slot.list.length > 1;
      const avg = slot.list.reduce((a, f) => a + difficultyOf(f, mode), 0) / slot.list.length;
      const band = Math.max(1, Math.min(5, Math.round(avg)));
      const inner = slot.list
        .map(
          (f) =>
            `<span>${esc(S.teams[f.opp]?.short || "?")}<span class="ha"> ${f.home ? "H" : "A"}</span></span>`
        )
        .join("");
      return `<td><div class="cell d${band}${isDouble ? " dbl" : ""}">${inner}</div></td>`;
    })
    .join("");

  return `<tr>
    <td class="team-c">${esc(r.team.name)}<span class="avg">${f2(r.avg)}</span></td>
    ${cells}
  </tr>`;
}

function wire(root) {
  $$("[data-mode]", root).forEach((b) => {
    b.onclick = () => {
      S.ui.fdrMode = b.dataset.mode;
      renderFixtures(root);
    };
  });
  const span = $("#fdrSpan", root);
  if (span)
    span.onchange = () => {
      S.ui.fdrSpan = +span.value;
      renderFixtures(root);
    };
  const sort = $("#fdrSort", root);
  if (sort)
    sort.onchange = () => {
      S.ui.fdrSort = sort.value;
      renderFixtures(root);
    };
}
