// The drag-pick pattern (`dom::DragPick`, #388): a board whose items a
// person drags between zones, each zone one value of a closed set, where
// the drop picks that value in the item's own picker and submits the
// picker's form — the post the form's own dialog makes, nothing else.
// The render declared every piece: the board (`data-pattern="drag-pick"`),
// each zone (`data-drop-value`, the value's wire label) with its list
// (`data-drop-list`), count (`data-drop-count`) and empty note
// (`data-drop-empty`), and each item (`data-drag-rank`, its place in the
// order every zone keeps; `data-drag-pick`, on an item that drags, the id
// of the picker its drop sets). The shim imports this module on the first board and calls
// `default(board, signal)` once per board it mounts.
//
// The drop is optimistic: the item moves into the zone when it is let go,
// at its rank, which is where the refill after the write puts it. The
// form is posted marked aside (`data-posted-aside`), so a refusal's words
// go to the page notice; the shim's `refused` puts the item back. One
// drop is posted at a time — a second navigation would abort the first
// mid-write — and the ones waiting are shown already, again on every
// board a refill mounts, until each is answered.
//
// Nothing is laid out again until the drop. The item in hand is the item
// itself, lifted where it stands and moved by transform; the items behind
// it close its place, and the items of the zone it is held over open one,
// each by transform too. Every box is read once, when the drag starts,
// and the pointer is matched against those reads, never hit-tested. The
// drop is the one change to the tree: the item moves into its zone, and
// slides from where it was shown to where it landed.
//
// Style hooks, all the app's: `data-dragging` on the board while an item
// is in hand, `data-drag-source` on that item (lifted: it must paint above
// the zones it crosses), `data-drop-over` on the zone it would drop in,
// `data-drag-pending` on a dropped item awaiting its answer.

const THRESHOLD = 6;  // px a press moves before it is a drag (Halo's dnd-kit distance)
const EDGE = 56;      // px from a scroller's edge where a held item scrolls it
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Drops shown and not yet answered, oldest first: { pick, value, from }.
// The head is posted (`posted`, its form) and the rest wait.
const queue = [];
let posted = null;
// Each board's sideways scroll, by id: a refill draws it anew at zero.
const scrolled = new Map();
const boards = new Set();

const itemIn = (board, pick) => board.querySelector(`[data-drag-pick="${CSS.escape(pick)}"]`);
const zoneOf = (el) => el.closest('[data-drop-value]');
const listOf = (zone) => zone.querySelector('[data-drop-list]');
const zoneValued = (board, value) => board.querySelector(`[data-drop-value="${CSS.escape(value)}"]`);
// Every item of a list, dragged or held in place: what it counts, and
// what a rank falls among.
const itemsOf = (list) => [...list.children].filter((c) => c.hasAttribute('data-drag-rank'));
const rankOf = (item) => Number(item.getAttribute('data-drag-rank'));

// The picker an item's drop sets, and whether it offers `value`.
function pickerOf(item) {
  const el = document.getElementById(item.getAttribute('data-drag-pick'));
  return el instanceof HTMLSelectElement && el.form ? el : null;
}
function offers(picker, value) {
  return [...picker.options].some((o) => o.value === value && !o.disabled);
}

// Where an item of `rank` stands in `list`: before the first item ranked
// after it, else at the end.
function slotIn(list, rank, except) {
  return itemsOf(list).find((c) => c !== except && rankOf(c) > rank) || null;
}

// FLIP: where `els` are now, then — after the DOM moved — each slides
// from there to where it landed.
function measure(els) {
  return new Map([...els].filter((e) => e.isConnected).map((e) => [e, e.getBoundingClientRect()]));
}
function play(before, duration = 200) {
  if (reduced()) return;
  for (const [el, r] of before) {
    if (!el.isConnected) continue;
    const now = el.getBoundingClientRect();
    const dx = r.left - now.left;
    const dy = r.top - now.top;
    for (const a of el.getAnimations()) a.cancel();
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}
function animated(lists) {
  return lists.filter(Boolean).flatMap((l) => [...l.children].filter((c) => !c.hidden));
}

// A zone's count and empty note, said again from what it holds.
function recount(zone) {
  if (!zone) return;
  const list = listOf(zone);
  const n = itemsOf(list).length;
  const count = zone.querySelector('[data-drop-count]');
  if (count) count.textContent = String(n);
  const empty = list.querySelector(':scope > [data-drop-empty]');
  if (empty) {
    empty.hidden = n > 0;
    empty.style.opacity = '';
  }
}

// Put `item` in the zone valued `value` at its rank: animated, or not
// (a board just mounted shows a waiting drop as if it were always there).
function moveTo(board, item, value, animate) {
  const to = zoneValued(board, value);
  if (!to) return;
  const from = zoneOf(item);
  const target = listOf(to);
  const lists = [listOf(from), target];
  const before = animate ? measure(animated(lists)) : null;
  target.insertBefore(item, slotIn(target, rankOf(item), item));
  recount(from);
  recount(to);
  if (before) play(before);
}

// Post the next waiting drop, if none is in flight.
function pump() {
  while (!posted && queue.length) {
    const drop = queue[0];
    const item = [...boards].map((b) => itemIn(b, drop.pick)).find(Boolean);
    const picker = item && pickerOf(item);
    if (!picker || !offers(picker, drop.value)) {
      // The board no longer offers this drop (a refill moved on): it
      // cannot be posted, so it is not shown either.
      settle(false);
      continue;
    }
    picker.value = drop.value;
    const form = picker.form;
    if (!form.checkValidity()) {
      settle(false);
      continue;
    }
    posted = form;
    form.setAttribute('data-posted-aside', '');
    form.requestSubmit();
  }
}

// The head drop's answer: kept, or put back.
function settle(kept) {
  const drop = queue.shift();
  posted = null;
  if (!drop) return;
  for (const board of boards) {
    const item = itemIn(board, drop.pick);
    if (!item) continue;
    item.removeAttribute('data-drag-pending');
    if (!kept && zoneOf(item)?.getAttribute('data-drop-value') === drop.value) moveTo(board, item, drop.from, true);
  }
}

document.addEventListener('accepted', (e) => {
  if (posted && e.detail.form === posted) {
    settle(true);
    pump();
  }
});
document.addEventListener('refused', (e) => {
  if (posted && e.detail.form === posted) {
    settle(false);
    pump();
  }
});

// The nearest box that scrolls sideways: the board, else the page.
function scrollerOf(board) {
  return board.scrollWidth > board.clientWidth ? board : document.scrollingElement;
}

// Where the board can be seen at height `y`, left and right, in the
// viewport: a board that scrolls the page sideways slides under what the
// page holds still (a rail laid over it, the sidebar), and its edges for
// scrolling are where it shows, not where the window ends. `x` is a
// point where it shows (the pointer, on the item); what covers it is
// taken to cover it from the side, so each edge is found by halving.
function shownEdges(board, x, y) {
  const r = board.getBoundingClientRect();
  const shows = (px) => {
    const hit = document.elementFromPoint(px, y);
    return !!hit && board.contains(hit);
  };
  let lo = Math.max(0, r.left);
  let hi = x;
  while (hi - lo > 2) {
    const mid = (lo + hi) / 2;
    if (shows(mid)) hi = mid;
    else lo = mid;
  }
  const left = hi;
  lo = x;
  hi = Math.min(innerWidth, r.right);
  while (hi - lo > 2) {
    const mid = (lo + hi) / 2;
    if (shows(mid)) lo = mid;
    else hi = mid;
  }
  return { left, right: lo };
}

export default function (board, signal) {
  boards.add(board);
  signal.addEventListener('abort', () => boards.delete(board), { once: true });
  if (board.id && scrolled.has(board.id)) board.scrollLeft = scrolled.get(board.id);
  board.addEventListener('scroll', () => { if (board.id) scrolled.set(board.id, board.scrollLeft); }, { passive: true, signal });
  // The drops still waiting, shown on the board the refill drew.
  for (const drop of queue) {
    const item = itemIn(board, drop.pick);
    if (!item) continue;
    item.setAttribute('data-drag-pending', '');
    if (zoneOf(item)?.getAttribute('data-drop-value') !== drop.value) moveTo(board, item, drop.value, false);
  }

  // A link inside an item is pressed to drag the item, not the link.
  board.addEventListener('dragstart', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-drag-pick]')) e.preventDefault();
  }, { signal });

  board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const item = e.target instanceof Element ? e.target.closest('[data-drag-pick]') : null;
    if (!item || !board.contains(item)) return;
    // Its controls are its own: a menu's trigger opens the menu.
    if (e.target.closest('button, input, select, textarea, [popover], [contenteditable]')) return;
    if (item.hasAttribute('data-drag-pending')) return;
    const picker = pickerOf(item);
    if (!picker) return;
    press(board, item, picker, e, signal);
  }, { signal });
}

// One press on an item, from pointerdown: a drag once it has moved past
// the threshold, else nothing (the click is the item's own).
function press(board, item, picker, down, signal) {
  const gesture = new AbortController();
  signal.addEventListener('abort', () => gesture.abort(), { once: true });
  const on = { signal: gesture.signal };
  const home = zoneOf(item);
  const homeValue = home.getAttribute('data-drop-value');
  let drag = null;
  let x = down.clientX;
  let y = down.clientY;

  // While pressed, no text is selected.
  document.addEventListener('selectstart', (ev) => ev.preventDefault(), on);

  // Everything the drag consults, read once, before anything is written:
  // each zone's box (in page coordinates, so scrolling does not stale
  // them), its items in order, the room the item takes in a list, and
  // where the board shows.
  function start() {
    const box = item.getBoundingClientRect();
    const frame = board.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(listOf(home)).rowGap) || 0;
    const scroller = scrollerOf(board);
    const zones = [...board.querySelectorAll('[data-drop-value]')].map((zone) => {
      const r = zone.getBoundingClientRect();
      const list = listOf(zone);
      return {
        zone,
        value: zone.getAttribute('data-drop-value'),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        items: itemsOf(list).filter((c) => c !== item),
        empty: list.querySelector(':scope > [data-drop-empty]'),
        takes: zone === home || offers(picker, zone.getAttribute('data-drop-value')),
      };
    });
    const edges = shownEdges(board, down.clientX, Math.min(Math.max(down.clientY, 0), innerHeight - 1));
    const scrolls = () => [scroller === document.scrollingElement ? scrollX : scroller.scrollLeft, scrollY];
    const [ox, oy] = scrolls();
    const rank = rankOf(item);
    drag = {
      zones,
      edges,
      scroller,
      scrolls,
      room: box.height + gap,
      // How far the item may go each way: it stays on the board, so the
      // page's scrollable size (which the pinned parts' scroll-driven
      // offsets are measured against) never changes under the drag.
      bounds: {
        left: frame.left - box.left,
        right: frame.right - box.right,
        up: frame.top - box.top,
        down: frame.bottom - box.bottom,
      },
      ox, oy,
      over: null,       // the zone it would drop in (never home)
      at: null,         // the zone the pointer is in (home included)
      shifted: new Map(), // item → its offset now
      frame: 0,
      last: '',
      moved: null,      // the item's offset now
      rank,
    };
    // The writes: the item lifted, the board marked.
    item.setAttribute('data-drag-source', '');
    item.style.transition = 'none';
    board.setAttribute('data-dragging', '');
    getSelection()?.removeAllRanges();
    // Its own place closes: the items after it in its list move up.
    lay(null);
    tick();
  }

  // Set `el`'s offset to `dy`, sliding there.
  function shift(el, dy) {
    const now = drag.shifted.get(el) || 0;
    if (now === dy) return;
    if (!drag.shifted.has(el)) el.style.transition = reduced() ? 'none' : 'transform .2s cubic-bezier(.2,.7,.2,1)';
    drag.shifted.set(el, dy);
    el.style.transform = dy ? `translateY(${dy}px)` : '';
  }

  // The zones as they stand with the item held over `at`: home's place
  // open where `at` is home, else closed; the place in `over` open.
  function lay(at) {
    const homeRoom = at && at.zone === home ? 0 : -drag.room;
    const over = at && at.zone !== home ? at : null;
    for (const z of drag.zones) {
      if (z.zone === home) {
        for (const c of z.items) shift(c, rankOf(c) > drag.rank ? homeRoom : 0);
      } else if (z === over) {
        for (const c of z.items) shift(c, rankOf(c) > drag.rank ? drag.room : 0);
      } else if (z === drag.over) {
        for (const c of z.items) shift(c, 0);
      }
    }
    if (drag.over !== over) {
      if (drag.over) {
        drag.over.zone.removeAttribute('data-drop-over');
        if (drag.over.empty) drag.over.empty.style.opacity = '';
      }
      if (over) {
        over.zone.setAttribute('data-drop-over', '');
        if (over.empty) over.empty.style.opacity = '0';
      }
      drag.over = over;
    }
    drag.at = at;
  }

  // The zone under the pointer that may take the item (home included,
  // where dropping is no move), from the boxes read at the start.
  function zoneAt(px, py, cx, cy) {
    if (px < drag.edges.left || px > drag.edges.right) return null;
    const dx = px + cx - drag.ox;
    const dy = py + cy - drag.oy;
    const z = drag.zones.find((z) => dx >= z.left && dx < z.right && dy >= z.top && dy < z.bottom);
    return z && z.takes ? z : null;
  }

  // Each frame, reads first, then writes: the item under the pointer
  // (scrolling carries it with the page, so the scroll since the start
  // is added back), the scrollers moved when it nears their edges, the
  // zones laid out for where it is.
  function tick() {
    if (!drag) return;
    const [cx, cy] = drag.scrolls();
    const key = `${x},${y},${cx},${cy}`;
    if (key !== drag.last) {
      drag.last = key;
      const { left, right, up, down: below } = drag.bounds;
      const tx = Math.min(right, Math.max(left, x - down.clientX + cx - drag.ox));
      const ty = Math.min(below, Math.max(up, y - down.clientY + cy - drag.oy));
      drag.moved = { x: tx, y: ty };
      item.style.transform = `translate(${tx}px, ${ty}px)`;
      const at = zoneAt(x, y, cx, cy);
      if (at !== drag.at) lay(at);
    }
    const box = drag.edges;
    const speed = (d) => Math.round(Math.min(1, (EDGE - d) / EDGE) * 18);
    if (x < box.left + EDGE) drag.scroller.scrollLeft -= speed(x - box.left);
    else if (x > box.right - EDGE) drag.scroller.scrollLeft += speed(box.right - x);
    if (y < EDGE) scrollBy(0, -speed(y));
    else if (y > innerHeight - EDGE) scrollBy(0, speed(innerHeight - y));
    drag.frame = requestAnimationFrame(tick);
  }

  // Every offset the drag wrote, gone at once.
  function unshift() {
    for (const el of drag.shifted.keys()) {
      el.style.transition = '';
      el.style.transform = '';
    }
    for (const z of drag.zones) if (z.empty) z.empty.style.opacity = '';
  }

  // The drag over: dropped in a zone, or put back.
  function finish(drop) {
    gesture.abort();
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    const { over } = drag;
    board.removeAttribute('data-dragging');
    // A drag ends in a click on what was pressed: not a click.
    const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
    if (over) over.zone.removeAttribute('data-drop-over');
    if (drop && over) {
      // The one change to the tree. Where the item shows now, then the
      // offsets dropped and the item moved: the others are already where
      // the move puts them, and the item slides from there to its place.
      const shown = item.getBoundingClientRect();
      unshift();
      item.style.transform = '';
      const list = listOf(over.zone);
      list.insertBefore(item, slotIn(list, drag.rank, item));
      recount(home);
      recount(over.zone);
      const landed = item.getBoundingClientRect();
      item.setAttribute('data-drag-pending', '');
      settleLift(shown.left - landed.left, shown.top - landed.top);
      queue.push({ pick: item.getAttribute('data-drag-pick'), value: over.value, from: homeValue });
      pump();
      return;
    }
    // Put back: everything slides to where it was, then lets go.
    lay({ zone: home });
    const from = drag.moved || { x: 0, y: 0 };
    const shifted = [...drag.shifted.keys()];
    item.style.transform = '';
    settleLift(from.x, from.y, () => {
      for (const el of shifted) {
        el.style.transition = '';
        el.style.transform = '';
      }
    });
  }

  // The lifted item, `dx`/`dy` from where it stands, slides home and is
  // set down.
  function settleLift(dx, dy, then) {
    const down = () => {
      item.removeAttribute('data-drag-source');
      item.style.transition = '';
      then?.();
    };
    if (reduced() || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) return down();
    item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' })
      .finished.then(down, down);
  }

  document.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== down.pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    if (!drag && Math.hypot(x - down.clientX, y - down.clientY) >= THRESHOLD) start();
  }, on);
  document.addEventListener('pointerup', (ev) => { if (ev.pointerId === down.pointerId) finish(true); }, on);
  document.addEventListener('pointercancel', (ev) => { if (ev.pointerId === down.pointerId) finish(false); }, on);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && drag) {
      ev.preventDefault();
      finish(false);
    }
  }, on);
  // The board went away under the drag: so did the drag.
  signal.addEventListener('abort', () => {
    if (drag) cancelAnimationFrame(drag.frame);
    drag = null;
  }, { once: true });
}
