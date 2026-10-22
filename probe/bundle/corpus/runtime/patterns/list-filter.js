// The list-filter pattern (docs/design/enhancements.md, "Patterns"; #63):
// a search box that narrows a list already on the page — Halo's
// searchable dropdown over a long vocabulary. The render declared it
// (`html::list_filter`): an unnamed `type="search"` input whose
// `aria-controls` names the list; the shim imports this module on the
// first such input it sees and calls `default(input, signal)` once per
// input, the signal aborted when the input leaves the document. What is
// here is the pattern's behaviour and nothing of any app's: each item of
// the list (an `li`, or a `label` of a group: `dom::Chooses`) whose text does not contain the typed text (ignoring case and
// surrounding space) is hidden, the rest shown; Enter submits nothing.
// It writes `hidden` on the list's items and nothing else — no box is
// ticked or unticked, so a hidden pick is still a pick.
export default function (input, signal) {
  const list = document.getElementById(input.getAttribute('aria-controls'));
  if (!list) throw new Error('a list filter names a list that is not in the document');
  function apply() {
    const needle = input.value.trim().toLocaleLowerCase();
    for (const li of list.children) {
      if (li.tagName !== 'LI' && li.tagName !== 'LABEL') continue;
      li.hidden = needle !== '' && !li.textContent.toLocaleLowerCase().includes(needle);
    }
  }
  input.addEventListener('input', apply, { signal });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  }, { signal });
  // A re-render may have kept the typed text (a restored page).
  apply();
}
