// The combobox pattern (docs/design/enhancements.md, "Patterns"): an
// editable combobox with a listbox popup — ARIA Authoring Practices,
// list autocomplete with no inline completion. The render declared it
// (`El::combobox`): `role="combobox"`, `aria-controls` naming the
// listbox — a `manual` popover (`El::<Ul>::listbox`), whose options are
// its `[role="option"]` children — and `data-anchor`, the element the
// list hangs from when it is not the input; the shim imports this
// module on the first such input it sees and calls
// `default(input, signal)` once per input, the signal aborted when the
// input leaves the document. What is here is the pattern's behaviour and
// nothing of any app's: the list is shown in the top layer with its
// anchor as the invoker (so the sheet's bare `anchor()` is that box)
// while it has options and the input has focus, hidden on blur and
// Escape (which stays here — the dialog around it does not close), the
// arrows move the active option (`aria-activedescendant` on the input,
// `aria-selected` on the option, wrapping or stopping as declared by
// `data-wrap`), the pointer marks under it, and Enter or a click
// **chooses** the active option: the listbox dispatches `choose` with
// the option as its detail, which an items field's `chosen` hears as
// the instance, and the list closes. The popover's own state is the
// truth of open: whatever hides it, `aria-expanded` and the mark
// follow. Whose options they are, and what choosing means, is the
// enhancement's; this module reads the listbox's children and writes
// attributes on them and the input, and does nothing else.
export default function (input, signal) {
  const list = document.getElementById(input.getAttribute('aria-controls'));
  if (!list) throw new Error('a combobox names a listbox that is not in the document');
  if (!list.hasAttribute('popover')) throw new Error('a combobox\'s listbox must be a popover: render it with `El::<Ul>::listbox`');
  const anchorId = input.getAttribute('data-anchor');
  const anchor = anchorId ? document.getElementById(anchorId) : input;
  if (!anchor) throw new Error(`a combobox hangs its list from \`${anchorId}\`, which is not in the document`);
  const wrap = input.getAttribute('data-wrap') !== 'stop';
  let active = -1;
  const options = () => [...list.querySelectorAll('[role="option"]')];
  const isOpen = () => list.matches(':popover-open');
  function mark(i) {
    const all = options();
    active = all.length ? i : -1;
    all.forEach((o, k) => {
      if (!o.id) o.id = `${list.id}-${k}`;
      o.setAttribute('aria-selected', k === active ? 'true' : 'false');
    });
    const current = active >= 0 ? all[active] : null;
    if (current) input.setAttribute('aria-activedescendant', current.id);
    else input.removeAttribute('aria-activedescendant');
  }
  function open() {
    if (isOpen()) return;
    list.showPopover({ source: anchor });
  }
  function close() {
    if (!isOpen()) return;
    list.hidePopover();
  }
  // The popover's state is the truth: expanded and the mark follow it,
  // however it was shown or hidden — `beforetoggle`, which fires in the
  // call (`toggle` is queued), so an arrow's own mark lands after.
  list.addEventListener('beforetoggle', (e) => {
    const shown = e.newState === 'open';
    input.setAttribute('aria-expanded', shown ? 'true' : 'false');
    mark(shown ? 0 : -1);
  }, { signal });
  function choose(i) {
    const option = options()[i];
    if (!option) return;
    list.dispatchEvent(new CustomEvent('choose', { detail: option }));
    close();
  }
  // The options are the enhancement's to fill: open when some arrive
  // while the input has focus, close when they go, keep the mark valid.
  const observer = new MutationObserver(() => {
    const n = options().length;
    if (!n) close();
    else if (document.activeElement === input) { if (isOpen()) mark(Math.min(active < 0 ? 0 : active, n - 1)); else open(); }
  });
  observer.observe(list, { childList: true });
  signal.addEventListener('abort', () => { observer.disconnect(); close(); });
  input.addEventListener('keydown', (e) => {
    const n = options().length;
    if (e.key === 'ArrowDown') {
      if (!n) return;
      e.preventDefault();
      if (!isOpen()) open();
      else if (active < n - 1) mark(active + 1);
      else if (wrap) mark(0);
    } else if (e.key === 'ArrowUp') {
      if (!n) return;
      e.preventDefault();
      if (!isOpen()) { open(); mark(n - 1); }
      else if (active > 0) mark(active - 1);
      else if (wrap) mark(n - 1);
    } else if (e.key === 'Enter' && isOpen() && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, { signal });
  input.addEventListener('blur', close, { signal });
  input.addEventListener('focus', () => { if (options().length) open(); }, { signal });
  list.addEventListener('mousedown', (e) => {
    const option = e.target.closest('[role="option"]');
    if (!option || !list.contains(option)) return;
    e.preventDefault();
    choose(options().indexOf(option));
  }, { signal });
  list.addEventListener('mousemove', (e) => {
    const option = e.target.closest('[role="option"]');
    if (!option) return;
    const i = options().indexOf(option);
    if (i !== active) mark(i);
  }, { signal });
}
