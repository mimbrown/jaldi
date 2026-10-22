// tallies: cut from progressive.js for the bundling probe (#754).
import { afterFills } from './core.js';

// Tallies (`dom::Tally`, `docs/design/forms.md`, "Tally"): a long
// form's read-outs of how many of its fields are given. A field is
// given when the form's data carries a non-empty entry under its name
// (typed text, a ticked box, a picked file), so the count reads what
// the save would post and nothing else. Every read-out names its form
// and fields; each pass reads each form's data once. Jump puts the
// caret in the first owed field still empty, in the tally's order.
let tallyQueued = false;
function tallyNames(el, attr) {
  return (el.getAttribute(attr) || '').split(' ').filter(Boolean);
}
function tallyGiven(data, name) {
  return data.getAll(name).some((v) => (typeof v === 'string' ? v.trim() !== '' : v.size > 0));
}
function tallyForm(el) {
  const form = document.getElementById(el.getAttribute('data-tally'));
  return form instanceof HTMLFormElement ? form : null;
}
function tallyAll() {
  tallyQueued = false;
  const read = new Map();
  for (const el of document.querySelectorAll('[data-tally]')) {
    const form = tallyForm(el);
    if (!form) continue;
    if (!read.has(form)) read.set(form, new FormData(form));
    const data = read.get(form);
    const fields = tallyNames(el, 'data-tally-fields');
    const filled = fields.filter((n) => tallyGiven(data, n)).length;
    const left = tallyNames(el, 'data-tally-demanded').filter((n) => !tallyGiven(data, n)).length;
    el.toggleAttribute('data-tally-done', filled === fields.length);
    el.toggleAttribute('data-tally-ready', left === 0);
    const count = el.getAttribute('data-tally-count');
    if (count !== null) {
      el.textContent = count.replaceAll('{filled}', filled).replaceAll('{total}', fields.length);
    }
    const owed = el.getAttribute('data-tally-left');
    if (owed !== null) {
      el.textContent = owed.replaceAll('{left}', left);
      el.hidden = left === 0;
    }
    if (el.hasAttribute('data-tally-jump')) el.hidden = left === 0;
    if (el.hasAttribute('data-tally-bar') && el.firstElementChild) {
      el.firstElementChild.style.width = `${fields.length ? (filled * 100) / fields.length : 0}%`;
    }
  }
}
export function tallySoon() {
  if (tallyQueued) return;
  tallyQueued = true;
  requestAnimationFrame(tallyAll);
}
document.addEventListener('input', tallySoon);
document.addEventListener('change', tallySoon);
document.addEventListener('reset', () => setTimeout(tallySoon));
document.addEventListener('click', (e) => {
  const jump = e.target.closest?.('[data-tally-jump]');
  if (!jump) return;
  const form = tallyForm(jump);
  if (!form) return;
  const data = new FormData(form);
  const name = tallyNames(jump, 'data-tally-demanded').find((n) => !tallyGiven(data, n));
  if (!name) return;
  let control = form.elements.namedItem(name);
  if (control instanceof RadioNodeList) control = control[0];
  if (!control) return;
  const shown = control.type === 'hidden' ? control.parentElement : control;
  shown?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  control.focus?.({ preventScroll: true });
});
addEventListener('load', tallyAll);
afterFills.push(tallySoon);
