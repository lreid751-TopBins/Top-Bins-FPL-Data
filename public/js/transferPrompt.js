/* =========================================================
   Post-deadline transfer prompt

   The journal is only worth anything if decisions actually get logged,
   and the moment they're most loggable is right after the deadline,
   when you still remember why you did it. This catches that moment:
   on the first load after a gameweek locks in, it shows the transfers
   FPL says you actually made and offers to start a journal entry from
   them.

   Deliberately pre-fills the *what* and never the *why*. The journal
   scores decisions by regret, which needs the confidence and reasoning
   you held at the time - so this hands over a half-filled draft and
   still makes you finish it. Auto-logging a complete entry would fill
   the journal with rows that can't be scored.

   Read-only: FPL publishes /entry/{id}/transfers, so there's nothing
   to OCR, nothing to upload, and nothing to get wrong.
   ========================================================= */
import { S } from "./store.js";
import { esc } from "./ui.js";
import { api } from "./api.js";
import { J, blankDraft } from "./journal.js";

const SEEN_KEY = "tb:xferPromptGw";

const seenGw = () => Number(localStorage.getItem(SEEN_KEY) || 0);
const markSeen = (gw) => {
  try {
    localStorage.setItem(SEEN_KEY, String(gw));
  } catch {
    // Private browsing and the like - worst case it offers again next load.
  }
};

function els() {
  return { panel: document.getElementById("xferPrompt"), backdrop: document.getElementById("xferBackdrop") };
}

export function closeTransferPrompt() {
  const { panel, backdrop } = els();
  if (!panel || !backdrop) return;
  panel.classList.remove("show");
  backdrop.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (panel.classList.contains("show")) return; // reopened mid-close
    panel.hidden = true;
    backdrop.hidden = true;
  }, 260);
}

/** The transfers FPL recorded for a gameweek, mapped onto real players. */
function transfersFor(list, gw) {
  return (list || [])
    .filter((t) => t.event === gw)
    .map((t) => ({
      inP: S.playerById[t.element_in],
      outP: S.playerById[t.element_out],
      cost: (t.element_in_cost - t.element_out_cost) / 10,
    }))
    .filter((t) => t.inP && t.outP);
}

function draftFrom(moves, gw) {
  const asOption = (p) => ({ id: p.id, name: p.name, short: p.short, pos: p.pos });
  const title =
    moves.length === 1
      ? `${moves[0].inP.name} in for ${moves[0].outP.name}`
      : `${moves.length} transfers in GW${gw}`;
  return {
    ...blankDraft(),
    kind: "transfer",
    gw,
    horizon: "3",
    title,
    options: moves.flatMap((m) => [asOption(m.inP), asOption(m.outP)]),
    chosen: moves[0]?.inP.id ?? null,
  };
}

function render(moves, gw) {
  const { panel, backdrop } = els();
  if (!panel || !backdrop) return;

  const rows = moves
    .map(
      (m) => `<div class="xfer-row">
        <span class="xfer-out">${esc(m.outP.name)}<span class="sub-t"> ${esc(m.outP.short)}</span></span>
        <span class="xfer-arrow" aria-hidden="true">&rarr;</span>
        <span class="xfer-in">${esc(m.inP.name)}<span class="sub-t"> ${esc(m.inP.short)}</span></span>
      </div>`
    )
    .join("");

  panel.innerHTML = `
    <div class="xfer-eyebrow">Gameweek ${gw} is locked in</div>
    <h2 class="xfer-title">${moves.length === 1 ? "You made a move" : `You made ${moves.length} moves`}</h2>
    <p class="xfer-sub">Log what you were thinking now, while it's fresh - the journal scores your calls by
      what you actually believed at the time, not by hindsight.</p>
    <div class="xfer-rows">${rows}</div>
    <div class="xfer-actions">
      <button class="btn primary" id="xferLog">Log my thinking &rarr;</button>
      <button class="btn ghost" id="xferSkip">Not now</button>
    </div>
  `;

  panel.hidden = false;
  backdrop.hidden = false;
  // Both a frame callback and a timer, whichever lands first - adding the
  // class twice is harmless. rAF alone is a trap here: browsers don't run
  // it in a background tab, and opening the site in one is completely
  // normal. Without .show the panel keeps opacity 0 while the backdrop
  // stays in the DOM at full size - an invisible sheet that still swallows
  // every click, which is far worse than a prompt that doesn't animate.
  const reveal = () => {
    panel.classList.add("show");
    backdrop.classList.add("show");
    panel.setAttribute("aria-hidden", "false");
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
  setTimeout(reveal, 32);

  panel.querySelector("#xferLog").onclick = () => {
    J.draft = draftFrom(moves, gw);
    markSeen(gw);
    closeTransferPrompt();
    document.querySelector('[data-tab="journal"]')?.click();
  };
  panel.querySelector("#xferSkip").onclick = () => {
    markSeen(gw);
    closeTransferPrompt();
  };
}

/**
 * Offer to journal this gameweek's transfers, once. Silent unless there's
 * genuinely something to log: no connected team, no transfers that
 * gameweek, or already offered for it all return without doing anything.
 */
export async function maybeShowTransferPrompt() {
  const id = S.ui.managerId;
  const gw = S.currentGw;
  if (!id || !S.entry || !gw) return false;
  if (seenGw() >= gw) return false;

  let list;
  try {
    list = await api.transfers(id);
  } catch {
    return false; // a prompt is a bonus, never a reason to surface an error
  }

  const moves = transfersFor(list, gw);
  if (!moves.length) {
    // Nothing to log is still an answer for this gameweek - don't re-ask
    // on every reload until the next one starts.
    markSeen(gw);
    return false;
  }

  render(moves, gw);
  return true;
}

// Dismiss interactions wired once, same as the other overlay panels.
document.addEventListener("click", (e) => {
  if (e.target?.id === "xferBackdrop") closeTransferPrompt();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("xferPrompt")?.hidden === false) closeTransferPrompt();
});
