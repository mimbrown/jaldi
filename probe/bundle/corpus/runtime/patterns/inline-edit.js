// The inline-edit pattern (docs/design/enhancements.md, "Patterns";
// #433): a value on the page that is edited where it stands. The render
// declared it (`html::inline_editor`): a popover holding one form's
// control, its submit and its dismiss, opened by the value itself (a
// button whose `popovertarget` names it) and laid by the sheet over the
// value, so the text being edited sits where the text was and nothing
// on the page moves. The platform does most of it with no script: the
// value opens the popover, Enter or the submit posts the form, Escape
// and a click elsewhere close it. What is here is the rest, and nothing
// of any app's:
//
// * Opening puts the caret in the first control with its text selected,
//   or, when that control is a list, opens its picker: entering the
//   editor is choosing. A list that is the editor's only control saves
//   as soon as a row is picked.
//   An editor may hold several controls of one form (a name's first and
//   last); what follows reads them all.
// * Closing decides: Escape or the dismiss (any button that hides this
//   popover) puts the control back to what it opened on; any other
//   close — a click elsewhere, another popover opening — submits the
//   form when the control was changed (Halo's save on blur, §6.5).
// * A refusal opens it again: the shim marks the control `aria-invalid`
//   or fills the form's own message place, both inside the popover, and
//   the person sees the message beside what they typed.
// * An accepted write closes it, the control now holding what it holds.
export default function (pop, signal) {
  const controls = [...pop.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select')];
  const control = controls[0];
  const submit = pop.querySelector('button[type="submit"]');
  if (!control || !submit) {
    throw new Error('an inline editor holds no control or no submit');
  }
  const form = control.form;
  let cancelled = false;

  function restore() {
    for (const c of controls) {
      if (c instanceof HTMLSelectElement) {
        for (const o of c.options) o.selected = o.defaultSelected;
      } else {
        c.value = c.defaultValue;
      }
    }
  }
  function changed() {
    return controls.some((c) => c instanceof HTMLSelectElement
      ? [...c.options].some((o) => o.selected !== o.defaultSelected)
      : c.value !== c.defaultValue);
  }

  pop.addEventListener('toggle', (e) => {
    if (e.newState === 'open') {
      cancelled = false;
      control.focus();
      if (control instanceof HTMLSelectElement) {
        // The opening press is still the person's gesture, so the
        // picker may open; where it may not, the focused list waits.
        try { control.showPicker(); } catch { /* not allowed now */ }
      } else if (typeof control.select === 'function') {
        control.select();
      }
      return;
    }
    if (cancelled) {
      restore();
    } else if (changed() && form && pop.isConnected) {
      form.requestSubmit(submit);
    }
    cancelled = false;
  }, { signal });

  if (controls.length === 1 && control instanceof HTMLSelectElement) {
    control.addEventListener('change', () => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    }, { signal });
  }

  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelled = true;
  }, { signal });
  for (const b of pop.querySelectorAll('button[popovertargetaction="hide"]')) {
    b.addEventListener('click', () => { cancelled = true; }, { signal });
  }

  // A refusal's marks land inside the popover; show them.
  function refused() {
    if (controls.some((c) => c.getAttribute('aria-invalid') === 'true')) return true;
    return [...pop.querySelectorAll('[data-refusal-place]')].some((p) => p.textContent.trim() !== '');
  }
  const watch = new MutationObserver(() => {
    if (refused() && !pop.matches(':popover-open')) pop.showPopover();
  });
  watch.observe(pop, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-invalid'] });
  signal.addEventListener('abort', () => watch.disconnect());

  document.addEventListener('accepted', (e) => {
    if (e.detail.form !== form) return;
    for (const c of controls) {
      if (c instanceof HTMLSelectElement) {
        for (const o of c.options) o.defaultSelected = o.selected;
      } else {
        c.defaultValue = c.value;
      }
    }
    if (pop.matches(':popover-open')) pop.hidePopover();
  }, { signal });
}
