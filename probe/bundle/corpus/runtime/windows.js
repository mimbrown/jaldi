// windows: cut from progressive.js for the bundling probe (#754).
import { HEADER, PREFS_HEADER, WINDOW_HEADER, afterFills, applyFills, prefsClaim } from './core.js';

// Infinite scroll: a scroll-windowed shell's tail sentinel is a plain
// next-page link carrying its continuation claim (`data-window-more` =
// the region's range base, `data-window-after` = the last mounted item
// key). Enhanced, the link is observed; nearing the viewport fetches
// the SAME url with the claim in x-progressive-window, and the response
// is one sentinel fill — the next window's item ranges plus a re-armed
// deeper sentinel, so applying it *is* appending. A failed fetch leaves
// the link in place: clicking it is the explicit-pages face.
const moreObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    continueWindow(entry.target);
  }
}, { rootMargin: '200px' });
export function observeSentinels() {
  for (const a of document.querySelectorAll('a[data-window-more]')) {
    moreObserver.observe(a);
  }
}
// A sentinel continues once, whoever asks first: the observer, or a
// pattern that wants the next rows now (`continue-window`, below).
const continuing = new WeakMap();
function continueWindow(a) {
  let pending = continuing.get(a);
  if (!pending) {
    moreObserver.unobserve(a);
    pending = fetchWindow(a);
    continuing.set(a, pending);
  }
  return pending;
}
// A pattern asks a region for its next window by dispatching
// `continue-window` on the region's sentinel; the answer is the
// continuation's promise, set on the event's detail before dispatch
// returns — resolving to whether the rows landed. The selection's box
// over everything matching loads its rows this way (`pattern/selection`).
document.addEventListener('continue-window', (e) => {
  const a = e.target;
  if (!(a instanceof Element) || !a.matches('a[data-window-more]') || !e.detail) return;
  e.detail.landed = continueWindow(a);
});
async function fetchWindow(a) {
  const claim =
    `${a.getAttribute('data-window-more')}:${a.getAttribute('data-window-after')}`;
  let res;
  try {
    res = await fetch(location.href, {
      headers: {
        [HEADER]: '1',
        [WINDOW_HEADER]: claim,
        [PREFS_HEADER]: prefsClaim(),
      },
    });
  } catch {
    return false; // offline etc. — the link stays, and it still works
  }
  if (!res.ok || !res.headers.has(HEADER)) return false;
  return applyFills(await res.text(), null);
}
addEventListener('load', observeSentinels);
afterFills.push(observeSentinels);
