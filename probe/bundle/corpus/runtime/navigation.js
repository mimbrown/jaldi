// navigation: cut from progressive.js for the bundling probe (#754).
import { applyUrlState, rendersElsewhere } from './state.js';
import { HEADER, PREFS_HEADER, REFUSAL_HEADER, URL_HEADER, accepted, applyFills, clearRefusal, holdSubmitters, morphing, prefsClaim, settleNavigation, settleRefusal, submittedForm, submitterOf, transitionFinished, unaccepted } from './core.js';
import { bumpPosting, clearPageReads, noteOwnXact, noteReads } from './live.js';

// A sideways scroll of the document (the wide listing,
// `docs/design/scroll.md`) closes every open menu: a menu hangs from
// its trigger, and a trigger in a heading slides under the held name
// column and the rail, taking the menu over them (#66). Closing is a
// light dismiss like any other, so a facet's ticked boxes submit.
let panX = scrollX;
addEventListener('scroll', () => {
  if (scrollX === panX) return;
  panX = scrollX;
  for (const menu of document.querySelectorAll('[popover]:popover-open')) {
    if (menu.popover === 'auto') menu.hidePopover();
  }
}, { passive: true });
// Light dismiss for a dialog, where the platform has no `closedby`
// (#338). `closedby="any"` is Chrome's and the sheets declare it; a
// browser that does not know the attribute drops it, and this stands
// in: a click whose target is the dialog element *itself* landed on
// its backdrop — a click inside lands on a descendant — so the
// dialog closes, exactly as the attribute would close it.
const CLOSEDBY_IS_NATIVE = 'closedBy' in HTMLDialogElement.prototype;
document.addEventListener('click', (e) => {
  if (CLOSEDBY_IS_NATIVE) return;
  const dialog = e.target;
  if (dialog instanceof HTMLDialogElement && dialog.open && dialog.getAttribute('closedby') === 'any') dialog.close();
});
// The ids of the popovers and dialogs open now, and the focused
// element's, for `reopenSurfaces` after a pref write's fills.
function openSurfaces() {
  const open = [...document.querySelectorAll('[popover]:popover-open[id], dialog[open][id]')]
    .map((el) => ({ id: el.id, modal: el.matches('dialog:modal') }));
  const focused = document.activeElement && document.activeElement.id;
  return focused ? [...open, { id: focused, focus: true }] : open;
}
function reopenSurfaces(surfaces) {
  for (const s of surfaces) {
    const el = document.getElementById(s.id);
    if (!el) continue;
    if (s.focus) el.focus({ preventScroll: true });
    else if (el.matches('[popover]') && !el.matches(':popover-open')) el.showPopover();
    else if (el.matches('dialog') && !el.open) s.modal ? el.showModal() : el.show();
  }
}
// A chooser's download form (`dom::Chooser::download`, `data-download`)
// answers a file, not a page: its navigation is the browser's, which
// saves the attachment and keeps this document as it is. The submit
// event marks the endpoint the navigation it plans will go to (a GET
// form's navigation is queued, not immediate); the next navigation
// takes the mark, and is left alone when it goes there.
let downloading = null;
document.addEventListener('submit', (e) => {
  if (e.defaultPrevented || !e.target.hasAttribute('data-download')) return;
  downloading = new URL(e.target.action, location.href).pathname;
});
// A document loaded whole (`loadWhole`): the shim decided the page
// must come from the server as a document, so the navigation it starts
// is the browser's. Without the mark the listener below would take it
// back as a fill fetch — the fallback for a fill that missed its range
// would miss again, and again, never loading anything.
let wholly = null;
function loadWhole(url) {
  wholly = new URL(url, location.href).href;
  location.href = wholly;
}
navigation.addEventListener('navigate', (event) => {
  if (!event.canIntercept || event.hashChange || event.downloadRequest !== null) {
    return;
  }
  const whole = wholly;
  wholly = null;
  if (whole !== null && event.destination.url === whole) return;
  // A reload asks for the page afresh: the browser's, whole. Taken as
  // fills, its claim (`from`) would be the very URL it reloads, and the
  // server, believing the page current, would answer nothing new.
  if (event.navigationType === 'reload') return;
  const download = downloading;
  downloading = null;
  if (download !== null && new URL(event.destination.url).pathname === download) return;
  if (event.destination.sameDocument && !(event.navigationType === 'traverse' && rendersElsewhere(event.destination.url))) {
    // A pushState commit (our own URL-state write) or a
    // same-document traversal across state entries (back/forward
    // between two URLs this page already shows): never a fetch.
    // Subscribers re-derive from the destination URL — total
    // consequences make traversal a selection too (`docs/design/state.md`).
    applyUrlState(event.destination.url);
    return;
  }
  // Every page this shim fetched is a same-document entry too — the
  // intercept below commits it in this document — so back and forward
  // across them arrive here as same-document traversals, and one whose
  // URL differs from the mounted page in more than URL-store state is
  // a page to fetch, exactly as following a link to it was.
  // A link followed out of a dialog (a menu of places — the shell's
  // Create menu): the page under it is about to change, so the overlay
  // goes, as it would with the document it sat on. Only for a link: a
  // control in a sheet that submits the state form keeps its sheet.
  const via = event.sourceElement;
  if (via && via.matches && via.matches('a[href]')) {
    const over = via.closest('dialog[open]');
    if (over) over.close();
  }
  if (event.formData) {
    // Stage 3: a POST action form — framework-minted (method=post, no
    // action attribute → the page's own URL, hidden __form
    // discriminant). GET submissions (the state form) never carry
    // formData on the navigate event, so this branch is exactly the
    // mutation face.
    const from = location.href;
    // Read before the intercept runs: the submitter is what the event
    // exposes now, and its form is held from here to the settlement.
    const form = submittedForm(event);
    const release = holdSubmitters(form, submitterOf(event, form));
    // Posted away from the form (a drop, `data-posted-aside`, set by
    // the pattern for this one submission): a refusal's words go to the
    // page notice, since the form's places are not where anyone looks.
    const aside = !!form && form.hasAttribute('data-posted-aside');
    if (aside) form.removeAttribute('data-posted-aside');
    // A pref write (`kind = unwrapped`) refills the regions that read
    // the pref, and a surface open over them — a column customizer —
    // would be replaced closed under the pointer. The write is taste,
    // not an act to confirm, so what was open opens again when its
    // replacement carries the same id.
    const reopen = form && form.id === 'pref-form' ? openSurfaces() : [];
    event.intercept({
      scroll: 'manual',
      focusReset: 'manual',
      async handler() {
        let res;
        bumpPosting(1);
        try {
          res = await fetch(event.destination.url, {
            method: 'POST',
            // The encoding a native submission of this form would use:
            // urlencoded, unless the form declares a file field and so
            // carries `enctype="multipart/form-data"` — then the
            // FormData itself, which fetch sends as multipart with
            // the files in it.
            body: form && form.enctype === 'multipart/form-data' ? event.formData : new URLSearchParams(event.formData),
            headers: { [HEADER]: '1', 'x-progressive-from': from, [PREFS_HEADER]: prefsClaim(), ...(aside ? { [REFUSAL_HEADER]: 'notice' } : {}) },
            signal: event.signal,
          });
        } catch (e) {
          // Superseded (the signal) or the network failed: the form is
          // the person's again either way.
          bumpPosting(-1);
          release();
          unaccepted(form);
          throw e;
        }
        bumpPosting(-1);
        noteOwnXact(res);
        if (res.redirected) {
          // A Go outcome (create-then-view) or an auth bounce: commit a
          // full navigation to the final URL so the address bar and
          // document are both honest. (A Stay never redirects here —
          // the server answers fills when the protocol header rides.)
          // The hold stays: the document is leaving.
          accepted(form);
          loadWhole(res.url);
          return;
        }
        if (res.headers.has(HEADER)) {
          if (res.ok) noteReads(res);
          // The server spoke the protocol: fills only. Stay (2xx): the
          // page re-rendered post-write; "diff" keeps scroll and focus
          // where the user left them. Refuse (4xx/5xx): only the
          // refused form's message places, so the page and the typed
          // input stay put (docs/design/forms.md).
          if (!(await applyFills(await res.text(), ['submit']))) {
            // A fill missed its range: the document is not what the
            // server believed. Load the page whole rather than show
            // a stale one under a fresh URL.
            loadWhole(event.destination.url);
            return;
          }
          // Released before the settlement decides focus: the rescue
          // puts it back on the submitter, and a refusal then moves it
          // to the first fault.
          release();
          reopenSurfaces(reopen);
          if (res.ok) {
            clearRefusal(form);
            accepted(form);
            settleNavigation(event, res.headers.get(HEADER) !== 'diff');
          } else if (aside) {
            // Said in the notice: focus stays where the person is.
            unaccepted(form);
          } else {
            settleRefusal(form);
            unaccepted(form);
          }
        } else if (res.ok) {
          // Server didn't speak the protocol: full document.
          clearPageReads();
          document.open();
          document.write(await res.text());
          document.close();
          settleNavigation(event, true);
        } else {
          // Not a refusal: a forged or stale wire's diagnostic, or
          // worse. The document is not what the server believed; load
          // it whole rather than sit on a page that cannot be trusted.
          loadWhole(event.destination.url);
        }
      },
    });
    return;
  }
  // The mounted document's URL, captured before the navigation commits:
  // the server diffs it against the destination to compute the minimal
  // update (a claim about what this client shows — the server treats it
  // as untrusted).
  const from = location.href;
  // The activated link's morph sources take their names now, before
  // the old capture; an abandoned navigation gives them back.
  const morph = morphing(event.sourceElement);
  event.signal.addEventListener('abort', () => morph.release());
  event.intercept({
    // Manual, both: whether the native behaviors are right depends on
    // the response kind, which isn't known until it arrives.
    scroll: 'manual',
    focusReset: 'manual',
    async handler() {
      const res = await fetch(event.destination.url, {
        method: 'GET',
        headers: { [HEADER]: '1', 'x-progressive-from': from, [PREFS_HEADER]: prefsClaim() },
        signal: event.signal,
      });
      if (res.redirected) {
        // A session action or an auth bounce: commit a full navigation to
        // the final URL so the address bar and document are both honest.
        loadWhole(res.url);
        return;
      }
      if (res.ok && res.headers.has(HEADER)) {
        noteReads(res);
        // Normal case: fills only, applied surgically. URL-tier
        // URL states re-derive from the destination afterwards —
        // fills may not have touched mounted chrome that subscribes.
        const landed = await applyFills(await res.text(), ['navigation'], () => {
          applyUrlState(event.destination.url);
          morph.land();
        });
        transitionFinished().then(() => morph.release());
        if (!landed) {
          // A fill missed its range: the document is not what the
          // server believed it to be. Load the destination whole
          // rather than commit a URL the page does not show.
          loadWhole(event.destination.url);
          return;
        }
        settleNavigation(event, res.headers.get(HEADER) !== 'diff');
        // The server's spelling of where this landed: a native
        // serialization of the state form (a set's rest spelled out,
        // empty fields) parses the same but reads worse. Taken once the
        // navigation has finished, so the replace starts no second one.
        const canonical = res.headers.get(URL_HEADER);
        if (canonical) {
          const href = new URL(canonical, location.href).href;
          navigation.transition?.finished.then(() => {
            if (location.href !== href) history.replaceState(history.state, '', href);
          }, () => {});
        }
      } else if (res.ok) {
        // Server didn't speak the protocol: full document, replace the DOM.
        clearPageReads();
        document.open();
        document.write(await res.text());
        document.close();
        settleNavigation(event, true);
      } else {
        // TODO(stage 3+): on error, keep the mounted page and show the
        // failure in place (retry-able, history untouched); on a
        // redirect, follow it through the interceptor so the destination
        // is fetched as fills rather than a full document (the earlier
        // sketch: `docs/archive/tandem-era/progressive-enhancement.ts`).
        // For now surface the failure plainly.
        document.body.textContent = `navigation failed: ${res.status}`;
      }
    },
  });
});
