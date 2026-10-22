// Templates: the client's interpreter (`docs/design/templates.md`; the
// ruling is `docs/adr/0007-templates-are-views-of-state.md`). One generic
// interpreter, written once; no code is generated per template. It reads
// a program lowered by `dom::template` from the document and applies it
// to data the page carries. A pattern module of the shim's
// (`docs/design/enhancements.md`, "Patterns"): fetched on the first host
// or data island that carries `data-pattern="templates"`, and from then
// on watching the whole document, so `default` has nothing to do per
// element — the mount is the import.
//
// The server interprets the same program (`dom::template::Template::render`);
// the two faces are proven equal by the suite beside the example
// (`framework/dom/examples/templates/check.mjs`).
//
// The DOM is the instance. Nothing is kept per instance on this side: a
// fill finds each place it writes by its mark — a content place is the
// platform's `<?start name="…">`…`<?end>` range, an attribute place is
// `data-lt-at` on its element — compares with what the document holds and
// writes only what differs, and a range's content says which arm it holds
// (the arm's root carries its block's mark). So filling a fresh clone,
// updating a mounted instance and updating one the server rendered are
// one call, and an element whose data did not change keeps its focus,
// its selection and whatever was typed into it.
//
// The DOM is the model too. A keyed template's instances carry their
// record (`data-lt-key`, `data-lt-data`): the rows in a data node. A
// **lazy key** (`docs/adr/0007`, §1) names a row; its host is filled from
// the row and opened, or closed when the key is cleared. Invokers write
// keys as data; a URL-stored key rides the query, so the back button
// closes a dialog and a link's GET opens it without script.
const programs = new Map();
  const MARK = 'data-lt-at';

  // ---- Loading ---------------------------------------------------------

  // `<template data-lt="{name}" data-lt-ops="[…]">` holds one inner
  // `<template>` per block; each block's skeleton is its root element,
  // whose mark names the block.
  function load(root = document) {
    for (const t of root.querySelectorAll('template[data-lt]')) {
      const name = t.getAttribute('data-lt');
      if (programs.has(name)) continue;
      const blocks = [...t.content.children].map((b) => b.content.firstElementChild);
      const blockOf = new Map(blocks.map((b, i) => [b.getAttribute(MARK), i]));
      programs.set(name, {
        name,
        ops: JSON.parse(t.getAttribute('data-lt-ops')),
        blocks,
        blockOf,
        keyed: t.hasAttribute('data-lt-keyed') ? JSON.parse(t.getAttribute('data-lt-keyed')) : null,
      });
    }
  }

  function program(name) {
    if (!programs.has(name)) load();
    const p = programs.get(name);
    if (!p) throw new Error(`no template \`${name}\` is defined in this document`);
    return p;
  }

  // ---- Reading data ----------------------------------------------------

  // A read is [depth, field…]: which bound scope (0 the template's data,
  // then each `each`/`some` item), then field indexes.
  function read(env, r) {
    let v = env[r[0]];
    for (let i = 1; i < r.length; i++) v = v[r[i]];
    return v;
  }

  function text(env, parts) {
    let s = '';
    for (const p of parts) {
      if (typeof p === 'string') s += p;
      else if (p[0] === 0) s += String(read(env, p[1]));
      else if (p[0] === 1) s += p[2][read(env, p[1])];
      else if (p[0] === 2) s += String(read(env, p[1]).length);
      else s += JSON.stringify(read(env, p[1]));
    }
    return s;
  }

  function cond(env, c) {
    switch (c[0]) {
      case 0: return read(env, c[1]) === true;
      case 1: return !cond(env, c[1]);
      case 2: return c[1].every((x) => cond(env, x));
      case 3: return c[1].some((x) => cond(env, x));
      case 4: return read(env, c[1]) === c[2];
      case 5: return read(env, c[1]).length === 0;
      case 6: return read(env, c[1]) !== null;
    }
    throw new Error(`unknown condition ${c[0]}`);
  }

  // ---- Marks -----------------------------------------------------------

  // A range mark is a processing instruction, `<?start name="4">` or
  // `<?end>`, as the parser makes them where it knows the form — or the
  // bogus comment (`?start name="4"`) it makes where it does not. Both
  // survive `cloneNode` and `innerHTML`.
  const NAME = /name="([^"]*)"/;
  function mark(n) {
    if (n.nodeType === 7) {
      if (n.target === 'start') return ['start', (NAME.exec(n.data) || [])[1]];
      if (n.target === 'end') return ['end'];
      return null;
    }
    if (n.nodeType === 8) {
      if (n.data.startsWith('?start')) return ['start', (NAME.exec(n.data) || [])[1]];
      if (n.data.startsWith('?end')) return ['end'];
    }
    return null;
  }
  const isStart = (n) => (mark(n) || [])[0] === 'start';
  const isEnd = (n) => (mark(n) || [])[0] === 'end';

  // The end mark of the range this start opens; ranges nest, so count.
  function endOf(start) {
    let depth = 0;
    for (let n = start.nextSibling; n; n = n.nextSibling) {
      if (isStart(n)) depth++;
      else if (isEnd(n)) {
        if (depth === 0) return n;
        depth--;
      }
    }
    throw new Error('a range has no end: the document is not an instance of this template');
  }

  // Every place in one block's instance, by mark: marked elements and
  // range starts, not descending into a range (what it holds belongs to
  // another block, filled by its own call).
  function places(root, into = new Map()) {
    if (root.nodeType === 1 && root.hasAttribute(MARK)) into.set(root.getAttribute(MARK), root);
    for (let n = root.firstChild; n; n = n.nextSibling) {
      const m = mark(n);
      if (m && m[0] === 'start') {
        into.set(m[1], n);
        n = endOf(n);
      } else if (n.nodeType === 1) {
        places(n, into);
      }
    }
    return into;
  }

  // ---- Filling ---------------------------------------------------------

  function make(prog, b, env) {
    const el = prog.blocks[b].cloneNode(true);
    fill(prog, b, el, env);
    return el;
  }

  function fill(prog, b, el, env) {
    const at = places(el);
    const place = (id) => {
      const n = at.get(String(id));
      if (!n) throw new Error(`no place ${id}: the document is not an instance of this template`);
      return n;
    };
    for (const op of prog.ops[b]) {
      switch (op[0]) {
        case 0:
          setText(place(op[1]), text(env, op[2]));
          break;
        case 1: {
          const node = place(op[1]);
          const v = text(env, op[3]);
          if (node.getAttribute(op[2]) !== v) node.setAttribute(op[2], v);
          break;
        }
        case 2: {
          const node = place(op[1]);
          const v = cond(env, op[3]);
          if (node.hasAttribute(op[2]) !== v) node.toggleAttribute(op[2], v);
          break;
        }
        case 3:
          range(prog, place(op[1]), cond(env, op[2]) ? op[3] : op[4], env);
          break;
        case 4:
          list(prog, place(op[1]), read(env, op[2]), op[3], op[4], env);
          break;
        case 5: {
          const v = read(env, op[2]);
          if (v === null) range(prog, place(op[1]), op[4], env);
          else range(prog, place(op[1]), op[3], [...env, v]);
          break;
        }
        case 6:
          range(prog, place(op[1]), op[3][read(env, op[2])], env);
          break;
        case 7: {
          const node = place(op[1]);
          const v = text(env, op[2]);
          if (node.textContent !== v) node.textContent = v;
          break;
        }
        case 8:
          setPlace(place(op[1]), text(env, op[2]), text(env, op[3]));
          break;
        default:
          throw new Error(`unknown operation ${op[0]}`);
      }
    }
  }

  // A text hole: the text between its marks, replaced only when it differs.
  function setText(start, value) {
    const end = endOf(start);
    let have = '';
    for (let n = start.nextSibling; n !== end; n = n.nextSibling) have += n.nodeType === 3 ? n.data : '\u0000';
    if (have === value) return;
    for (let n = start.nextSibling; n !== end;) {
      const gone = n;
      n = n.nextSibling;
      gone.remove();
    }
    if (value !== '') start.parentNode.insertBefore(document.createTextNode(value), end);
  }

  // A place: inside the hole's range, a range named from the data (what
  // the shim's fills address — a form's message place for this row)
  // holding text. Rebuilt only when the name or the text differs; a
  // fill the shim landed between the inner marks stays until the data
  // says otherwise.
  function setPlace(start, name, value) {
    const end = endOf(start);
    const inner = start.nextSibling;
    if (inner && inner !== end && inner.nodeType === 7 && inner.target === 'start' && inner.data === `name="${name}"`) {
      const innerEnd = endOf(inner);
      let have = '';
      for (let n = inner.nextSibling; n !== innerEnd; n = n.nextSibling) have += n.nodeType === 3 ? n.data : '\u0000';
      if (have === value) return;
      for (let n = inner.nextSibling; n !== innerEnd;) {
        const gone = n;
        n = n.nextSibling;
        gone.remove();
      }
      if (value !== '') inner.parentNode.insertBefore(document.createTextNode(value), innerEnd);
      return;
    }
    for (let n = start.nextSibling; n !== end;) {
      const gone = n;
      n = n.nextSibling;
      gone.remove();
    }
    const parent = start.parentNode;
    parent.insertBefore(document.createProcessingInstruction('start', `name="${name}"`), end);
    if (value !== '') parent.insertBefore(document.createTextNode(value), end);
    parent.insertBefore(document.createProcessingInstruction('end', ''), end);
  }

  // The block a flow's range holds: its first element's root mark, or -1
  // when it holds nothing.
  function armOf(prog, start, end) {
    for (let n = start.nextSibling; n !== end; n = n.nextSibling) {
      if (n.nodeType === 1) {
        const b = prog.blockOf.get(n.getAttribute(MARK));
        return b === undefined ? -1 : b;
      }
    }
    return -1;
  }

  // A one-of range: the same arm is updated in place; another arm
  // replaces it.
  function range(prog, start, block, env) {
    const end = endOf(start);
    const was = armOf(prog, start, end);
    if (was === block) {
      if (block !== -1) fill(prog, block, start.nextSibling, env);
      return;
    }
    for (let n = start.nextSibling; n !== end;) {
      const gone = n;
      n = n.nextSibling;
      gone.remove();
    }
    if (block !== -1) start.parentNode.insertBefore(make(prog, block, env), end);
  }

  // A list range: items found by `data-lt-key`, updated in place, made
  // when new, removed when gone, and moved only when out of order —
  // with `moveBefore` where the browser has it, which keeps a moved row's
  // focus and state.
  function list(prog, start, items, keyRead, body, env) {
    const end = endOf(start);
    const parent = start.parentNode;
    const old = new Map();
    for (let n = start.nextSibling; n !== end; n = n.nextSibling) {
      if (n.nodeType === 1) old.set(n.getAttribute('data-lt-key'), n);
    }
    const seen = new Set();
    const next = items.map((item, i) => {
      const inner = [...env, item];
      const key = keyRead ? String(read(inner, keyRead)) : String(i);
      if (seen.has(key)) throw new Error(`two items share the key \`${key}\``);
      seen.add(key);
      let el = old.get(key);
      if (el) {
        old.delete(key);
        fill(prog, body, el, inner);
      } else {
        el = make(prog, body, inner);
        el.setAttribute('data-lt-key', key);
      }
      return el;
    });
    for (const gone of old.values()) gone.remove();
    let ref = end;
    for (let i = next.length - 1; i >= 0; i--) {
      const el = next[i];
      if (el.parentNode !== parent || el.nextSibling !== ref) place(parent, el, ref);
      ref = el;
    }
  }

  function place(parent, el, ref) {
    if (el.parentNode === parent && typeof parent.moveBefore === 'function') parent.moveBefore(el, ref);
    else parent.insertBefore(el, ref);
  }

  // ---- Instances of a template -----------------------------------------

  // An instance carries its record, as the server's render does (what a
  // module reads its args from), and a keyed template's instance its
  // node and key too: that is what a lazy key resolves against.
  function stamp(prog, el, data) {
    const json = JSON.stringify(data);
    if (el.getAttribute('data-lt-data') !== json) el.setAttribute('data-lt-data', json);
    if (!prog.keyed) return;
    const key = String(read([data], prog.keyed));
    if (el.getAttribute('data-lt-rows') !== prog.name) el.setAttribute('data-lt-rows', prog.name);
    if (el.getAttribute('data-lt-key') !== key) el.setAttribute('data-lt-key', key);
  }

  function instance(prog, data) {
    const el = make(prog, 0, [data]);
    stamp(prog, el, data);
    return el;
  }

  function update(prog, el, data) {
    fill(prog, 0, el, [data]);
    stamp(prog, el, data);
  }

  // Apply a template in a host (a dialog, a popover): its one element is
  // the instance, updated in place; an empty host gets one made.
  function apply(host, name, data) {
    if (host.getAttribute('data-lt-host') !== name) {
      throw new Error(`\`${name}\` is applied to an element that does not host it`);
    }
    const prog = program(name);
    const have = host.firstElementChild;
    const key = prog.keyed ? String(read([data], prog.keyed)) : null;
    // Another record in a keyed host is a fresh instance: nothing typed
    // for the last one survives into this one.
    if (have && (key === null || have.getAttribute('data-lt-key') === key)) {
      update(prog, have, data);
      return have;
    }
    const el = instance(prog, data);
    if (have) have.replaceWith(el);
    else host.append(el);
    return el;
  }

  // Rows as data (`<script type="application/json" data-lt-rows>`): land
  // them where the island stands — a window's rows before the re-armed
  // sentinel, a refreshed row in its own range — and drop the island. A
  // patch updates the row already in the list by its key, in place, so
  // the row keeps its element; a row with no match is made. A made row
  // stands in its own item range (`data-lt-ranges`, the region's base:
  // `{base}-{key}`), as the server's rows do, so a later fill can
  // address it.
  function land(island) {
    const prog = program(island.getAttribute('data-lt-rows'));
    if (!prog.keyed) throw new Error(`\`${prog.name}\` lands rows but declares no key`);
    const parent = island.parentNode;
    const patch = island.getAttribute('data-lt-landing') === 'patch';
    const ranges = island.getAttribute('data-lt-ranges');
    const byKey = new Map();
    if (patch) for (const el of parent.children) if (el.hasAttribute('data-lt-key')) byKey.set(el.getAttribute('data-lt-key'), el);
    for (const row of JSON.parse(island.textContent)) {
      const key = String(read([row], prog.keyed));
      const have = byKey.get(key);
      if (have) {
        update(prog, have, row);
        continue;
      }
      const el = instance(prog, row);
      if (ranges) {
        island.before(document.createProcessingInstruction('start', `name="${ranges}-${key}"`), el, document.createProcessingInstruction('end', ''));
      } else {
        island.before(el);
      }
    }
    island.remove();
  }

  // A patch island inside a fill: the row already in the range, updated
  // from the record — its element kept — in place of replacing the
  // range (`applyFill` asks before it replaces). `false` when the range
  // holds no instance of the template, so the fill lands as markup.
  function patchInRange(start, island) {
    const prog = program(island.getAttribute('data-lt-rows'));
    const rows = JSON.parse(island.textContent);
    if (rows.length !== 1) return false;
    const key = String(read([rows[0]], prog.keyed));
    let have = null;
    for (let n = start.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE && n.target === 'end') break;
      if (n.nodeType === 1 && n.getAttribute('data-lt-rows') === prog.name && n.getAttribute('data-lt-key') === key) { have = n; break; }
    }
    if (!have) return false;
    update(prog, have, rows[0]);
    return true;
  }

  function landAll(root = document) {
    for (const s of root.querySelectorAll('script[data-lt-rows]')) land(s);
  }

  // ---- Lazy keys -------------------------------------------------------

  // A host declares the key it views: `data-lt-lazy` (the key's name),
  // `data-lt-store` (url | transient), `data-lt-rows` (the data node's
  // name, which each of its rows carries), `data-lt-project` (the read
  // from a row to what the host's template takes).
  const lazies = new Map();

  function declare(root = document) {
    const hosts = root.nodeType === 1 && root.hasAttribute('data-lt-lazy') ? [root] : [];
    hosts.push(...root.querySelectorAll('[data-lt-lazy]'));
    for (const host of hosts) {
      const name = host.getAttribute('data-lt-lazy');
      let h = lazies.get(name);
      if (!h) {
        h = { name, store: host.getAttribute('data-lt-store'), rows: host.getAttribute('data-lt-rows'), project: JSON.parse(host.getAttribute('data-lt-project')), hosts: [], key: null };
        lazies.set(name, h);
      }
      if (h.hosts.includes(host)) continue;
      h.hosts.push(host);
      host.__ltClosing = 0;
      // The platform closing the host — Escape, light dismiss, a close
      // request — is a write of nothing. `toggle` is the one event a
      // dialog and a popover both fire on every close (Chrome 150 drops
      // a dialog's `close` after some reopenings); it is asynchronous, so
      // the runtime counts the closes it caused itself and lets those
      // pass: the key already says so.
      host.addEventListener('toggle', (e) => {
        if (e.newState !== 'closed') return;
        if (host.__ltClosing > 0) {
          host.__ltClosing--;
          return;
        }
        if (h.key !== null) write({ [name]: null }, null);
      });
    }
  }

  // The row the key names, in the node, projected to what the view reads.
  // The row a key names, wherever it stands: a keyed template's instance
  // or any element carrying a record of the node (`El::carries`).
  function resolve(h, key) {
    const row = document.querySelector(`[data-lt-rows="${CSS.escape(h.rows)}"][data-lt-key="${CSS.escape(key)}"][data-lt-data]`);
    return row ? read([JSON.parse(row.getAttribute('data-lt-data'))], h.project) : null;
  }

  function openHost(host, source) {
    if (host.tagName === 'DIALOG') {
      if (host.open) {
        if (host.matches(':modal')) return;
        // The server's collapse is an open, non-modal dialog; make it
        // modal. Dropping the attribute closes it with no event (where
        // `close()` would fire a stale `close` after the reopening).
        host.removeAttribute('open');
      }
      host.showModal();
    } else if (host.hasAttribute('popover') && !host.matches(':popover-open')) {
      host.showPopover(source ? { source } : undefined);
    }
  }

  function closeHost(host) {
    if (host.tagName === 'DIALOG') {
      if (!host.open) return;
      host.__ltClosing++;
      host.close();
    } else if (host.hasAttribute('popover') && host.matches(':popover-open')) {
      host.__ltClosing++;
      host.hidePopover();
    }
  }

  // Show the key's hosts what it says: filled for the row and open, or
  // closed. A URL key whose row is not on the page is the server's to
  // answer: navigate.
  function view(h, source) {
    for (const host of h.hosts) {
      if (h.key === null) {
        closeHost(host);
        continue;
      }
      const data = resolve(h, h.key);
      if (data === null) {
        if (h.store === 'url') {
          location.assign(location.href);
          return;
        }
        throw new Error(`no row \`${h.key}\` in the node \`${h.rows}\` for \`${h.name}\``);
      }
      apply(host, host.getAttribute('data-lt-host'), data);
      openHost(host, source);
    }
  }

  // A write of one or more keys: `{ hold: "7", menu: null }`. URL keys
  // mint one history entry for the write; every changed key's hosts are
  // shown the result.
  function write(changes, source) {
    const changed = [];
    for (const [name, key] of Object.entries(changes)) {
      const h = lazies.get(name);
      if (!h) throw new Error(`no lazy key \`${name}\` has a host in this document`);
      const next = key === null ? null : String(key);
      if (h.key === next) continue;
      h.key = next;
      changed.push(h);
    }
    if (changed.some((h) => h.store === 'url')) {
      const url = new URL(location.href);
      for (const h of changed) {
        if (h.store !== 'url') continue;
        if (h.key === null) url.searchParams.delete(h.name);
        else url.searchParams.set(h.name, h.key);
      }
      history.pushState(null, '', url);
    }
    for (const h of changed) view(h, source);
  }

  // The URL is the store of URL keys: on arrival (the server may already
  // have collapsed the host) and on every traversal.
  function fromUrl() {
    const params = new URLSearchParams(location.search);
    for (const h of lazies.values()) {
      if (h.store !== 'url') continue;
      const key = params.get(h.name);
      const open = h.hosts.some((host) => host.hasAttribute('open') || host.matches(':popover-open'));
      if (key === h.key && !(key !== null && !open) && !(key === null && open)) continue;
      h.key = key;
      view(h, null);
    }
  }

  // An invoker: a click writes what it carries. For a link that is the
  // same write as a query, the page answers instead of the server.
  document.addEventListener('click', (e) => {
    const w = e.target.closest('[data-lt-write]');
    if (!w || e.defaultPrevented) return;
    e.preventDefault();
    write(JSON.parse(w.getAttribute('data-lt-write')), w);
  });
  window.addEventListener('popstate', fromUrl);

  // A fill, a window or a refresh may bring definitions, rows and hosts
  // later.
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches('template[data-lt]') || n.querySelector('template[data-lt]')) load(n.parentNode || document);
      if (n.matches('script[data-lt-rows]')) land(n);
      else landAll(n);
      declare(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  load();
  landAll();
  declare();
  fromUrl();
  // For the equivalence suite and the demo: make an instance, or fill one.
  window.lazyTemplates = {
    load,
    make: (name, data) => instance(program(name), data),
    fill: (name, el, data) => update(program(name), el, data),
    apply,
    land,
    patchInRange,
    write,
    lazy: (name) => (lazies.get(name) || { key: null }).key,
  };

/// The pattern's mount: nothing per element — the module's own load above
/// watches the document — so a host or island entering or leaving the
/// page needs no bookkeeping here.
export default function (_el, _signal) {}
