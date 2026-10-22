// The range-slider pattern (docs/design/enhancements.md, "Patterns";
// #245): Halo's dual-thumb track over a range's two number inputs
// (`dom::Param::<Span<u16>>::slider`). The inputs stay the wire: this
// hides their row when it mounts, writes both ends as a thumb moves,
// and commits with the inputs' own `change`, so the state form submits
// what it would without script. A moved range is closed at both ends
// (the low thumb at zero writes zero, as Halo's does), except that a
// scale whose top is open (`data-range-top-open`) leaves the high end
// empty when its thumb is at the top. The summary is rewritten from the
// templates the render declared; nothing here formats on its own.
export default function (root, signal) {
  const byId = (attr) => {
    const el = document.getElementById(root.getAttribute(attr));
    if (!el) throw new Error(`a range slider names a missing element (${attr})`);
    return el;
  };
  const from = byId('data-range-from');
  const to = byId('data-range-to');
  const ends = byId('data-range-ends');
  const said = document.getElementById(root.getAttribute('data-range-said'));
  const low = root.querySelector('[data-range-thumb="from"]');
  const high = root.querySelector('[data-range-thumb="to"]');
  const fill = root.querySelector('[data-range-fill]');
  const max = Number(high.max);
  const topOpen = root.hasAttribute('data-range-top-open');
  const says = root.getAttribute('data-range-says');
  const saysOpen = root.getAttribute('data-range-says-open');

  // Inline, so the row's own `display` cannot bring it back.
  ends.style.display = 'none';

  function paint() {
    const at = (thumb) => (max > 0 ? (Number(thumb.value) / max) * 100 : 0);
    if (fill) {
      fill.style.left = `${at(low)}%`;
      fill.style.right = `${100 - at(high)}%`;
    }
  }
  // The thumbs never cross: the one moving stops at the other.
  function hold(moved) {
    if (Number(low.value) > Number(high.value)) {
      if (moved === low) low.value = high.value;
      else high.value = low.value;
    }
  }
  function write() {
    const open = topOpen && Number(high.value) === max;
    from.value = low.value;
    to.value = open ? '' : high.value;
    if (said) said.textContent = (open ? saysOpen : says).replace('{from}', low.value).replace('{to}', high.value);
  }
  for (const thumb of [low, high]) {
    thumb.addEventListener('input', () => {
      hold(thumb);
      paint();
      write();
    }, { signal });
    // Released, or a key step done: the range is applied, as a typed
    // end is on its change.
    thumb.addEventListener('change', () => {
      write();
      to.dispatchEvent(new Event('change', { bubbles: true }));
    }, { signal });
  }
  paint();
}
