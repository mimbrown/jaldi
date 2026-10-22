// The inline-toggle pattern (docs/design/enhancements.md, "Patterns";
// #433): a box on the page that is its own write. The render declared
// it (`html::inline_toggle`): a span around one form's checkbox or
// radios, shown where the value is read. A change submits the form the
// control belongs to — there is nothing to confirm, so there is no
// popover and no check or cross. The form's own submit is elsewhere or
// nowhere: `requestSubmit()` with no submitter, so the shim's navigate
// carries it like any post.
export default function (root, signal) {
  root.addEventListener('change', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.form) return;
    box.form.requestSubmit();
  }, { signal });
}
