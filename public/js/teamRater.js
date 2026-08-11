/* =========================================================
   Team Rater drawer

   A single shared panel any tab can open with a completed 15 - My Team and
   Planner both call openRater(picks, captain) rather than each view
   building its own. Same shape as playerDetail.js: lives outside the
   normal render cycle, own dismiss listeners wired once at module load.

   Scoring itself never happens here - this only sends the 15 ids to the
   edge function and shows back whatever it says. That's deliberate: if the
   percentage were computed in the browser, anyone could open devtools and
   submit a fake 100%. See supabase/functions/fpl/rating.ts.
   ========================================================= */
import { f1 } from "./store.js";
import { $, esc } from "./ui.js";
import { api } from "./api.js";

const NICKNAME_KEY = "tb:raterNickname";

export const RT = {
  picks: [],       // [{id}], the 15 being submitted
  captain: null,
  span: 5,
  nickname: localStorage.getItem(NICKNAME_KEY) || "",
  submitting: false,
  error: "",
  result: null,     // { pct, submittedTotal, ceilingTotal, window } once scored
};

const ERROR_COPY = {
  missing_nickname: "Enter a name for the announcement.",
  bad_picks: "That doesn't look like a complete, legal squad - try again from a full 15.",
  bad_captain: "That captain pick doesn't look right.",
  bad_window: "That's an odd projection window - try again.",
  invalid_json: "Something went wrong sending that. Try again.",
  too_many_requests: "One submission at a time - give it a few seconds and try again.",
};

function panelEl() {
  return document.getElementById("teamRater");
}
function backdropEl() {
  return document.getElementById("trBackdrop");
}

/**
 * Open the rater with a completed squad. `picks` is any array of objects
 * carrying an `id` (player objects work fine, only `.id` is read).
 */
export function openRater(picks, captain, span = 5) {
  RT.picks = (picks || []).map((p) => ({ id: p.id }));
  RT.captain = captain ?? null;
  RT.span = span;
  RT.error = "";
  RT.result = null;
  RT.submitting = false;
  render();

  const panel = panelEl();
  const backdrop = backdropEl();
  if (!panel || !backdrop) return;
  panel.hidden = false;
  backdrop.hidden = false;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();
  raf(() => {
    panel.classList.add("show");
    backdrop.classList.add("show");
    panel.setAttribute("aria-hidden", "false");
  });
}

export function closeRater() {
  const panel = panelEl();
  const backdrop = backdropEl();
  if (!panel || !backdrop) return;
  panel.classList.remove("show");
  backdrop.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (panel.classList.contains("show")) return; // reopened before the close animation finished
    panel.hidden = true;
    backdrop.hidden = true;
  }, 300);
}

async function submit() {
  RT.submitting = true;
  RT.error = "";
  render();

  try {
    const result = await api.rateTeam({
      nickname: RT.nickname.trim(),
      picks: RT.picks,
      captain: RT.captain,
      window: RT.span,
    });
    localStorage.setItem(NICKNAME_KEY, RT.nickname.trim());
    RT.result = result;
  } catch (err) {
    RT.error = err.body?.error === "invalid_squad"
      ? (err.body.message || "That squad didn't score - try again.")
      : (ERROR_COPY[err.body?.error] || "Couldn't score that. Check your connection and try again.");
  } finally {
    RT.submitting = false;
    render();
  }
}

function form() {
  return `
    <h3 class="pd-h3" style="margin-top:0">Rate my team</h3>
    <p class="pd-cap">
      Scored against the strongest legal squad buildable this window - same
      rules as everywhere else on the site: £100m, 2 GKP/5 DEF/5 MID/3 FWD,
      max 3 from one club. 100% means you've built the ceiling - that's
      meant to be hard to reach, and it moves as fixtures do.
    </p>
    <div class="field">
      <label for="trNickname">Name for the announcement</label>
      <input id="trNickname" placeholder="e.g. Marina" maxlength="40" value="${esc(RT.nickname)}" autocomplete="off">
    </div>
    ${RT.error ? `<p class="pd-news">${esc(RT.error)}</p>` : ""}
    <button class="btn primary" id="trSubmit" style="margin-top:12px" ${RT.submitting ? "disabled" : ""}>
      ${RT.submitting ? "Scoring…" : "Rate my team"}
    </button>
  `;
}

function resultView() {
  const r = RT.result;
  const pct = Math.max(0, Math.min(100, r.pct));
  return `
    <h3 class="pd-h3" style="margin-top:0">Your score</h3>
    <div class="tr-score">${f1(pct)}<span class="tr-score-unit">%</span></div>
    <p class="pd-cap" style="margin-top:-4px">of this window's ceiling</p>
    <div class="tr-bar"><div class="tr-bar-fill" style="width:${pct}%"></div></div>
    <div class="tr-stats-row">
      <span>${f1(r.submittedTotal)} pts projected</span>
      <span>${f1(r.ceilingTotal)} pt ceiling</span>
    </div>
    <p class="pd-cap" style="margin-top:14px">Announced in the Top Bins Discord as <b>${esc(RT.nickname)}</b>.</p>
    <button class="btn ghost" id="trAgain" style="margin-top:8px">Rate another squad</button>
  `;
}

function render() {
  const panel = panelEl();
  if (!panel) return;

  panel.innerHTML = `
    <button class="pd-close" id="trClose" aria-label="Close">×</button>
    ${RT.result ? resultView() : form()}
  `;

  $("#trClose", panel).onclick = closeRater;

  const nickname = $("#trNickname", panel);
  if (nickname) {
    nickname.oninput = () => { RT.nickname = nickname.value; };
    nickname.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  }
  const submitBtn = $("#trSubmit", panel);
  if (submitBtn) submitBtn.onclick = submit;

  const again = $("#trAgain", panel);
  if (again) {
    again.onclick = () => {
      RT.result = null;
      RT.error = "";
      render();
    };
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (panelEl()?.hidden !== false) return;
    if (e.target.closest("#teamRater") || e.target.closest("[data-open-rater]")) return;
    closeRater();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelEl()?.hidden === false) closeRater();
  });
}
