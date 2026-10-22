// enhancements: cut from progressive.js for the bundling probe (#754).
import { patterns } from './registry.js';
import { applyLocalState } from './state.js';

// Enhancements (docs/design/enhancements.md): an app's own client
// behaviour over markup the server rendered, declared in Rust as the
// parts it is handed. A root carries `data-enhancement="{name}"`; its
// parts are the `[data-part]` elements whose nearest enhanced
// ancestor it is, the controls its
// `data-part-*` attributes name by id (which must be inside it), and
// the copy its `data-text-*` attributes carry. The module is
// `app/{name}` through the document's import map, fetched on the
// first root that needs it and cached for the session. Mounting runs
// the module's default export with the parts and an AbortSignal, and
// stamps `data-enhanced` for the sheet; unmounting aborts the signal.
// The lifecycle is the document's: one MutationObserver sees every
// root that enters or leaves, however it does — a fill, a swap, a
// module cloning a template — so nothing here knows how the DOM
// changed, and a plain element gets the connected/disconnected pair
// a custom element gets from the parser.
//
// Templates: the markup a module makes is a template of the kind
// `docs/design/templates.md` describes — one program, two interpreters
// — rendered by the server as its definition (`<template
// data-lt="{enhancement}-{field}">`) under the root. The module gets a
// function per template: the templates pattern's interpreter makes an
// instance from the args as a record, and back come the root and the
// instance's own `[data-part]` handles. An instance's parts are its
// own — `data-instance` on its root keeps them out of the
// enhancement's. An instance the render made carries its record
// (`data-lt-data`), so it is read back as one the module could have
// made.
const enhanced = new WeakMap();
function templates() {
  const lt = window.lazyTemplates;
  if (!lt) throw new Error('the templates pattern is not loaded: an enhancement with templates imports it before it mounts');
  return lt;
}
function argsOf(tpl, root) {
  const fields = (tpl.getAttribute('data-lt-fields') || '').split(' ').filter(Boolean);
  const data = root.hasAttribute('data-lt-data') ? JSON.parse(root.getAttribute('data-lt-data')) : [];
  const args = {};
  fields.forEach((f, i) => { args[f] = data[i] ?? ''; });
  return args;
}
function partsIn(root, instance) {
  for (const el of root.querySelectorAll('[data-part]')) {
    if (el.parentElement.closest('[data-instance],[data-enhancement]') !== root) continue;
    instance[el.getAttribute('data-part')] = el;
  }
  return instance;
}
function instantiate(tpl, args, name, key) {
  const fields = (tpl.getAttribute('data-lt-fields') || '').split(' ').filter(Boolean);
  const data = fields.map((f) => {
    if (!(f in args)) throw new Error(`the template \`${key}\` of \`${name}\` was instantiated without \`${f}\``);
    return String(args[f]);
  });
  const lt = templates();
  lt.load(tpl.parentElement || document);
  const root = lt.make(tpl.getAttribute('data-lt'), data);
  return partsIn(root, { root, args: { ...args } });
}
// An instance the render made (`Instances::instance`): its record rides
// `data-lt-data`, read back by the definition's field names.
function instanceOf(root, tpl) {
  return partsIn(root, { root, args: argsOf(tpl, root) });
}
// Items (`docs/design/enhancements.md`, "Items"): an `Items<T>` field
// is the instances of a template the enhancement holds, and the
// module gets moves on it — add, remove, clear — never an element to
// place. The root's `data-items` says what lands where
// (`held=pill@pills<typing`: instances of the `pill` template, in the
// `pills` part, before the `typing` part); the instances at mount are
// whatever the render placed. After every move the field's emptiness
// state (`{name}-{field}-empty`, local store) is applied within the
// root, and every mirror (`data-mirror-{part}="held.value"`, its
// separator beside it) is written: a part's value follows the
// collection, one arg per instance joined. A template part's declared
// click (`data-on="click:remove"`) is one delegated listener on the
// landing: the instance leaves. `chosen` hears the pattern governing
// the landing choose one (the listbox's `choose`, its detail the
// option), as the instance.
function itemsOf(root, parts, name, signal) {
  const spec = root.getAttribute('data-items');
  if (!spec) return;
  const named = (part) => {
    const el = parts[part];
    if (!(el instanceof Element)) throw new Error(`the items of \`${name}\` land in \`${part}\`, which is no element`);
    return el;
  };
  const mirrors = [];
  for (const a of root.attributes) {
    const m = a.name.match(/^data-mirror-(.+?)(-sep)?$/);
    if (!m || m[2]) continue;
    const [items, arg] = a.value.split('.');
    mirrors.push({ part: m[1], items, arg, sep: root.getAttribute(`${a.name}-sep`) ?? '' });
  }
  for (const entry of spec.split(' ')) {
    const m = entry.match(/^([a-z0-9_]+)=([a-z0-9_]+)@([a-z0-9_]+)(?:<([a-z0-9_]+))?$/);
    if (!m) throw new Error(`\`${name}\` carries an items stamp this shim does not read: ${entry}`);
    const [, field, template, landing, before] = m;
    const make = parts[template];
    if (typeof make !== 'function') throw new Error(`the items \`${field}\` of \`${name}\` instantiate \`${template}\`, which is no template`);
    const into = named(landing);
    const instances = [...into.querySelectorAll(`[data-instance="${template}"]`)]
      .filter((el) => el.parentElement.closest('[data-enhancement],[data-instance]') === root || el.parentElement === into)
      .map((el) => instanceOf(el, make.definition));
    const own = mirrors.filter((mirror) => mirror.items === field);
    const settle = () => {
      applyLocalState(root, `${name}-${field.replaceAll('_', '-')}-empty`, instances.length ? 'filled' : 'empty');
      for (const mirror of own) named(mirror.part).value = instances.map((i) => i.args[mirror.arg] ?? '').join(mirror.sep);
    };
    const remove = (instance) => {
      const i = instances.indexOf(instance);
      if (i < 0) return;
      instances.splice(i, 1);
      instance.root.remove();
      settle();
    };
    parts[field] = {
      get all() { return instances.slice(); },
      add(args) {
        const instance = make(args);
        into.insertBefore(instance.root, before ? named(before) : null);
        instances.push(instance);
        settle();
        return instance;
      },
      remove,
      clear() {
        for (const instance of instances.splice(0)) instance.root.remove();
        settle();
      },
      chosen(listener) {
        into.addEventListener('choose', (e) => {
          const instance = instances.find((i) => i.root === e.detail);
          if (instance) listener(instance);
        }, { signal });
      },
    };
    into.addEventListener('click', (e) => {
      const on = e.target.closest('[data-on]');
      if (!on || !into.contains(on)) return;
      if (on.getAttribute('data-on').split(' ').includes('click:remove')) {
        const instance = instances.find((i) => i.root.contains(on));
        if (instance) { e.stopPropagation(); remove(instance); }
      }
    }, { signal });
    settle();
  }
}
// Patterns (`docs/design/enhancements.md`, "Patterns"): a role with
// behaviour of its own, declared by the render (`data-pattern`), each
// its own module of the shim's — `pattern/{name}` through the import
// map — fetched on the first element that carries it. Mounted and
// unmounted like an enhancement root, inside one or not; inside one,
// before the module runs, so the module finds the pattern in place.
// The patterns the app's generated entry registered statically (`registry.js`);
// a pattern not registered is fetched through the import map as before.
function loadPattern(kind) {
  const registered = patterns.get(kind);
  return registered ? Promise.resolve(registered) : import(`pattern/${kind}`);
}
const patterned = new WeakMap();
function mountPattern(el) {
  if (patterned.has(el)) return patterned.get(el).mounted;
  const kind = el.getAttribute('data-pattern');
  const control = new AbortController();
  const mounted = loadPattern(kind).then((module) => {
    if (control.signal.aborted) return;
    module.default(el, control.signal);
  }).catch((e) => {
    patterned.delete(el);
    console.error(`the pattern \`${kind}\` did not mount:`, e);
  });
  patterned.set(el, { control, mounted });
  return mounted;
}
function unmountPattern(el) {
  const entry = patterned.get(el);
  if (!entry) return;
  patterned.delete(el);
  entry.control.abort();
}
function patternRoots(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const roots = [...node.querySelectorAll('[data-pattern]')];
  if (node.hasAttribute('data-pattern')) roots.unshift(node);
  return roots;
}
function partsOf(root) {
  const name = root.getAttribute('data-enhancement');
  const parts = {};
  for (const el of root.querySelectorAll('[data-part]')) {
    const owner = el.parentElement && el.parentElement.closest('[data-enhancement],[data-instance]');
    if (owner !== root) continue;
    const part = el.getAttribute('data-part');
    if (part in parts) throw new Error(`the part \`${part}\` of \`${name}\` is stamped on two elements under one root`);
    parts[part] = el;
  }
  for (const tpl of root.querySelectorAll('template[data-lt]')) {
    const owner = tpl.parentElement && tpl.parentElement.closest('[data-enhancement],[data-instance]');
    if (owner !== root) continue;
    const lt = tpl.getAttribute('data-lt');
    if (!lt.startsWith(`${name}-`)) throw new Error(`the template \`${lt}\` under \`${name}\` is not one of its own`);
    const key = lt.slice(name.length + 1);
    if (key in parts) throw new Error(`the template \`${key}\` of \`${name}\` shares its name with a part`);
    parts[key] = (args) => instantiate(tpl, args, name, key);
    parts[key].definition = tpl;
  }
  for (const a of root.attributes) {
    if (a.name.startsWith('data-part-')) {
      const part = a.name.slice('data-part-'.length);
      const el = document.getElementById(a.value);
      if (!el) throw new Error(`the part \`${part}\` of \`${name}\` names #${a.value}, which is not in the document`);
      if (!root.contains(el)) throw new Error(`the part \`${part}\` of \`${name}\` (#${a.value}) is outside its root`);
      parts[part] = el;
    } else if (a.name.startsWith('data-text-')) {
      parts[a.name.slice('data-text-'.length)] = a.value;
    } else if (a.name.startsWith('data-state-')) {
      // A `State<T>` field (`docs/design/enhancements.md`, "State"):
      // its value at rest is the render's; `set` is its one move,
      // applied within this root as the items' emptiness is.
      const field = a.name.slice('data-state-'.length);
      const state = `${name}-${field.replaceAll('_', '-')}`;
      let current = a.value;
      parts[field] = {
        get value() { return current; },
        set(value) { current = value; applyLocalState(root, state, value); },
      };
    }
  }
  return parts;
}
// The first-party verbs, performed before the module runs so it works
// on the swapped document and knows nothing of the no-JS one: a plain
// part is hidden (it still posts); a stand-in takes a wire's place as
// the field's control — its labels, its message place, `required`,
// `placeholder`, `autofocus` (so a dialog opened later lands on the
// stand-in, not on a hidden wire), and focus if it had it. A live part
// is the sheet's (`[data-live]`, shown under `data-enhanced`).
function standIn(stand, wire) {
  if (!stand.id) stand.id = `${wire.id}-stand-in`;
  const labels = [...(wire.labels ?? [])];
  for (const label of labels) label.htmlFor = stand.id;
  if (labels.length) stand.removeAttribute('aria-label');
  for (const a of ['aria-errormessage', 'aria-describedby', 'aria-invalid']) {
    const v = wire.getAttribute(a);
    if (v !== null) { stand.setAttribute(a, v); wire.removeAttribute(a); }
  }
  if (wire.required) { stand.required = true; wire.required = false; }
  if (wire.placeholder && !stand.placeholder) stand.placeholder = wire.placeholder;
  if (wire.hasAttribute('autofocus')) { stand.setAttribute('autofocus', ''); wire.removeAttribute('autofocus'); }
  if (document.activeElement === wire) stand.focus();
}
function performVerbs(root, parts, name) {
  const named = (part) => {
    const el = parts[part];
    if (!(el instanceof Element)) throw new Error(`the verb on \`${part}\` of \`${name}\` names no element`);
    return el;
  };
  const plain = root.getAttribute('data-plain');
  if (plain) for (const part of plain.split(' ')) named(part).hidden = true;
  const stands = root.getAttribute('data-stands-in');
  if (stands) for (const pair of stands.split(' ')) {
    const [stand, wire] = pair.split('=');
    standIn(named(stand), named(wire));
  }
}
function mountEnhancement(root) {
  if (enhanced.has(root)) return;
  const name = root.getAttribute('data-enhancement');
  const control = new AbortController();
  enhanced.set(root, control);
  // An enhancement with templates needs their interpreter (the
  // templates pattern) before its module runs.
  const needs = root.querySelector('template[data-lt]') ? [loadPattern('templates')] : [];
  Promise.all([import(`app/${name}`), ...needs, ...patternRoots(root).map(mountPattern)]).then(([module]) => {
    if (control.signal.aborted) return;
    const parts = partsOf(root);
    performVerbs(root, parts, name);
    itemsOf(root, parts, name, control.signal);
    module.default(parts, { signal: control.signal });
    root.setAttribute('data-enhanced', '');
  }).catch((e) => {
    enhanced.delete(root);
    console.error(`the enhancement \`${name}\` did not mount:`, e);
  });
}
function unmountEnhancement(root) {
  const control = enhanced.get(root);
  if (!control) return;
  enhanced.delete(root);
  root.removeAttribute('data-enhanced');
  control.abort();
}
function enhancementRoots(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const roots = [...node.querySelectorAll('[data-enhancement]')];
  if (node.hasAttribute('data-enhancement')) roots.unshift(node);
  return roots;
}
new MutationObserver((records) => {
  for (const r of records) {
    for (const n of r.removedNodes) {
      for (const root of enhancementRoots(n)) if (!root.isConnected) unmountEnhancement(root);
      for (const el of patternRoots(n)) if (!el.isConnected) unmountPattern(el);
    }
    for (const n of r.addedNodes) {
      for (const root of enhancementRoots(n)) if (root.isConnected) mountEnhancement(root);
      for (const el of patternRoots(n)) if (el.isConnected) mountPattern(el);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
for (const root of enhancementRoots(document.documentElement)) mountEnhancement(root);
for (const el of patternRoots(document.documentElement)) mountPattern(el);
