// core: cut from progressive.js for the bundling probe (#754).

// The script is live: the framework's rules hide a state form's no-JS
// Apply (`data-apply`) and show its script-only controls
// (`data-script-only`) under this stamp (`dom::style::SHIM_RULES`).
document.documentElement.setAttribute('data-shim', '');
export const HEADER = 'x-progressive';
export const PREFS_HEADER = 'x-progressive-prefs';
export const WINDOW_HEADER = 'x-progressive-window';
export const URL_HEADER = 'x-progressive-url';
export const LIVE_HEADER = 'x-progressive-live';
export const READS_HEADER = 'x-progressive-reads';
export const XACT_HEADER = 'x-progressive-xact';
export const REFUSAL_HEADER = 'x-progressive-refusal';
const NAME = /name="([^"]*)"/;
// The mounted-state claim, pref tier (`docs/design/state.md`): the pref values THIS
// document was rendered with. The ambient Cookie header carries the jar
// *now* — another tab may have moved it since — so every progressive
// request states its own from-side explicitly. Kept current at the
// three points the mounted state actually changes: initial render,
// a state flip (ours or another tab's), and an applied fills/full
// response (whose to-side is the then-current jar).
function readPrefCookies() {
  const prefs = {};
  for (const pair of document.cookie.split(';')) {
    const [name, value] = pair.split('=').map((s) => s.trim());
    // First match wins — pinned, mirroring the server's PrefJar:
    // path-scoped cookies mean a stale broader-path twin can share the
    // name, the cookie string carries no path info, and the browser
    // orders longest-path first, so first = most specific.
    if (name && name.startsWith('__state_') && !(name.slice(8) in prefs)) {
      prefs[name.slice(8)] = value;
    }
  }
  return prefs;
}
export let mountedPrefs = readPrefCookies();
export function prefsClaim() {
  return Object.entries(mountedPrefs).map(([k, v]) => `${k}=${v}`).join('&');
}
// Apply the native after-transition behaviors, or don't — decided per
// response, after the DOM settled (traverse restoration needs the final
// document height). `chromeReplaced` is the server's verdict ("swap" or
// a full document) — a "diff" response keeps scroll and focus where the
// user left them.
export function settleNavigation(event, chromeReplaced) {
  const fragment = new URL(event.destination.url).hash !== '';
  if (event.navigationType !== 'traverse' && !fragment && !chromeReplaced) {
    return;
  }
  event.scroll();
  // Emulate the native focus reset (focusReset is 'manual' for the
  // diff case's sake, and there is no event.focus() to trigger late):
  // the autofocus element if any, else let focus fall to the body.
  // A closed dialog's `autofocus` is its own scope's, for when it opens.
  const auto = document.querySelector('[autofocus]:not(dialog:not([open]) *)');
  if (auto) {
    auto.focus();
  } else if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
}
// The form a submission came from: the submitter's owner, or the form
// named by the discriminant when the submitter is not exposed.
export function submittedForm(event) {
  const el = event.sourceElement;
  if (el && el.form) return el.form;
  if (el && el.tagName === 'FORM') return el;
  const action = event.formData && event.formData.get('__form');
  if (!action) return null;
  for (const f of document.querySelectorAll('form[method="post"]')) {
    const disc = f.querySelector('input[name="__form"]');
    if (disc && disc.value === action) return f;
  }
  return null;
}
// A form's message places: each control's `aria-errormessage` target
// and the form's own (`data-refusal`). The server fills them; what is
// derived from their content — `aria-invalid`, where focus lands —
// is decided here, once, for every form (docs/design/forms.md).
function messagePlaces(form) {
  const places = [];
  if (!form) return places;
  const id = form.id;
  const controls = id
    ? document.querySelectorAll(`[form="${CSS.escape(id)}"][aria-errormessage]`)
    : form.querySelectorAll('[aria-errormessage]');
  for (const c of controls) {
    const place = document.getElementById(c.getAttribute('aria-errormessage'));
    if (place) places.push({ control: c, place });
  }
  return places;
}
function formPlaces(form) {
  // The form's own places: the unkeyed one, and — for a form whose
  // bind rides the button — one per button, all under its base id.
  const base = form && form.getAttribute('data-refusal');
  if (!base) return [];
  return [...document.querySelectorAll('[data-refusal-place]')]
    .filter((p) => p.id === base || p.id.startsWith(base + '-'));
}
function hasText(el) {
  return el.textContent.trim().length > 0;
}
// After a refusal's fills: mark the controls whose places now hold a
// message, and land focus on the first — or on the form's own message
// when no field is at fault — so the person hears what to fix.
export function settleRefusal(form) {
  let first = null;
  for (const { control, place } of messagePlaces(form)) {
    if (hasText(place)) {
      control.setAttribute('aria-invalid', 'true');
      if (!first) first = control;
    } else {
      control.removeAttribute('aria-invalid');
    }
  }
  if (!first) {
    first = formPlaces(form).find(hasText) || null;
  }
  if (first) first.focus();
}
// After a successful action: nothing the form said before still holds.
export function clearRefusal(form) {
  for (const { control, place } of messagePlaces(form)) {
    control.removeAttribute('aria-invalid');
    emptyPlace(place);
  }
  for (const place of formPlaces(form)) emptyPlace(place);
}
// A write went through: say so to whatever sent state with it — the
// selection pattern empties the set it added (docs/adr/0005). On the
// document, since a Stay may have replaced the form itself; `form` is
// the element that was submitted, for identity.
export function accepted(form) {
  if (form) document.dispatchEvent(new CustomEvent('accepted', { detail: { form } }));
}
// A write did not go through: refused, or never answered (the network,
// or a navigation that superseded it). Said to whatever acted ahead of
// the answer — a drop already shown (`pattern/drag-pick`) goes back.
export function unaccepted(form) {
  if (form) document.dispatchEvent(new CustomEvent('refused', { detail: { form } }));
}
function emptyPlace(place) {
  // Keep the range markers, drop what sits between them.
  for (const n of [...place.childNodes]) {
    if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) continue;
    place.removeChild(n);
  }
}
// The submit in flight (docs/design/forms.md): from the navigate event
// to its settlement every submitter of the form is disabled — the one
// that fired and its siblings, wherever they render (`form.elements`
// includes the `form=`-associated ones) — so a second click cannot
// post twice, and the form says it is busy. A submitter that declared
// a busy label (`data-busy`, `Submit::busy`) shows it meanwhile. The
// returned release undoes all of it and rescues focus: a button
// disabled under focus drops it to the body in some engines, and the
// person was on that button.
export function holdSubmitters(form, submitter) {
  if (!form) return () => {};
  const held = [];
  for (const el of form.elements) {
    const isSubmitter = el.matches('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]');
    if (!isSubmitter || el.disabled) continue;
    const idle = el.getAttribute('data-busy') !== null ? [...el.childNodes] : null;
    if (idle) el.replaceChildren(el.getAttribute('data-busy'));
    el.disabled = true;
    held.push({ el, idle });
  }
  const hadForm = form.getAttribute('aria-busy');
  form.setAttribute('aria-busy', 'true');
  return () => {
    for (const { el, idle } of held) {
      el.disabled = false;
      if (idle) el.replaceChildren(...idle);
    }
    if (hadForm === null) form.removeAttribute('aria-busy');
    else form.setAttribute('aria-busy', hadForm);
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focusLost && submitter && submitter.isConnected && !submitter.disabled) submitter.focus();
  };
}
// The element that fired a submission: the submitter button when the
// event exposes it, else the focused submitter (an implicit submit
// from a text field names the form's default button either way).
export function submitterOf(event, form) {
  const el = event.sourceElement;
  if (el && el.form === form && el.tagName !== 'FORM') return el;
  const active = document.activeElement;
  if (active && active.form === form && active.matches('button, input[type="submit"]')) return active;
  return null;
}
function findStart(name) {
  const w = document.createTreeWalker(
    document.documentElement, NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.target === 'start' && (NAME.exec(n.data) || [])[1] === name) return n;
  }
  return null;
}
// Replace the <?start name>…<?end> range (inclusive) with `fragment`.
// The fragment re-arms its own range, mirroring the parser's native
// replace-and-rearm semantics (verified against Chrome 150).
function applyFill(name, fragment) {
  const start = findStart(name);
  if (!start) return false;
  // A fill that carries a row's record instead of its markup
  // (`docs/design/templates.md`, "Rows as data"): the row already in
  // the range is updated in place, its element kept, and the range
  // stays. Only when the range holds no such row is the island landed
  // as markup, which makes the row afresh.
  const island = patchIsland(fragment);
  if (island && window.lazyTemplates && window.lazyTemplates.patchInRange(start, island)) return true;
  const parent = start.parentNode;
  const doomed = [];
  let depth = 0;
  for (let n = start; n; n = n.nextSibling) {
    doomed.push(n);
    if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      if (n.target === 'start') depth += 1;
      if (n.target === 'end') { depth -= 1; if (depth === 0) break; }
    }
  }
  const anchor = doomed[doomed.length - 1].nextSibling;
  for (const n of doomed) parent.removeChild(n);
  // A carried range whose name is still mounted elsewhere would break
  // addressing — range names are structural ids, unique by construction.
  // With the doomed range gone, any surviving holder is a genuine
  // duplicate (concurrent structural drift moved an item across
  // windows); the incoming copy is dropped, the mounted one wins. For
  // ordinary fills every carried name was just removed with the doomed
  // range, so this finds nothing and costs one fragment walk.
  const w = document.createTreeWalker(fragment, NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  const starts = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.target === 'start') starts.push(n);
  }
  for (const s of starts) {
    if (s.getRootNode() !== fragment) continue; // inside an already-dropped range
    const dupe = (NAME.exec(s.data) || [])[1];
    if (!dupe || !findStart(dupe)) continue;
    let depth = 0;
    const drop = [];
    for (let n = s; n; n = n.nextSibling) {
      drop.push(n);
      if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
        if (n.target === 'start') depth += 1;
        if (n.target === 'end') { depth -= 1; if (depth === 0) break; }
      }
    }
    for (const n of drop) n.parentNode.removeChild(n);
  }
  parent.insertBefore(fragment, anchor);
  return true;
}
// The one element of a fill, when it is a patch island; null otherwise.
function patchIsland(fragment) {
  let island = null;
  for (const n of fragment.childNodes) {
    if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) continue;
    if (n.nodeType === Node.TEXT_NODE && !n.data.trim()) continue;
    if (n.nodeType === 1 && n.matches('script[data-lt-rows][data-lt-landing="patch"]') && island === null) { island = n; continue; }
    return null;
  }
  return island;
}
// The document's title follows the range that names the page
// (`#[slot(names_document)]`): the server writes "{page} · {app}" on a
// full load and marks the <title> with the range (`data-names`) and the
// app's name (`data-app`); after a swap, the same text is re-derived
// from the live range — its text content, whitespace collapsed, as
// the server does. The page name's copies follow it too.
function retitle() {
  const title = document.querySelector('title[data-names]');
  if (!title) return;
  const start = findStart(title.dataset.names);
  if (!start) return;
  let text = '';
  let depth = 0;
  for (let n = start.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      if (n.target === 'start') depth += 1;
      if (n.target === 'end') { if (depth === 0) break; depth -= 1; }
      continue;
    }
    text += n.textContent;
  }
  text = text.replace(/\s+/g, ' ').trim();
  const app = title.dataset.app;
  document.title = text ? text + ' \u00b7 ' + app : app;
  // The page name's copies in the chrome (`dom::html::page_name`),
  // which the server fills on a full load the same way.
  for (const copy of document.querySelectorAll('[data-page-name]')) copy.textContent = text;
}
// Every state change the shim applies is a view transition — typed, so
// the page's CSS can choreograph per kind (`:active-view-transition-type`):
// `navigation` / `action` for fills, `state` + `state-{name}` for a
// state flip. Named elements (a sidebar rail, a current-item pill) get
// their old→new morph from the platform; unnamed content crossfades.
// Reduced motion is the page's own CSS's job (`::view-transition-*`
// under the media query); a browser without the API — or without typed
// transitions — applies directly, or untyped. Resolves once the update
// has been applied: anything that must read the post-change DOM (focus
// rescue) waits on it, because the update runs after the old-state
// capture, not synchronously.
const TYPED_TRANSITIONS =
  typeof ViewTransition !== 'undefined' && 'types' in ViewTransition.prototype;
// The transition most recently started here, for work that must wait
// for it to finish (a morph's names come off then).
let currentTransition = null;
export function transition(update, types) {
  if (!document.startViewTransition) {
    update();
    return Promise.resolve();
  }
  const vt = TYPED_TRANSITIONS
    ? document.startViewTransition({ update, types })
    : document.startViewTransition(update);
  currentTransition = vt;
  return vt.updateCallbackDone;
}
export function transitionFinished() {
  return currentTransition ? currentTransition.finished.catch(() => {}) : Promise.resolve();
}
// Morphs (`dom::Morph`, `docs/design/naming.md`): a view-transition
// name shared across pages, keyed by the thing both ends present. A
// target bears its name statically (`data-morph-target`, live for
// navigations); a source (`data-morph`) bears none at rest — a list
// has one per row — and is named here, when the link it sits in is
// activated, before the old capture. A link's reach is its subject
// (`data-morph-subject`, the nearest ancestor presenting one thing —
// a table row): every source inside the subject goes with any link
// inside it, so a row's role badge follows its name link. The way
// back is the same rule
// read off the document being left: once the fills land, any source
// whose name a target bore in the old document is named for the new
// capture. Every name set here comes off when the transition
// finishes, or when the navigation is abandoned. A cross-document
// continuation (a redirect followed with `location.href`) keeps the
// activated names through `pageswap`, so the forward morph survives
// it; the way back does not (the old document's targets are not
// knowable from the new one), and crossfades.
export function morphing(source) {
  const link = source && source.closest ? source.closest('a[href]') : null;
  const reach = link ? link.closest('[data-morph-subject]') || link : null;
  const activated = reach
    ? [...(reach.matches('[data-morph]') ? [reach] : []), ...reach.querySelectorAll('[data-morph]')]
    : [];
  const leaving = new Set(
    [...document.querySelectorAll('[data-morph-target]')].map((el) => el.dataset.morphTarget),
  );
  const named = [];
  const name = (el) => {
    el.style.viewTransitionName = el.dataset.morph;
    named.push(el);
  };
  for (const el of activated) name(el);
  return {
    // Inside the update, after the fills: the way back.
    land() {
      for (const el of document.querySelectorAll('[data-morph]')) {
        if (leaving.has(el.dataset.morph)) name(el);
      }
    },
    release() {
      for (const el of named) el.style.viewTransitionName = '';
      named.length = 0;
    },
  };
}
// Apply a fills-only body. `types` is demanded at every call site:
// navigation and action fills apply inside a typed view transition —
// range replacement is destructive (no morphing), so the platform
// supplies the morph; scroll continuations pass `null`: they append
// rows at the viewport's edge, and snapshotting the whole document for
// that would queue jank under fast scrolling. `andThen` runs inside the
// same update, after the fills land — a URL-state re-derivation must
// change the DOM in the transition's update, not before its capture.
// Resolves to whether every fill found its range: a fill addressed to
// a marker this document does not hold means the server's picture of
// what is mounted was wrong, and the caller must not commit a URL the
// page does not show (`landed` false → a full navigation instead).
// What a feature module does after every applied response (probe: the
// shim calls these four directly; registering them is what lets an app's
// entry leave a feature out).
export const afterFills = [];
export function applyFills(text, types, andThen) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  let landed = true;
  const apply = () => {
    for (const t of doc.querySelectorAll('template[for]')) {
      if (!applyFill(t.getAttribute('for'), document.adoptNode(t.content))) landed = false;
    }
    retitle();
    for (const hook of afterFills) hook();
    if (andThen) andThen();
  };
  const done = types ? transition(apply, types) : (apply(), Promise.resolve());
  // The applied response rendered from the then-current jar: that is
  // the mounted state now.
  mountedPrefs = readPrefCookies();
  return done.then(() => landed);
}
