// live: cut from progressive.js for the bundling probe (#754).
import { HEADER, LIVE_HEADER, PREFS_HEADER, READS_HEADER, XACT_HEADER, applyFills, prefsClaim } from './core.js';
import { applyUrlState } from './state.js';

// Live data (`docs/design/what_is_a_page.md`, #285): the server sends
// one `change` event per table a transaction wrote, `{table} {xact}`,
// or `{table} {xact} {col,col}` for an update that moved only those
// columns (#284). The page answers by fetching itself as fills, naming
// what it heard (`x-progressive-live`: `table`, or `table.col.col`
// when every hint for it was such an update, with the transactions
// heard, `@xact@xact`, whose moved rows the server kept off the hint
// so a keyed region can refill those items alone, #275), and the
// server refills exactly the regions that read one of them, under the
// reader's own actor. Three
// hints are not worth a request: one naming a transaction this page's
// own form committed (its Stay answer already refilled the page, and
// said which transaction in `x-progressive-xact`), one whose table no
// region here reads (every fills answer says what its page reads,
// `x-progressive-reads`; a first load has no set and refetches), and
// any while a form is posting (held until it answers, so its id is
// known first). Hints are coalesced over a short window, and a page
// mid-interaction (a dialog open, anything editable focused, the rich
// editor included) holds off: a range fill is destructive, and a
// typed-but-unsent form must not vanish under the typist. On reconnect
// the browser resumes the stream; a missed hint costs one stale
// interval, never correctness.
const liveHeard = new Map(); // table -> { xacts: Set of transaction ids, columns: Set, or null for the whole row }
const ownXacts = [];         // the transactions this page's forms committed, latest last
let pageReads = null;        // what this page's regions read; null = not known yet
let posting = 0;
let liveTimer = null;
export function bumpPosting(by) { posting += by; }
export function clearPageReads() { pageReads = null; }
export function noteReads(res) {
  const reads = res.headers.get(READS_HEADER);
  pageReads = reads === null || reads === '*' ? null : new Set(reads.split(',').filter(Boolean));
}
export function noteOwnXact(res) {
  const xact = res.headers.get(XACT_HEADER);
  if (!xact) return;
  ownXacts.push(xact);
  if (ownXacts.length > 32) ownXacts.shift();
}
export function editing() {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || el.matches?.('input, select, textarea'));
}
function liveSchedule(delay) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(liveRefresh, delay);
}
async function liveRefresh() {
  // A drag in hand (`data-dragging`) is held like typing: a refill
  // would take the item from under the pointer. The page notice is a
  // dialog too, but it holds nothing the person is doing: a refused
  // drop's toast must not keep the board from showing what is so.
  if (posting > 0 || document.querySelector('dialog[open]:not([data-notice-place] dialog), [data-dragging]') || editing()) {
    liveSchedule(1000);
    return;
  }
  const tables = [];
  for (const [table, { xacts, columns }] of liveHeard) {
    if ([...xacts].some((x) => !ownXacts.includes(x)) &&
        (pageReads === null || pageReads.has(table))) {
      tables.push(columns === null ? table : [table, ...columns].join('.') + [...xacts].map((x) => `@${x}`).join(''));
    }
  }
  liveHeard.clear();
  if (tables.length === 0) return;
  let res;
  try {
    res = await fetch(location.href, {
      headers: {
        [HEADER]: '1',
        'x-progressive-from': location.href,
        [PREFS_HEADER]: prefsClaim(),
        [LIVE_HEADER]: tables.join(','),
      },
    });
  } catch {
    return;
  }
  if (!res.ok || !res.headers.has(HEADER)) {
    // The server did not answer as fills: this page cannot follow
    // live changes until it is loaded again. Said, not swallowed.
    console.warn(`live refresh of ${location.href} was not answered as fills (${res.status})`);
    return;
  }
  noteReads(res);
  if (!(await applyFills(await res.text(), null))) {
    console.warn(`live refresh of ${location.href} missed a range; the page is stale until reloaded`);
  }
  applyUrlState(location.href);
}
function liveConnect() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/_live');
  source.addEventListener('change', (e) => {
    const [table, xact = '', moved = ''] = String(e.data).split(' ');
    if (!table) return;
    if (!liveHeard.has(table)) liveHeard.set(table, { xacts: new Set(), columns: new Set() });
    const heard = liveHeard.get(table);
    heard.xacts.add(xact);
    // An insert or a delete names no columns: the whole row, for good.
    if (!moved) heard.columns = null;
    else if (heard.columns !== null) for (const c of moved.split(',')) heard.columns.add(c);
    liveSchedule(150);
  });
}
addEventListener('load', liveConnect);
