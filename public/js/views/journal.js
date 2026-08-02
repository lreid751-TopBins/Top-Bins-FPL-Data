import { S, f1, signed } from "../store.js";
import {
  J, KINDS, HORIZONS, REASONS, CONFIDENCE_WORDS,
  kindLabel, horizonLabel, reasonLabel,
  loadJournal, saveDraft, withdraw, scoreDecision, patterns, calibration, windowOf,
  blankDraft,
} from "../journal.js";
import { $, $$, esc, playerSearchResults, dropdownHTML, emptyState } from "../ui.js";
import { journalToken, setJournalToken } from "../api.js";
import { divergingBars } from "../charts.js";

let tab = "diary"; // diary | patterns
let showSync = false;
let syncError = "";

export function renderJournal(root) {
  const rerender = () => renderJournal(root);

  if (!J.loaded && !J.loading) {
    if (!J.draft.gw) J.draft.gw = S.nextGw;
    loadJournal().then(rerender);
  }

  if (J.loading && !J.loaded) {
    root.innerHTML = `<div class="empty"><div class="anton">Opening the journal</div>Reading your calls and what they returned.</div>`;
    return;
  }

  root.innerHTML = `
    <div class="eyebrow">Review</div>
    <div class="section-head">
      <h2>Decision Journal</h2>
      <div class="controls">
        <div class="seg" role="group" aria-label="Journal view">
          <button data-jtab="diary" ${tab === "diary" ? 'aria-pressed="true"' : ""}>Diary</button>
          <button data-jtab="patterns" ${tab === "patterns" ? 'aria-pressed="true"' : ""}>Patterns</button>
        </div>
      </div>
    </div>
    ${J.error ? `<p class="neg" style="margin-top:-6px">${esc(J.error)}</p>` : ""}
    ${tab === "diary" ? diaryTab() : patternsTab()}
  `;

  $$("[data-jtab]", root).forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.jtab;
      rerender();
    };
  });

  if (tab === "diary") wireDiary(root, rerender);
}

/* =========================================================
   Diary
   ========================================================= */
function diaryTab() {
  const p = patterns().overall;

  const grouped = new Map();
  for (const d of [...J.decisions].sort((a, b) => b.gw - a.gw || b.created_at.localeCompare(a.created_at))) {
    if (!grouped.has(d.gw)) grouped.set(d.gw, []);
    grouped.get(d.gw).push(d);
  }

  return `
    <div class="cards">
      <div class="card"><div class="lab">Points left on the table</div>
        <div class="big ${p.regret >= 0 ? "pos" : "neg"}">${p.count ? signed(+f1(p.regret)) : "—"}</div>
        <div class="foot">across ${p.count} scored call${p.count === 1 ? "" : "s"}</div></div>
      <div class="card accent"><div class="lab">Picked the best option</div>
        <div class="big">${p.count ? `${p.hitRate}%` : "—"}</div>
        <div class="foot">${p.hits} of ${p.count}</div></div>
      <div class="card"><div class="lab">Calls logged</div>
        <div class="big">${J.decisions.length}</div>
        <div class="foot">${J.decisions.filter((d) => d.gw >= S.nextGw).length} still to play</div></div>
      <div class="card"><div class="lab">Average per call</div>
        <div class="big ${p.avg >= 0 ? "pos" : "neg"}">${p.count ? signed(+f1(p.avg)) : "—"}</div>
        <div class="foot">regret against the field</div></div>
    </div>

    ${logForm()}

    ${
      grouped.size
        ? [...grouped.entries()]
            .map(([gw, list]) => `
              <div class="gw-block">
                <div class="gw-head"><span class="anton">Gameweek ${gw}</span>
                  <span class="hint">${list.length} call${list.length === 1 ? "" : "s"}</span></div>
                ${list.map(decisionCard).join("")}
              </div>`)
            .join("")
        : emptyState(
            "Nothing logged yet",
            `<p style="max-width:520px;margin:0 auto">Log the calls you actually agonised over, before the deadline.
             The journal records what you believed at the time, then scores it against what the other options did.</p>`
          )
    }

    ${syncPanel()}
  `;
}

/* ---------------- Reading the same diary elsewhere ---------------- */
function syncPanel() {
  if (!showSync) {
    return `<p class="hint" style="text-align:center;margin-top:24px">
      This diary lives on this browser's key.
      <button class="link-btn" id="jSyncOpen" style="text-transform:none;font-size:11px">Open it on another device</button>
    </p>`;
  }

  return `<div class="form" style="margin-top:24px">
    <h3>Read this diary elsewhere</h3>
    <p class="hint" style="margin:-6px 0 14px">
      There's no login. Your entries are tied to the key below, so paste it into the same box on your
      phone or laptop and both will show the same journal. Anyone with the key can read and add to it.
    </p>
    <div class="frow">
      <div class="field" style="flex:1 1 100%">
        <label>This browser's key</label>
        <input id="jToken" readonly value="${esc(journalToken())}" onclick="this.select()">
      </div>
    </div>
    <div class="frow">
      <div class="field" style="flex:1 1 100%">
        <label>Use a key from another device</label>
        <input id="jTokenIn" placeholder="Paste the key here" autocomplete="off">
      </div>
    </div>
    ${syncError ? `<p class="neg" style="margin:0 0 12px">${esc(syncError)}</p>` : ""}
    <div class="frow" style="margin-bottom:0">
      <button class="btn primary" id="jTokenSave">Switch to that key</button>
      <button class="btn ghost" id="jSyncClose">Close</button>
    </div>
  </div>`;
}

/* ---------------- The form ---------------- */
function logForm() {
  const d = J.draft;
  const kind = KINDS.find((k) => k.id === d.kind);
  const gwOptions = [];
  for (let g = Math.max(1, S.nextGw - 1); g <= Math.min(38, S.nextGw + 5); g++) gwOptions.push(g);

  const titlePlaceholder = {
    captain: "e.g. Haaland over Salah",
    transfer: "e.g. Second midfield slot",
    bench: "e.g. Start the third defender?",
    chip: "e.g. Hold the wildcard",
    hold: "e.g. Roll the transfer",
  }[d.kind];

  return `<div class="form">
    <h3>Log a call</h3>
    <p class="hint" style="margin:-6px 0 14px">
      Write it before the deadline. Once the gameweek starts the entry is fixed, which is the point.
    </p>

    <div class="frow">
      <div class="field" style="flex:1 1 260px">
        <label>What kind of call</label>
        <select id="jKind">${KINDS.map((k) =>
          `<option value="${k.id}" ${k.id === d.kind ? "selected" : ""}>${esc(k.label)}</option>`
        ).join("")}</select>
        <span class="hint">${esc(kind?.hint ?? "")}</span>
      </div>
      <div class="field">
        <label>For gameweek</label>
        <select id="jGw">${gwOptions.map((g) =>
          `<option value="${g}" ${g === d.gw ? "selected" : ""}>GW${g}${g === S.nextGw ? " (next)" : ""}</option>`
        ).join("")}</select>
      </div>
      <div class="field">
        <label>Judge it over</label>
        <select id="jHorizon">${HORIZONS.map((h) =>
          `<option value="${h.id}" ${h.id === d.horizon ? "selected" : ""}>${esc(h.label)}</option>`
        ).join("")}</select>
      </div>
    </div>

    <div class="frow">
      <div class="field" style="flex:1 1 100%">
        <label>Give it a name</label>
        <input id="jTitle" placeholder="${esc(titlePlaceholder)}" value="${esc(d.title)}" maxlength="120">
      </div>
    </div>

    <div class="frow">
      <div class="cand-search field" style="flex:1 1 100%">
        <label>Who was in the running</label>
        <input id="jSearch" placeholder="Search the players you weighed up…" autocomplete="off">
        <div id="jDrop"></div>
      </div>
    </div>

    <div class="chips" id="jChips">${
      d.options.length
        ? d.options.map((o) => optionChip(o, d.chosen)).join("")
        : `<span class="hint">Add every option you seriously considered, then mark the one you went with.</span>`
    }</div>

    <div class="frow">
      <div class="field" style="flex:1 1 240px">
        <label>How sure were you</label>
        <div class="seg conf" role="group" aria-label="Confidence">
          ${[1, 2, 3, 4, 5].map((c) =>
            `<button data-conf="${c}" ${c === d.confidence ? 'aria-pressed="true"' : ""} title="${esc(CONFIDENCE_WORDS[c])}">${c}</button>`
          ).join("")}
        </div>
        <span class="hint">${esc(CONFIDENCE_WORDS[d.confidence])}</span>
      </div>
      <div class="field" style="flex:1 1 340px">
        <label>What drove it</label>
        <div class="tagrow">${REASONS.map((r) =>
          `<button class="tag ${d.reasons.includes(r.id) ? "on" : ""}" data-reason="${r.id}"
            aria-pressed="${d.reasons.includes(r.id)}">${esc(r.label)}</button>`
        ).join("")}</div>
      </div>
    </div>

    <div class="frow">
      <div class="field" style="flex:1 1 100%">
        <label>Why, in your own words</label>
        <textarea id="jNote" rows="3" maxlength="600"
          placeholder="The bit you'll want to read back in six weeks. What did you believe, and what would have changed your mind?">${esc(d.note)}</textarea>
        <span class="hint"><span id="jCount">${d.note.length}</span> / 600</span>
      </div>
    </div>

    ${J.formError ? `<p class="neg" style="margin:0 0 12px">${esc(J.formError)}</p>` : ""}

    <div class="frow" style="margin-bottom:0">
      <button class="btn primary" id="jSave" ${
        !d.options.length || !d.chosen || J.saving ? "disabled" : ""
      }>${J.saving ? "Saving…" : "Log this call"}</button>
      <button class="btn ghost" id="jClear">Clear</button>
      ${!d.chosen && d.options.length ? `<span class="hint">Mark which one you went with.</span>` : ""}
    </div>
  </div>`;
}

function optionChip(o, chosen) {
  const on = o.id === chosen;
  return `<span class="chip">
    <b>${esc(o.name)}</b> <span class="sub-t">${esc(o.short)} · ${esc(o.pos)}</span>
    <button class="pick ${on ? "on" : ""}" data-pick="${o.id}">${on ? "✓ Went with" : "Went with?"}</button>
    <button class="x" data-drop="${o.id}" aria-label="Remove ${esc(o.name)}">×</button>
  </span>`;
}

/* ---------------- One entry ---------------- */
function decisionCard(d) {
  const s = scoreDecision(d);
  const w = windowOf(d);

  let verdict;
  if (s.status.state === "pending") {
    verdict = `<span class="verdict wait">Not played</span>`;
  } else if (s.soloOption) {
    verdict = `<span class="verdict even">${s.chosen.pts} pts</span>`;
  } else {
    const cls = s.regret > 0 ? "win" : s.regret < 0 ? "loss" : "even";
    verdict = `<span class="verdict ${cls}">${signed(+f1(s.regret))}</span>`;
  }

  const maxPts = Math.max(1, ...s.rows.map((r) => r.pts));
  const running = s.status.state === "running";

  return `<div class="dcard">
    <div class="top">
      <div>
        <div class="title">
          <span class="kind-chip">${esc(kindLabel(d.kind))}</span>
          ${esc(d.title || kindLabel(d.kind))} ${verdict}
        </div>
        <div class="meta">
          ${esc(horizonLabel(d.horizon))}${w.openEnded ? "" : ` · GW${w.start}${w.end > w.start ? `–${w.end}` : ""}`}
          · confidence ${d.confidence}/5
          ${
            s.status.state === "pending"
              ? " · waiting on kick-off"
              : running
              ? ` · ${s.status.played.length} of ${w.openEnded ? "many" : w.end - w.start + 1} played`
              : s.soloOption
              ? ""
              : ` · you ranked #${s.rank} of ${s.rows.length}`
          }
        </div>
      </div>
    </div>

    ${
      s.status.state === "pending"
        ? ""
        : `<div class="ladder">${s.rows
            .map((r) => {
              const best = r.id === s.best.id && !s.soloOption;
              return `<div class="rung ${r.isChosen ? "chosen" : ""}">
                <div class="rn">${best ? '<span class="crown">★</span>' : ""}${esc(r.name)}
                  <span class="sub-t">${esc(r.short)}</span>
                  ${r.isChosen ? '<span class="you">yours</span>' : ""}</div>
                <div class="track"><div class="fill" style="width:${Math.round((100 * r.pts) / maxPts)}%"></div></div>
                <div class="pts">${r.pts}</div>
              </div>`;
            })
            .join("")}</div>`
    }

    ${
      d.note || (d.reasons ?? []).length
        ? `<div class="reasoning">
            ${d.note ? `<blockquote>${esc(d.note)}</blockquote>` : ""}
            ${
              (d.reasons ?? []).length
                ? `<div class="tagrow static">${d.reasons
                    .map((r) => `<span class="tag on">${esc(reasonLabel(r))}</span>`)
                    .join("")}</div>`
                : ""
            }
          </div>`
        : ""
    }

    <div class="foot">
      <span class="hint">${
        d.gw > S.currentGw ? "Can still be withdrawn" : "Locked — the gameweek has started"
      }</span>
      ${
        d.gw > S.currentGw
          ? `<button class="link-btn" data-withdraw="${d.id}">Withdraw</button>`
          : ""
      }
    </div>
  </div>`;
}

/* =========================================================
   Patterns
   ========================================================= */
function patternsTab() {
  const p = patterns();
  if (!p.overall.count) {
    return emptyState(
      "Nothing has played out yet",
      `<p style="max-width:520px;margin:0 auto">Patterns appear once a few decisions have played out.
       Log calls for a handful of gameweeks and this page starts telling you where you actually gain and lose points.</p>`
    );
  }

  const cal = calibration();
  const meta = (i) => `${i.count} call${i.count === 1 ? "" : "s"} · ${i.hitRate}% best`;

  return `
    ${
      cal
        ? `<div class="insight">
            <div class="insight-l">Are you right when you feel right?</div>
            <p>${esc(calibrationSentence(cal))}</p>
          </div>`
        : ""
    }

    <div class="chart-box hero">
      <h3>By how sure you were</h3>
      <p class="cap">Average points won or lost against the best option, grouped by the confidence you logged at the time.
      A healthy journal slopes upward: the calls you were surest about should be the ones that pay.
      Gameweeks still in progress count only what has been played.</p>
      ${divergingBars(
        p.byConfidence.filter((c) => c.count).map((c) => ({ ...c, value: c.avg })),
        { meta, empty: "Nothing settled yet." }
      )}
    </div>

    <div class="chart-box">
      <h3>By what drove the call</h3>
      <p class="cap">The same measure, grouped by the reasons you tagged. This is the one worth arguing about on the pod.</p>
      ${divergingBars(
        p.byReason.map((r) => ({ ...r, value: r.avg })),
        { meta, empty: "Tag a few calls and this fills in." }
      )}
    </div>

    <div class="chart-box">
      <h3>By type of decision</h3>
      <p class="cap">Where the points actually go. Most managers find one category quietly bleeding.</p>
      <div class="twrap" style="max-height:none">
        <table style="min-width:520px">
          <thead><tr>
            <th style="text-align:left">Decision</th><th>Scored</th><th>Best pick</th>
            <th>Total</th><th>Average</th>
          </tr></thead>
          <tbody>${p.byKind
            .map((k) => `<tr>
              <td class="name">${esc(k.label)}</td>
              <td>${k.count}</td>
              <td>${k.hitRate}%</td>
              <td class="${k.regret >= 0 ? "pos" : "neg"}">${signed(+f1(k.regret))}</td>
              <td class="${k.avg >= 0 ? "pos" : "neg"}">${signed(+f1(k.avg))}</td>
            </tr>`)
            .join("")}</tbody>
        </table>
      </div>
    </div>

    <p class="hint">
      Regret is your points minus the best option you passed on, so zero means you picked the winner and a negative
      number is what the alternative would have earned. Decisions with a single option aren't scored — there was
      nothing to get wrong.
    </p>
  `;
}

function calibrationSentence(cal) {
  const high = f1(cal.high.avg);
  const low = f1(cal.low.avg);
  if (cal.gap > 0.5) {
    return `Your confident calls average ${signed(+high)} and your coin flips ${signed(+low)}. Confidence is tracking reality — when you're sure, back it harder.`;
  }
  if (cal.gap < -0.5) {
    return `Your confident calls average ${signed(+high)} while your coin flips average ${signed(+low)}. Certainty is costing you: the calls you agonise over are going better than the ones you think are obvious.`;
  }
  return `Confident calls average ${signed(+high)}, uncertain ones ${signed(+low)}. There's no real gap yet, which means your confidence isn't carrying information — worth noticing before you take a hit on a gut feeling.`;
}

/* =========================================================
   Events
   ========================================================= */
function wireDiary(root, rerender) {
  const d = J.draft;

  const bind = (sel, event, fn) => {
    const el = $(sel, root);
    if (el) el[event] = fn;
  };

  bind("#jKind", "onchange", (e) => { d.kind = e.target.value; rerender(); });
  bind("#jGw", "onchange", (e) => { d.gw = +e.target.value; });
  bind("#jHorizon", "onchange", (e) => { d.horizon = e.target.value; });
  bind("#jTitle", "oninput", (e) => { d.title = e.target.value; });

  const note = $("#jNote", root);
  if (note)
    note.oninput = () => {
      d.note = note.value;
      const c = $("#jCount", root);
      if (c) c.textContent = String(note.value.length);
    };

  $$("[data-conf]", root).forEach((b) => {
    b.onclick = () => { d.confidence = +b.dataset.conf; rerender(); };
  });

  $$("[data-reason]", root).forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.reason;
      d.reasons = d.reasons.includes(id)
        ? d.reasons.filter((r) => r !== id)
        : [...d.reasons, id].slice(0, 6);
      rerender();
    };
  });

  const search = $("#jSearch", root);
  const drop = $("#jDrop", root);
  if (search)
    search.oninput = () => {
      const exclude = new Set(d.options.map((o) => o.id));
      const hits = playerSearchResults(search.value, { exclude });
      drop.innerHTML = search.value.trim() ? dropdownHTML(hits) : "";
      $$("[data-add]", drop).forEach((b) => {
        b.onclick = () => {
          const p = S.playerById[b.dataset.add];
          if (p && d.options.length < 8) {
            d.options.push({ id: p.id, name: p.name, short: p.short, pos: p.pos });
          }
          rerender();
          $("#jSearch", root)?.focus();
        };
      });
    };

  $$("[data-pick]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.pick;
      d.chosen = d.chosen === id ? null : id;
      rerender();
    };
  });

  $$("[data-drop]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.drop;
      d.options = d.options.filter((o) => o.id !== id);
      if (d.chosen === id) d.chosen = null;
      rerender();
    };
  });

  bind("#jSave", "onclick", async () => {
    J.saving = true;
    rerender();
    await saveDraft();
    rerender();
  });

  bind("#jClear", "onclick", () => {
    J.draft = blankDraft();
    J.draft.gw = S.nextGw;
    J.formError = "";
    rerender();
  });

  bind("#jSyncOpen", "onclick", () => { showSync = true; syncError = ""; rerender(); });
  bind("#jSyncClose", "onclick", () => { showSync = false; syncError = ""; rerender(); });
  bind("#jTokenSave", "onclick", async () => {
    const value = $("#jTokenIn", root)?.value ?? "";
    try {
      setJournalToken(value);
      syncError = "";
      showSync = false;
      J.loaded = false;
      J.decisions = [];
      rerender();
      await loadJournal();
      rerender();
    } catch (err) {
      syncError = err.message;
      rerender();
    }
  });

  $$("[data-withdraw]", root).forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      await withdraw(b.dataset.withdraw);
      rerender();
    };
  });
}
