// The reorder pattern (docs/design/state.md, "A set as a pref"; #66): a
// lineup a person puts in order by dragging a member's handle, or with
// Up and Down while the handle has focus — Halo's column customizer. The
// render declared every piece (`dom::Lineup::reordering`): the list
// (`data-pattern="reorder"`), its members (`data-reorder-token`, each the
// member's one character of the lineup's encoding), each member's handle
// (`data-reorder-handle`), and the hidden write the list carries
// (`data-reorder-write`, a pref button minted from the field). The shim
// imports this module on the first list and calls `default(list,
// signal)` once per list.
//
// What is here is the gesture and nothing of any app's: the new order is
// the members' characters joined in the list's order — the encoding is the
// order — set as the write's value and posted through the pref form like
// any pref press. The server decodes it strictly and refills the list, so
// the order shown after a move is the one it stored. While a member is
// dragged it carries `data-reordering`, for the app's style.
export default function (list, signal) {
  const write = list.querySelector(':scope > button[data-reorder-write]');
  if (!write || !write.form) throw new Error('a reorderable list carries no write: render it with `Reordering::list`');
  const members = () => [...list.children].filter((c) => c.hasAttribute('data-reorder-token'));
  const order = () => members().map((m) => m.getAttribute('data-reorder-token')).join('');
  const memberOf = (el) => {
    const handle = el instanceof Element ? el.closest('[data-reorder-handle]') : null;
    if (!handle || !list.contains(handle)) return null;
    const member = handle.closest('[data-reorder-token]');
    return member && member.parentElement === list ? { handle, member } : null;
  };

  // The order changed: post it. Unchanged (a drag let go where it began)
  // posts nothing.
  function commit() {
    const now = order();
    if (now === write.value) return;
    write.value = now;
    write.form.requestSubmit(write);
  }

  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const hit = memberOf(e.target);
    if (!hit) return;
    e.preventDefault();
    const all = members();
    const at = all.indexOf(hit.member);
    if (e.key === 'ArrowUp' && at > 0) list.insertBefore(hit.member, all[at - 1]);
    else if (e.key === 'ArrowDown' && at < all.length - 1) list.insertBefore(hit.member, all[at + 1].nextSibling);
    else return;
    hit.handle.focus();
    commit();
  }, { signal });

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hit = memberOf(e.target);
    if (!hit) return;
    e.preventDefault();
    const { handle, member } = hit;
    handle.focus();
    member.setAttribute('data-reordering', '');
    // The gesture is heard on the document, not captured by the handle:
    // moving the member moves its handle in the tree, which would release
    // a capture mid-drag.
    const drag = new AbortController();
    signal.addEventListener('abort', () => drag.abort(), { once: true });
    // The member goes before the first other member whose middle is
    // below the pointer, or last when none is.
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const others = members().filter((m) => m !== member);
      const before = others.find((m) => {
        const r = m.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2;
      });
      const anchor = before || (others.length ? others[others.length - 1].nextSibling : null);
      if (anchor !== member && anchor !== member.nextSibling) list.insertBefore(member, anchor);
    };
    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      drag.abort();
      member.removeAttribute('data-reordering');
      handle.focus();
      commit();
    };
    document.addEventListener('pointermove', move, { signal: drag.signal });
    document.addEventListener('pointerup', end, { signal: drag.signal });
    document.addEventListener('pointercancel', end, { signal: drag.signal });
  }, { signal });
}
