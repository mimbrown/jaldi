// The preview pattern (docs/design/client_rust.md): a form whose rules
// are the server's own Rust, compiled to wasm, says what the server would
// say of it before it is posted. The render declared it (`data-pattern`
// on the form element of a previewed form, `#[previews(module = …)]`)
// beside a preload of the module, so the fetch is under way as the page
// parses. The module is the app's values crate: one export to call,
// `submit(form, body)`, over the urlencoded bytes the form would POST,
// answering the refusal the server would render. No copy and no rule
// lives here: this file moves bytes and writes what came back into the
// message places the render already demanded.
//
// It previews and never decides. The POST goes as it always did, the
// server parses and checks it again, and Postgres gates the write; with
// the module absent or failing to load, the form is the form it was.
//
// When: on `change` (the person finished with a field), and on `input`,
// debounced, while that field shows a message, so a fix is seen as it is
// typed. And on `input`, debounced, the field's mask (#676): what the
// server's parse would print of the text, shown in the field's place
// while it says no message, never written into the control. Only fields the person has touched are spoken for: an untouched
// required field is not refused while its neighbour is being filled.
// After `accepted` nothing is touched again.

const modules = new Map();

// One instance per document per module, whatever forms share it.
function load(url) {
  if (!modules.has(url)) {
    modules.set(url, WebAssembly.instantiateStreaming(fetch(url), {}).then(
      (r) => r.instance,
      (e) => {
        console.warn('the form rules module did not load; forms are checked on submit only:', e);
        return null;
      },
    ));
  }
  return modules.get(url);
}

// The boundary: the form's wire name and its body in, the answer out
// (`values::preview::Answer::encode`). `alloc` takes room for both, the
// answer is read before `free` resets the module's arena.
export function call(instance, form, body) {
  const { memory, alloc, submit, free } = instance.exports;
  const encoder = new TextEncoder();
  const f = encoder.encode(form);
  const b = encoder.encode(body);
  try {
    const ptr = alloc(f.length + b.length);
    // Read the buffer after `alloc`: growing memory detaches the old one.
    new Uint8Array(memory.buffer, ptr, f.length).set(f);
    new Uint8Array(memory.buffer, ptr + f.length, b.length).set(b);
    const packed = submit(ptr, f.length, b.length);
    const at = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    return new TextDecoder().decode(new Uint8Array(memory.buffer, at, len).slice());
  } finally {
    free();
  }
}

// One field's print-of-parse (#676): the form's wire name, the field's
// and the text as typed in, `values::preview::Mask::encode` out — a kind
// byte, `0` followed by the printed text, `1` nothing to show, `2` does
// not parse, `3` no such form or field.
export function callMask(instance, form, field, raw) {
  const { memory, alloc, mask, free } = instance.exports;
  if (!mask) return '3';
  const encoder = new TextEncoder();
  const f = encoder.encode(form);
  const n = encoder.encode(field);
  const r = encoder.encode(raw);
  try {
    const ptr = alloc(f.length + n.length + r.length);
    new Uint8Array(memory.buffer, ptr, f.length).set(f);
    new Uint8Array(memory.buffer, ptr + f.length, n.length).set(n);
    new Uint8Array(memory.buffer, ptr + f.length + n.length, r.length).set(r);
    const packed = mask(ptr, f.length, n.length, r.length);
    const at = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    return new TextDecoder().decode(new Uint8Array(memory.buffer, at, len).slice());
  } finally {
    free();
  }
}

const KINDS = { 0: 'clear', 1: 'refused', 2: 'unknown', 3: 'forged' };

// The answer's fixed encoding: a kind byte, then for a refusal one
// record (U+001E) per message, the field's name and the message split by
// U+001F, an empty name for the form's own.
export function decode(answer) {
  const kind = KINDS[answer[0]] ?? 'unknown';
  const fields = new Map();
  let form = null;
  if (kind === 'refused') {
    for (const record of answer.slice(1).split('\u001e').slice(1)) {
      const cut = record.indexOf('\u001f');
      const name = record.slice(0, cut);
      const message = record.slice(cut + 1);
      if (name === '') form = message;
      else if (!fields.has(name)) fields.set(name, message);
    }
  }
  return { kind, fields, form };
}

// The body a submission would post: the form's entries with its default
// button as the submitter, urlencoded as the shim's POST encodes them.
export function body(form) {
  const submitter = [...form.elements].find((el) => el.type === 'submit') ?? null;
  return new URLSearchParams(new FormData(form, submitter)).toString();
}

// Whether a place says a message: its own text, not a mask.
function saysMessage(place) {
  return [...place.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
}

// A mask in a place that says no message: what the server would make of
// the text, shown beside it (`data-mask`, styled by `dom::sel::masked`),
// or nothing. A message, when one comes, replaces it (`say`).
function show(place, text) {
  if (saysMessage(place)) return;
  for (const n of [...place.querySelectorAll('[data-mask]')]) n.remove();
  if (!text) return;
  const end = [...place.childNodes].find((n) => n.nodeType === Node.PROCESSING_INSTRUCTION_NODE && n.target === 'end');
  const mask = document.createElement('span');
  mask.setAttribute('data-mask', '');
  mask.textContent = text;
  place.insertBefore(mask, end ?? null);
}

// A message place's text, its range markers kept.
function say(place, text) {
  const end = [...place.childNodes].find((n) => n.nodeType === Node.PROCESSING_INSTRUCTION_NODE && n.target === 'end');
  for (const n of [...place.childNodes]) {
    if (n.nodeType !== Node.PROCESSING_INSTRUCTION_NODE) place.removeChild(n);
  }
  if (text) place.insertBefore(document.createTextNode(text), end ?? null);
}

const DEBOUNCE_MS = 250;

export default function (form, signal) {
  const link = form.querySelector('link[rel="preload"][type="application/wasm"]');
  const disc = form.querySelector('input[name="__form"]');
  if (!link || !disc) return;
  const name = disc.value;
  const touched = new Set();
  let timer = 0;

  // The controls whose places this form owns: each control's
  // `aria-errormessage` target, whether it sits in the form or names it.
  function places() {
    const controls = form.id
      ? document.querySelectorAll(`[form="${CSS.escape(form.id)}"][aria-errormessage], #${CSS.escape(form.id)} [aria-errormessage]`)
      : form.querySelectorAll('[aria-errormessage]');
    const out = [];
    for (const control of controls) {
      const place = document.getElementById(control.getAttribute('aria-errormessage'));
      if (place && control.name) out.push({ control, place });
    }
    return out;
  }
  const formPlace = () => {
    const id = form.getAttribute('data-refusal');
    return id ? document.getElementById(id) : null;
  };
  let saidForm = false;

  async function preview() {
    const instance = await load(link.href);
    if (!instance || signal.aborted || !form.isConnected) return;
    let answer;
    try {
      answer = decode(call(instance, name, body(form)));
    } catch (e) {
      console.warn('the form rules module failed; this form is checked on submit only:', e);
      return;
    }
    // A form the module does not know, or a body the server would take
    // for forged: the preview has nothing to say.
    if (answer.kind === 'unknown' || answer.kind === 'forged') return;
    for (const { control, place } of places()) {
      if (!touched.has(control.name)) continue;
      const message = answer.fields.get(control.name) ?? '';
      say(place, message);
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    }
    const own = formPlace();
    if (own && (answer.form || saidForm)) {
      say(own, answer.form ?? '');
      saidForm = Boolean(answer.form);
    }
  }

  // The print-of-parse of the control being typed in (#676), shown only
  // where it differs from what was typed — the parse changing the text is
  // what a person needs to see — and never written into the control.
  let maskTimer = 0;
  async function masked(control) {
    const instance = await load(link.href);
    if (!instance || signal.aborted || !form.isConnected) return;
    const found = places().find((p) => p.control === control);
    if (!found) return;
    let answer;
    try {
      answer = callMask(instance, name, control.name, control.value);
    } catch (e) {
      console.warn('the form rules module failed; masks are off for this form:', e);
      return;
    }
    const printed = answer[0] === '0' ? answer.slice(1) : '';
    show(found.place, printed && printed !== control.value.trim() ? printed : '');
  }

  const ours = (e) => e.target && e.target.form === form && e.target.name && e.target.name !== '__form';
  document.addEventListener('change', (e) => {
    if (!ours(e)) return;
    clearTimeout(timer);
    touched.add(e.target.name);
    preview();
  }, { signal });
  document.addEventListener('input', (e) => {
    if (!ours(e)) return;
    const control = e.target;
    clearTimeout(maskTimer);
    if (typeof control.value === 'string') maskTimer = setTimeout(() => masked(control), DEBOUNCE_MS);
    const showing = places().some(({ control, place }) => control.name === e.target.name && saysMessage(place));
    if (!showing) return;
    touched.add(e.target.name);
    clearTimeout(timer);
    timer = setTimeout(preview, DEBOUNCE_MS);
  }, { signal });
  document.addEventListener('accepted', (e) => {
    if (e.detail && e.detail.form === form) {
      touched.clear();
      saidForm = false;
    }
  }, { signal });
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    clearTimeout(maskTimer);
  });
  // Started now, so the module is compiled by the first change.
  load(link.href);
}
