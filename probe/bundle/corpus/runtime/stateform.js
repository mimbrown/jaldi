// stateform: cut from progressive.js for the bundling probe (#754).
import { transition } from './core.js';
import { applyUrlState, closeSurface } from './state.js';

// The page-global state form (`data-autosubmit`, framework-rendered):
// edits are navigations, so the enhancement layer navigates for you.
// Discrete controls (radio/checkbox/select) navigate on change and push
// a history entry — each filter state is a place back can return to.
// Typing navigates debounced with `replace`, so search doesn't spam
// history. Explicit submissions (Enter, Apply, navigation buttons, edit
// buttons) are intercepted at the submit event so every path serializes
// the same way. Without JS, native submission takes an equivalent —
// uglier but identically-parsed — URL as a full request.
//
// Serialization is the browser's own (`docs/design/state.md`, "The
// state form"): every control's entries in document order, the
// submitter's where it sits — exactly what the no-JS GET sends — and the
// server, which parses it, answers with the canonical URL
// (`x-progressive-url`) that the address bar then takes. So the client
// keeps no serialization rules of its own to drift from the parse.
let searchDebounce;
function stateFormUrl(form, submitter) {
  const formaction = submitter && submitter.getAttribute('formaction');
  const url = new URL(formaction || form.action, location.href);
  url.search = new URLSearchParams(submitter ? new FormData(form, submitter) : new FormData(form));
  return url.href;
}
// An opaque flip has no response to name its canonical URL, so it tidies
// the serialization itself: empty entries dropped (the rest's radio
// submits `""`), except a set's presence marker (`data-marker`) when none
// of its boxes is ticked — its lone empty entry is the empty set.
function tidyStateUrl(href) {
  const url = new URL(href);
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (v !== '') params.append(k, v);
  for (const [k, v] of url.searchParams) if (v === '' && !params.has(k) && markerNamed(k)) params.append(k, '');
  url.search = params;
  return url.href;
}
function markerNamed(name) {
  return document.querySelector(`input[data-marker][name="${CSS.escape(name)}"]`) !== null;
}
// Controls inside an open surface — a facet's checkboxes in a menu,
// the whole filters sheet — submit once, when it closes: a submission
// re-renders the region, and replacing an open surface would close it
// under the pointer. Their changes mark it dirty; its closing — Esc,
// the backdrop, its trigger — submits. Since #338 a surface is either
// an open popover or an open dialog; the sheets are the dialogs.
// A surface may hold another (a facet's menu inside the filters
// sheet): the change waits for the outermost open one, since closing
// the inner menu leaves the sheet open over the region a submission
// would replace.
const dirtyPopovers = new WeakMap();
function isOpenSurface(s) {
  return s.matches('[popover]') ? s.matches(':popover-open') : s.open;
}
function openPopoverOf(el) {
  const surface = el.closest('[popover], dialog');
  return surface && isOpenSurface(surface) ? surface : null;
}
function outermostOpenSurfaceOf(el) {
  let found = null;
  for (let s = el.closest('[popover], dialog'); s; s = s.parentElement && s.parentElement.closest('[popover], dialog')) {
    if (isOpenSurface(s)) found = s;
  }
  return found;
}
function submitStateForm(form, from) {
  const popover = outermostOpenSurfaceOf(from);
  if (popover) {
    dirtyPopovers.set(popover, form);
    return;
  }
  clearTimeout(searchDebounce);
  navigation.navigate(stateFormUrl(form, null));
}
function submitOnClose(surface) {
  if (!dirtyPopovers.has(surface)) return;
  const form = dirtyPopovers.get(surface);
  dirtyPopovers.delete(surface);
  if (form.isConnected) navigation.navigate(stateFormUrl(form, null));
}
document.addEventListener('toggle', (e) => {
  if (e.newState === 'closed') submitOnClose(e.target);
}, true);
// A dialog's closing is its own event (`close`), and it is the sheets'
// (#338): Escape, the backdrop under `closedby="any"`, and a Done
// button all end here.
document.addEventListener('close', (e) => submitOnClose(e.target), true);
// A mirror (`dom::Mirror`, script-only): a second surface of a set's
// boxes — a facet in its column heading and in the filters sheet. Its
// boxes are nameless, so they never submit; each names the field's
// own box (`data-mirrors`), which a tick sets, then submits as that
// box's change would, deferred by the mirror's own popover.
// A radio's mirrors follow its whole group: checking one unchecks its
// siblings, and their mirrors are nameless, so no group unchecks them.
function syncMirrors(box) {
  const group = box.type === 'radio' && box.form
    ? [...box.form.elements].filter((e) => e.type === 'radio' && e.name === box.name)
    : [box];
  for (const b of group) {
    for (const m of document.querySelectorAll(`input[data-mirrors="${CSS.escape(b.id)}"]`)) m.checked = b.checked;
  }
}
document.addEventListener('change', (e) => {
  const mirror = e.target;
  if (!mirror.matches('input[data-mirrors]')) return;
  const box = document.getElementById(mirror.getAttribute('data-mirrors'));
  if (!box || !box.form || !box.form.hasAttribute('data-autosubmit')) return;
  box.checked = mirror.checked;
  syncMirrors(box);
  submitStateForm(box.form, mirror);
});
// A box write (`data-ticks` / `data-unticks`, script-only): an
// applied filter's ×, a facet's Clear, a set put back to its rest.
// Sets the named boxes and submits as their own change would —
// deferred like one when the button sits in an open popover.
document.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-ticks], button[data-unticks]');
  if (!button) return;
  let form = null;
  for (const [attr, checked] of [['data-ticks', true], ['data-unticks', false]]) {
    for (const id of (button.getAttribute(attr) || '').split(' ')) {
      const box = id && document.getElementById(id);
      if (box && box.checked !== checked) {
        box.checked = checked;
        syncMirrors(box);
        form = box.form;
      }
    }
  }
  if (form && form.hasAttribute('data-autosubmit')) submitStateForm(form, button);
});
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form.hasAttribute('data-autosubmit')) return;
  e.preventDefault();
  clearTimeout(searchDebounce);
  navigation.navigate(stateFormUrl(form, e.submitter));
});
document.addEventListener('change', (e) => {
  const form = e.target.form;
  if (!form || !form.hasAttribute('data-autosubmit')) return;
  if (e.target.matches('input[type="radio"][data-sw]')) {
    // A URL-store opaque state (`dom::State::radio`): its consequences
    // shipped ahead, so the change is answered in place — history
    // entry and URL via pushState, subscribers flipped, zero fetch.
    // The no-JS submission of the same radio (Apply) is a GET.
    const url = tidyStateUrl(stateFormUrl(form, null));
    history.pushState(null, '', url);
    transition(() => applyUrlState(url), ['state', `state-${e.target.name}`]);
    return;
  }
  // A range's ends (`dom::Span`) change on commit — blur, Enter, a
  // spinner step, a date picked — never per keystroke, so each change
  // is a submission like a box's.
  if (e.target.matches('input[type="checkbox"], input[type="radio"]')) syncMirrors(e.target);
  if (e.target.matches('input[type="radio"], input[type="checkbox"], select, input[type="number"], input[type="date"]')) {
    submitStateForm(form, e.target);
    // A radio in a popover is a one-pick menu (Halo's "By me"): the
    // pick is the whole choice, so it applies and the menu closes —
    // its closing submits, as any popover's does. Boxes stay open: a
    // facet takes several picks before its one submission (#63).
    if (e.target.matches('input[type="radio"]')) closeSurface(openPopoverOf(e.target));
  }
});
document.addEventListener('input', (e) => {
  const form = e.target.form;
  if (!form || !form.hasAttribute('data-autosubmit')) return;
  // An unnamed box sends nothing (`html::list_filter` narrows a list
  // in place): typing in it is no state change.
  if (!e.target.name) return;
  if (e.target.matches('input[type="search"], input[type="text"]')) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      navigation.navigate(stateFormUrl(form, null), { history: 'replace' });
    }, 300);
  }
});
