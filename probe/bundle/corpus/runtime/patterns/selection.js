// The selection pattern (docs/adr/0005, docs/design/forms.md "Chosen
// rows"): a set of rows a person ticks across pages and filters, held by
// the browser and sent with a form. The render declared every piece
// (`dom::Chooser`), each stamped `data-pattern="selection"` and
// `data-selection="{chooser}"`; the shim imports this module on the first
// and calls `default(el, signal)` once per piece, the signal aborted when
// the piece leaves the document. Pieces of one chooser share one set,
// whichever region rendered them, so a page's table and its dock need not
// be rendered together.
//
// The set lives in the tab's session storage under the page's path and
// the chooser's id: paging and filtering re-render the rows, and the set
// is still there; another page, or another tab, starts empty.
//
// The pieces, by their stamp:
//   data-selects="{row}"      a row's box: ticked while the set holds it,
//     data-admits="{forms}"   the fed forms the row's read granted
//     data-carries="{f}:{n}"  the figures the row carries, space-separated
//   data-selection-action="{form}"  one of a fed form's actions: shown only
//                             while every held row admits the form
//   data-assured              on a marker or an action: the model admits the
//                             form on every row under the level, so no row
//                             names it and every held row admits it
//   data-selects-page         the page's box: every row box on the page
//     data-selects-all="{n}"  ...and on a scrolled listing, everything
//     data-selects-through=   matching: the region `{base}` continues its
//       "{base}"              window until the set holds n or it ends
//   data-selection-count      the set's size, as text (with data-one /
//                             data-many, the size and the noun that agrees)
//   data-selection-sum="{f}"  the held rows' figure f added up, as text
//                             (with data-one / data-many, as the count)
//   data-selection-dock       a manual popover, shown while the set is not empty
//   data-selection-over="{n}" shown while the set holds more than n
//   data-selection-full="{n}" shown while the set holds exactly n
//   data-selection-clear      a button that empties the set
//   data-feeds="{name}"       a fed form's marker (`dom::Fed`), with data-cap
//
// What is here is the selection's behaviour and nothing of any app's. It
// decides no rule: the cap is the field's type, handed over as data-cap,
// each row's admits are its read's verdicts, and the server parses the set
// and gates every row again; a stale or forged submission is refused there.
//
// The set is a map from a row to what it admits and the figures it
// carries, kept from the moment it was ticked: a row held from another
// page is not on this one to ask.
const groups = new Map();

function storageKey(name) {
  return `selection:${location.pathname}:${name}`;
}

function group(name) {
  const key = storageKey(name);
  let g = groups.get(key);
  if (g) return g;
  let held = {};
  try {
    held = JSON.parse(sessionStorage.getItem(key) || '{}');
  } catch {
    held = {};
  }
  const ids = new Map();
  if (held && typeof held === 'object' && !Array.isArray(held)) {
    for (const [row, kept] of Object.entries(held)) ids.set(String(row), keptRow(kept));
  }
  g = { key, ids, pieces: new Set(), anchor: null, inflight: null, loading: null };
  groups.set(key, g);
  return g;
}

function save(g) {
  try {
    if (g.ids.size) sessionStorage.setItem(g.key, JSON.stringify(Object.fromEntries(g.ids)));
    else sessionStorage.removeItem(g.key);
  } catch {
    // Storage refused (a private window's quota): the set still holds
    // for this document.
  }
}

// The row boxes on the page, in document order: what the page box and a
// shift-click range reach.
function rowBoxes(g) {
  const rows = [...g.pieces].filter((p) => p.isConnected && p.hasAttribute('data-selects'));
  return rows.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// A fed form's submitters that this pattern holds while the set cannot be
// sent: none chosen, or more than the cap.
function submitters(form) {
  return [...form.elements].filter((el) =>
    el.matches('button:not([type="button"]):not([type="reset"]), input[type="submit"]'));
}

// A held row as storage kept it: `{ a: admits, s: { figure: n } }`, or
// the bare admits list an earlier page stored. Anything else holds the row
// with nothing admitted and nothing carried.
function keptRow(kept) {
  if (Array.isArray(kept)) return { a: kept.map(String), s: {} };
  const a = kept && Array.isArray(kept.a) ? kept.a.map(String) : [];
  const s = {};
  if (kept && kept.s && typeof kept.s === 'object') {
    for (const [f, n] of Object.entries(kept.s)) if (Number.isFinite(Number(n))) s[f] = Number(n);
  }
  return { a, s };
}

// A row box's admits and figures, as its stamp says.
function rowOf(box) {
  const a = (box.getAttribute('data-admits') || '').split(' ').filter(Boolean);
  const s = {};
  for (const pair of (box.getAttribute('data-carries') || '').split(' ').filter(Boolean)) {
    const [f, n] = pair.split(':');
    if (f && Number.isFinite(Number(n))) s[f] = Number(n);
  }
  return { a, s };
}

function hold(ids, box) {
  ids.set(box.getAttribute('data-selects'), rowOf(box));
}

// Whether every held row admits the form named `form` — every row does
// when the piece asking says the model assures it.
function admitted(g, form, assured) {
  if (assured) return true;
  for (const row of g.ids.values()) if (!row.a.includes(form)) return false;
  return true;
}

// The held rows' figure `f`, added up.
function sum(g, f) {
  let total = 0;
  for (const row of g.ids.values()) total += row.s[f] || 0;
  return total;
}

// A number with the noun that agrees, from a piece's data-one/data-many.
function said(p, n) {
  const noun = p.getAttribute(n === 1 ? 'data-one' : 'data-many');
  return noun === null ? String(n) : `${n} ${noun}`;
}

// The discriminant of the form a marker feeds (`__form`): the name a
// row's admits use.
function formName(form) {
  return form.elements.namedItem('__form')?.value || '';
}

function render(g) {
  const size = g.ids.size;
  const rows = rowBoxes(g);
  const ticked = rows.filter((r) => g.ids.has(r.getAttribute('data-selects'))).length;
  for (const p of g.pieces) {
    if (!p.isConnected) continue;
    if (p.hasAttribute('data-selects')) {
      p.checked = g.ids.has(p.getAttribute('data-selects'));
    } else if (p.hasAttribute('data-selects-page')) {
      // The box over everything matching is done once the set is full,
      // though rows past the cap stay unticked — so a press unticks.
      const full = p.hasAttribute('data-selects-all') && size >= Number(p.getAttribute('data-selects-all'));
      p.checked = rows.length > 0 && (ticked === rows.length || (full && ticked > 0));
      p.indeterminate = !p.checked && ticked > 0;
      p.disabled = rows.length === 0;
    } else if (p.hasAttribute('data-selection-count')) {
      // A counted phrase carries its nouns (`Chooser::counted`).
      p.textContent = said(p, size);
    } else if (p.hasAttribute('data-selection-sum')) {
      p.textContent = said(p, sum(g, p.getAttribute('data-selection-sum')));
    } else if (p.hasAttribute('data-selection-dock')) {
      const open = p.matches(':popover-open');
      if (size > 0 && !open) p.showPopover();
      if (size === 0 && open) p.hidePopover();
    } else if (p.hasAttribute('data-selection-action')) {
      p.hidden = !admitted(g, p.getAttribute('data-selection-action'), p.hasAttribute('data-assured'));
    } else if (p.hasAttribute('data-selection-over')) {
      p.hidden = !(size > Number(p.getAttribute('data-selection-over')));
    } else if (p.hasAttribute('data-selection-full')) {
      p.hidden = size !== Number(p.getAttribute('data-selection-full'));
    } else if (p.hasAttribute('data-feeds') && p.form) {
      // Held while the shim holds it too (a submit in flight) is the
      // shim's to release; only what this pattern disabled is its own.
      if (p.form.getAttribute('aria-busy') === 'true') continue;
      const cap = Number(p.getAttribute('data-cap'));
      const blocked = size === 0 || size > cap || !admitted(g, formName(p.form), p.hasAttribute('data-assured'));
      for (const s of submitters(p.form)) {
        if (blocked && !s.disabled) {
          s.disabled = true;
          s.setAttribute('data-selection-held', '');
        } else if (!blocked && s.hasAttribute('data-selection-held')) {
          s.disabled = false;
          s.removeAttribute('data-selection-held');
        }
      }
    }
  }
}

function change(g, mutate) {
  mutate(g.ids);
  save(g);
  render(g);
}

// A write that went through takes its rows with it: the shim says which
// form's submission was accepted, and the set sent with it empties. A
// refusal leaves the set as it was, to fix and send again.
document.addEventListener('accepted', (e) => {
  for (const g of groups.values()) {
    if (g.inflight && g.inflight === e.detail?.form) {
      g.inflight = null;
      g.anchor = null;
      change(g, (ids) => ids.clear());
    }
  }
});

// The box over everything matching (`Chooser::all_box`): tick the loaded
// rows, then have the region continue its window — the continuations
// scrolling makes, so each row arrives with its own read's admits — and
// tick what lands, until the set holds the cap or the listing ends. The
// boxes are read from the document, not from the mounted pieces: a row
// that just landed is ticked before its own piece has mounted, and
// mounting renders it ticked. Unticking the box, or the box leaving,
// stops the loading where it is.
async function selectAll(g, name, el, signal) {
  const cap = Number(el.getAttribute('data-selects-all'));
  const through = el.getAttribute('data-selects-through');
  const run = {};
  g.loading = run;
  const boxes = () => [...document.querySelectorAll('input[data-selects]')]
    .filter((b) => b.getAttribute('data-selection') === name);
  const tick = () => change(g, (ids) => {
    for (const b of boxes()) {
      if (ids.size >= cap) break;
      hold(ids, b);
    }
  });
  el.setAttribute('aria-busy', 'true');
  try {
    tick();
    while (g.ids.size < cap && g.loading === run && !signal.aborted) {
      const more = [...document.querySelectorAll('a[data-window-more]')]
        .find((a) => a.getAttribute('data-window-more') === through);
      if (!more) break;
      const ask = new CustomEvent('continue-window', { bubbles: true, detail: {} });
      more.dispatchEvent(ask);
      if (!ask.detail.landed || !(await ask.detail.landed)) break;
      if (g.loading !== run || signal.aborted) break;
      tick();
    }
  } finally {
    if (g.loading === run) g.loading = null;
    el.removeAttribute('aria-busy');
    render(g);
  }
}

export default function (el, signal) {
  const name = el.getAttribute('data-selection');
  if (!name) throw new Error('a selection piece names no chooser: render it from `dom::Chooser`');
  const g = group(name);
  g.pieces.add(el);
  signal.addEventListener('abort', () => {
    g.pieces.delete(el);
    if (g.anchor === el) g.anchor = null;
    // A row leaving (the next page) changes what the page box reaches.
    render(g);
  });

  if (el.hasAttribute('data-selects')) {
    // `click`, not `change`: the range needs the pointer's Shift. The box
    // has already flipped when the listener runs.
    el.addEventListener('click', (e) => {
      const on = el.checked;
      const rows = rowBoxes(g);
      let reach = [el];
      if (e.shiftKey && g.anchor && g.anchor.isConnected && g.anchor !== el) {
        const a = rows.indexOf(g.anchor);
        const b = rows.indexOf(el);
        if (a >= 0 && b >= 0) reach = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
      }
      g.anchor = el;
      change(g, (ids) => {
        for (const r of reach) {
          if (on) hold(ids, r);
          else ids.delete(r.getAttribute('data-selects'));
        }
      });
    }, { signal });
  } else if (el.hasAttribute('data-selects-page')) {
    el.addEventListener('change', () => {
      const on = el.checked;
      g.loading = null;
      if (on && el.hasAttribute('data-selects-all')) {
        selectAll(g, name, el, signal);
        return;
      }
      change(g, (ids) => {
        for (const r of rowBoxes(g)) {
          if (on) hold(ids, r);
          else ids.delete(r.getAttribute('data-selects'));
        }
      });
    }, { signal });
  } else if (el.hasAttribute('data-selection-clear')) {
    el.addEventListener('click', () => {
      g.anchor = null;
      g.loading = null;
      change(g, (ids) => ids.clear());
    }, { signal });
  } else if (el.hasAttribute('data-feeds')) {
    const form = el.form;
    if (!form) throw new Error('a fed field\'s marker has no form: render it with `Chooser::feeds`');
    const field = el.getAttribute('data-feeds');
    // The one copy of the set goes into the entry list at submit — the
    // shim's `new FormData(form, submitter)` and a native submission both
    // fire this — so the wire is the form's own, parsed by its declaration.
    form.addEventListener('formdata', (e) => {
      for (const row of g.ids.keys()) e.formData.append(field, row);
      g.inflight = form;
    }, { signal });
  }
  render(g);
}
