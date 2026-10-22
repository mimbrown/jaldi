// state: cut from progressive.js for the bundling probe (#754).
import { mountedPrefs, transition } from './core.js';

// The state tree (`dom::state`): a write whose button declares
// `data-sw` is answered here, not by the server — the style matches
// already shipped every state's CSS, so the flip is a store write
// plus one patch per subscriber, zero network. The dispatch is the
// *declaration*, never subscriber discovery: a state write with no
// subscribers is a bug manifest::check catches, not a silent demotion to
// a round trip. The wire is exactly the no-JS wire read back off the
// DOM: the submitter's name/value pair IS the declared write, and the
// cookie format is the server's own (prefs are taste, never
// authority — the cookie is deliberately not HttpOnly). Unwrapped-kind
// buttons carry no marker and fall through to the stage-3 POST below.
//
// Flip one state everywhere it subscribes. Identity is the name:
// every subscriber carries `data-sn-{name}`, whose value is its patch
// list — the slots (`data-s-{slot}`, what the style matches key on)
// to write the token into, and `value` for a control whose own value
// follows the state. Attribute tables (`attr_match!`) ride beside it
// as `data-sa-{name}`: re-stamp the new variant's row.
function applyState(name, value) {
  for (const el of subscribers(document, name)) patchSubscriber(el, name, value);
  // The document root's face (`data-pref-{name}`, stamped by the
  // envelope): the token sheet's mode and scheme axes key on it, and
  // so may any `:root[…]`-scoped rule. Flipped only where stamped —
  // the server declared which prefs the root carries.
  const root = document.documentElement;
  const rootAttr = `data-pref-${name}`;
  if (root.hasAttribute(rootAttr)) root.setAttribute(rootAttr, value);
}
function subscribers(within, name) {
  const sn = `data-sn-${name}`;
  const found = [...within.querySelectorAll(`[${CSS.escape(sn)}]`)];
  if (within !== document && within.hasAttribute(sn)) found.unshift(within);
  return found;
}
function patchSubscriber(el, name, value) {
  const sn = `data-sn-${name}`;
  for (const slot of (el.getAttribute(sn) || '').split(' ')) {
    if (slot === '') continue;
    if (slot === 'value') el.value = value;
    else el.setAttribute(`data-s-${slot}`, value);
  }
  // A choice button (`StateButton::Choice`) is pressed while the
  // state holds its value: the verdict is the button's own write
  // against the new token, the comparison the server stamped.
  if (el.hasAttribute('data-sw') && el.hasAttribute('aria-pressed') && el.name === name) {
    el.setAttribute('aria-pressed', String(el.value === value));
  }
  // A row's `null` is a boolean attribute the state leaves off.
  const table = el.getAttribute(`data-sa-${name}`);
  if (table) {
    const row = JSON.parse(table)[value];
    if (row) for (const k in row) {
      if (row[k] === null) el.removeAttribute(k); else el.setAttribute(k, row[k]);
    }
  }
}
// A local-store state is an enhancement's (`docs/design/enhancements.md`,
// "Items"): named `{enhancement}-…`, it lives in the root that holds
// it and is applied there alone — two chip fields on one page flip
// their own subscribers — with the same subscription grammar the
// other stores use, so `state_match!` and `attr_match!` need no
// second wire. Nested enhancement roots are theirs, not this one's.
export function applyLocalState(root, name, value) {
  for (const el of subscribers(root, name)) {
    if (el.closest('[data-enhancement]') !== root) continue;
    patchSubscriber(el, name, value);
  }
}
// Re-derive every URL-store state from a URL: the state form's radio
// groups are the declaration (`dom::State::radio`: name + `data-absent`
// for a URL without the param). Back/forward re-checks the radio the
// URL names, then flips the subscribers once per group.
export function applyUrlState(url) {
  const params = new URL(url, location.href).searchParams;
  const seen = new Set();
  for (const input of document.querySelectorAll('input[type="radio"][data-absent]')) {
    const name = input.name;
    const absent = input.getAttribute('data-absent');
    const value = params.get(name) || absent;
    input.checked = (input.value || absent) === value;
    if (seen.has(name)) continue;
    seen.add(name);
    applyState(name, value);
  }
  applyCurrent(url);
}
// Whether a URL names a page other than the mounted one: a different
// path, or a different query once the URL-store states — the ones
// `applyUrlState` derives in place — are set aside. Entries are
// compared as sorted pairs, so only a change of what the server
// parses counts, not the order it was spelled in. In doubt, a fetch:
// a round trip too many shows the right page, one too few a stale one.
export function rendersElsewhere(url) {
  const there = new URL(url, location.href);
  const here = new URL(location.href);
  if (there.pathname !== here.pathname) return true;
  const local = new Set();
  for (const input of document.querySelectorAll('input[type="radio"][data-absent]')) local.add(input.name);
  const rest = (u) => [...u.searchParams]
    .filter(([k]) => !local.has(k))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  return rest(there) !== rest(here);
}
// Current links (`dom::Here`): the server stamped each marked link's
// rule as `data-current` and its verdict as `aria-current` for the
// path it rendered at. A navigation that left the link's region
// frozen (its declared inputs did not change) leaves that verdict
// stale, so it is re-derived here from the destination path — the
// same two rules the server applies (`dom::here`): `exact` is the
// path itself (`page`); `within` is the path itself (`page`) or a
// descendant, segment-wise (`true`). Query and fragment are not the
// place. Runs inside the navigation's view transition (via
// `applyUrlState`), so a row's pill morphs with the verdict.
function samePath(p) {
  const t = p.replace(/\/+$/, '');
  return t === '' ? '/' : t;
}
function applyCurrent(url) {
  const here = samePath(new URL(url, location.href).pathname);
  for (const a of document.querySelectorAll('a[data-current]')) {
    const href = a.getAttribute('href') || '';
    let value = null;
    if (href.startsWith('/')) {
      const link = samePath(href.split(/[?#]/)[0]);
      if (here === link) {
        value = 'page';
      } else if (a.getAttribute('data-current') === 'within' && here.startsWith(link + '/')) {
        value = 'true';
      }
    }
    if (value) a.setAttribute('aria-current', value); else a.removeAttribute('aria-current');
  }
}
// A state flip is one typed view transition (`state`, `state-{name}`).
function flipState(name, value) {
  return transition(() => applyState(name, value), ['state', `state-${name}`]);
}
// A cookie-store flip. Idempotent by value: our own cookie write
// echoes back through the Cookie Store listener below, and a second
// transition for the same value would skip the first mid-flight.
function applyPref(name, value) {
  if (mountedPrefs[name] === value) return Promise.resolve();
  mountedPrefs[name] = value;
  return flipState(name, value);
}
document.addEventListener('submit', (e) => {
  const action = e.target.elements.namedItem('__form');
  if (!action || action.value !== '__pref') return;
  const s = e.submitter;
  if (!s || !s.name || !s.hasAttribute('data-sw')) return;
  // The cookie's Path is the field's declared scope — the pref form
  // ships the chain's field → path map (`data-pref-paths`, derived
  // server-side from the declaring layout's mount), and the client
  // write must land at the same Path the server's Set-Cookie would,
  // or the two faces would mint sibling cookies that shadow each
  // other. A field absent from the map is a declaration we don't
  // have: fall through to the POST, where the server knows.
  const path = JSON.parse(e.target.getAttribute('data-pref-paths') || '{}')[s.name];
  if (path === undefined) return;
  e.preventDefault();
  document.cookie =
    `__state_${s.name}=${s.value}; path=${path}; max-age=31536000; samesite=lax`;
  dismissFor(s);
  applyPref(s.name, s.value).then(() => {
    // Focus rescue: a per-state twin button that hid itself in the flip
    // (display: none drops it from the tab order) hands focus to the
    // visible button writing the same state. After the flip landed —
    // the transition applies it a frame later.
    if (s.offsetParent === null) {
      const twin = [...document.querySelectorAll(
        `button[name="${CSS.escape(s.name)}"]`)].find(
        (b) => b.offsetParent !== null);
      if (twin) twin.focus();
    }
  });
});
// A local-store write: `type="button"` carrying the name/value pair
// and the marker — no form, no server, no no-JS path. The flip is the
// whole write.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[type="button"][data-sw]');
  if (b && b.name) {
    dismissFor(b);
    flipState(b.name, b.value);
  }
});
// A write made from inside a popover or a dialog dismisses it
// (`El::dismisses`, `data-dismiss`): the no-JS path's reload closes
// every surface, and this is the same outcome without the reload.
// Hidden before the flip's transition starts, so the panel is in
// neither snapshot. Since #338 the sheets are modal dialogs, which
// close with `close()` rather than `hidePopover()`.
function dismissFor(button) {
  const id = button.getAttribute('data-dismiss');
  if (!id) return;
  closeSurface(document.getElementById(id));
}
// Close whichever kind of surface this is, if it is open.
export function closeSurface(el) {
  if (!el) return;
  if (el.matches('[popover]')) {
    if (el.matches(':popover-open')) el.hidePopover();
  } else if (el.matches('dialog') && el.open) {
    el.close();
  }
}
// Cross-tab sync, for free from the platform: the cookie jar is
// browser-global, so another tab's state flip lands here as a Cookie
// Store change — apply it to this tab's subscribers. (Our own writes
// also echo through this listener; `applyPref` is idempotent by
// value, so the echo starts no second transition.)
if ('cookieStore' in window) {
  cookieStore.addEventListener('change', (e) => {
    for (const c of e.changed) {
      if (c.name.startsWith('__state_')) applyPref(c.name.slice(8), c.value);
    }
  });
}
