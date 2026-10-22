// keys: cut from progressive.js for the bundling probe (#754).
import { afterFills } from './core.js';

// Keyboard shortcuts (`docs/design/naming.md`, "Keys"): a shortcut is a
// click. The server binds a chord to a control as the platform's own
// declaration of one — `aria-keyshortcuts`, minted from a `#[key(…)]`
// field and nothing else — and pressing it does what a click on that
// control does: a button or link activates, a field takes focus. The
// attribute is the one wire: what assistive tech announces is what the
// shim matches, in the ARIA spelling (`Control+Enter`, `Shift+I`, a
// shifted character as the character it produces). `Control` and
// `Meta` both read as the platform's command modifier, since the
// framework offers no other. The DOM is the map: nothing registers, so
// fills and navigations need no bookkeeping. Scope is reachability — a
// key answers only on a control that is rendered, visible, enabled and
// not inert, and while a modal `<dialog>` is open only inside it —
// which is what lets a modal's keys reuse the page's (the types keep
// each set collision-free; two candidates here is the runtime witness
// of a leak).
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const NAMED_KEYS = { Space: ' ' };
function chordMatches(spec, e) {
  const parts = spec.split('+');
  const key = parts.pop();
  let mod = false;
  let shift = false;
  for (const m of parts) {
    if (m === 'Control' || m === 'Meta') mod = true;
    else if (m === 'Shift') shift = true;
    else return false;
  }
  const wantMod = IS_MAC ? e.metaKey : e.ctrlKey;
  const otherMod = IS_MAC ? e.ctrlKey : e.metaKey;
  if (e.altKey || otherMod || wantMod !== mod) return false;
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return e.shiftKey === shift && e.key.toLowerCase() === key.toLowerCase();
    // A produced character: whatever modifier produced it is part of it.
    return e.key === key;
  }
  return e.key === (NAMED_KEYS[key] ?? key);
}
function actionable(el) {
  if (!el.isConnected || !el.checkVisibility()) return false;
  if (el.matches(':disabled, [aria-disabled="true"]') || el.closest('[inert]')) return false;
  const modal = document.querySelector('dialog:modal');
  return !modal || modal.contains(el);
}
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.repeat) return;
  const editing = e.target.matches?.('input, textarea, select, [contenteditable]');
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  // The sheet: `?` is the framework's, and reserved from apps.
  if (e.key === '?' && !mod && !e.altKey && !editing) {
    const sheet = document.querySelector('dialog[data-key-sheet]');
    if (sheet && !sheet.open) {
      e.preventDefault();
      sheet.showModal();
    }
    return;
  }
  // A bare or shifted key typed into a field is typing; a chord with
  // the command modifier still answers (`Mod + Enter` submits).
  if (editing && !mod) return;
  const candidates = [...document.querySelectorAll('[aria-keyshortcuts]')]
    .filter((el) => chordMatches(el.getAttribute('aria-keyshortcuts'), e) && actionable(el));
  if (candidates.length === 0) return;
  if (candidates.length > 1) {
    console.error(`two controls answer \`${e.key}\` at once:`, candidates);
  }
  e.preventDefault();
  const target = candidates[0];
  if (target.matches('input, textarea, select')) {
    target.focus();
    if (target.select) target.select();
  } else if (target.matches('[data-pattern="editor"]')) {
    // A rich editor is a field: the key puts the caret in it.
    target.querySelector('[data-editor-content]')?.focus();
  } else {
    target.click();
  }
});
// The command modifier is `Ctrl` as rendered and `⌘` on a Mac: the
// hint's cap (`data-key-mod`), a keyed field's placeholder (the
// `KeyHint::text` form), and the announced form (`aria-keyshortcuts`)
// are rewritten once per document and after every fill. Idempotent.
export function platformizeKeys(root) {
  if (!IS_MAC) return;
  for (const k of root.querySelectorAll('kbd[data-key-mod]')) k.textContent = '⌘';
  for (const el of root.querySelectorAll('[aria-keyshortcuts^="Control+"]')) {
    el.setAttribute('aria-keyshortcuts', el.getAttribute('aria-keyshortcuts').replace(/^Control\+/, 'Meta+'));
  }
  for (const el of root.querySelectorAll('[aria-keyshortcuts][placeholder*="Ctrl+"]')) {
    el.setAttribute('placeholder', el.getAttribute('placeholder').replaceAll('Ctrl+', '⌘+'));
  }
}
addEventListener('load', () => platformizeKeys(document));
// A dialog the page arrived to open (`El::<Dialog>::shown_on_arrival`,
// `data-show-on-arrival`): rendered `open`, which is the platform's
// non-modal open, and promoted here to the modal it is — the backdrop,
// the inert page, the focus. Once per arrival: the mark is spent, so a
// later fill of the same range does not open it again unless the
// server says so again.
export function showArrivals(root) {
  for (const d of root.querySelectorAll('dialog[data-show-on-arrival]')) {
    d.removeAttribute('data-show-on-arrival');
    if (d.open) d.close();
    d.showModal();
  }
}
showArrivals(document);
addEventListener('DOMContentLoaded', () => showArrivals(document));
afterFills.push(() => { platformizeKeys(document); showArrivals(document); });
