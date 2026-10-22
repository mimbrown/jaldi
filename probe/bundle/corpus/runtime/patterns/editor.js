// The editor pattern (docs/design/forms.md, "Rich text"; #271): a rich
// text field's control, over ProseMirror (vendored, `vendor/prosemirror`).
// The render declared it (`dom::RichEditor`): a root holding the text
// drawn (`[data-editor-content]`) and the field's wire, a hidden
// `<textarea>` of the stored text. The shim imports this module on the
// first such root and calls `default(root, signal)` once per root.
//
// What is here is the pattern's and nothing of any app's:
//
// * **The vocabulary is closed**, and is `dom::markdown`'s: paragraphs,
//   bullet lists, bold, italic, code, links, and named rows. The schema
//   below can hold nothing else, so nothing else can be typed, pasted or
//   posted.
// * **It takes over in place.** The document is parsed from the drawn
//   content, so the editor arriving swaps nothing.
// * **The wire is the form's.** Every change writes the stored text into
//   the textarea (`serialize`), which the form posts like any field; the
//   server parses it and admits each named row or refuses (`text::Posted`).
// * **It makes no markup of a row.** A named row is an element the page
//   drew: in the content at rest, or carried by the offer that names it
//   (`html::offer`, `data-chip`). A pasted row is kept only if this page
//   knows it, and then as this page draws it.
import {
  Schema, DOMParser, EditorState, TextSelection, EditorView, baseKeymap, toggleMark, chainCommands,
  keymap, history, undo, redo, inputRules, wrappingInputRule, InputRule, splitListItem, liftListItem,
} from 'vendor/prosemirror';

// The rows this page can draw, by `table:key`: the chip markup of each.
// Module-wide: an offer anywhere on the page teaches every editor.
const known = new Map();

function chip(ref) {
  const span = document.createElement('span');
  span.setAttribute('data-named', ref);
  span.contentEditable = 'false';
  span.innerHTML = known.get(ref) ?? '';
  return span;
}

function buildSchema() {
  // One mark at a time: the subset nests nothing inside a mark.
  const mark = (tags, tag, extra = {}) => ({
    excludes: '_',
    parseDOM: tags.map((t) => ({ tag: t })),
    toDOM: () => [tag, 0],
    ...extra,
  });
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
      bullet_list: { group: 'block', content: 'list_item+', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
      list_item: { content: 'paragraph', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
      text: { group: 'inline' },
      named: {
        group: 'inline',
        inline: true,
        atom: true,
        selectable: true,
        attrs: { ref: {} },
        // Only a row this page draws: anything else (a paste from
        // another page) is read as its text.
        parseDOM: [{
          tag: 'span[data-named]',
          getAttrs: (el) => {
            const ref = el.getAttribute('data-named');
            return known.has(ref) ? { ref } : false;
          },
        }],
        toDOM: (node) => chip(node.attrs.ref),
      },
    },
    marks: {
      strong: mark(['strong', 'b'], 'strong'),
      em: mark(['em', 'i'], 'em'),
      code: mark(['code'], 'code'),
      link: {
        excludes: '_',
        inclusive: false,
        attrs: { href: {} },
        parseDOM: [{
          tag: 'a[href]',
          getAttrs: (el) => (/^(https?:\/\/|mailto:)/i.test(el.getAttribute('href')) ? { href: el.getAttribute('href') } : false),
        }],
        toDOM: (m) => ['a', { href: m.attrs.href, target: '_blank', rel: 'noopener noreferrer' }, 0],
      },
    },
  });
}
let schema;

// Text shaped like a naming token stays text: one backslash after its
// `@`, as `framework::text::RichBuilder::text` writes it.
const TOKEN_SHAPED = /@(\\*)(\[[a-z][a-z0-9_]*:[0-9]+\])/g;
function inline(node, oneLine) {
  let out = '';
  node.forEach((child) => {
    if (child.type === schema.nodes.named) {
      out += `@[${child.attrs.ref}]`;
      return;
    }
    let text = child.text.replace(TOKEN_SHAPED, '@\\$1$2');
    if (oneLine) text = text.replace(/\n/g, ' ');
    const m = child.marks[0];
    if (!m || text.trim() === '') out += text;
    else if (m.type === schema.marks.strong) out += `**${text}**`;
    else if (m.type === schema.marks.em) out += `*${text}*`;
    else if (m.type === schema.marks.code) out += `\`${text}\``;
    else out += `[${text}](${m.attrs.href})`;
  });
  return out;
}

// The stored text: `dom::markdown`'s source, the inverse of its render.
function serialize(doc) {
  const blocks = [];
  doc.forEach((block) => {
    if (block.type === schema.nodes.paragraph) {
      const text = inline(block, false);
      if (text.trim() !== '') blocks.push(text);
    } else {
      const items = [];
      block.forEach((item) => items.push(`- ${inline(item.firstChild, true)}`));
      blocks.push(items.join('\n'));
    }
  });
  return blocks.join('\n\n');
}

// `**bold**`, `*italic*`, `` `code` `` as they are typed: the closing
// mark turns the run into the mark.
function markRule(pattern, type) {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[2];
    if (!text) return null;
    const from = start + match[1].length;
    return state.tr.replaceWith(from, end, schema.text(text, [type.create()])).removeStoredMark(type);
  });
}

// The editor a list of offers was opened for: by a typed character
// (`from` is where it sits, so the pick replaces it) or by a summoner
// button (`from` is null: the pick goes at the caret).
let summoned = null;
const views = new WeakMap();

function nameRow(view, ref, from) {
  const node = schema.nodes.named.create({ ref });
  const { state } = view;
  let tr = state.tr;
  if (from !== null && state.doc.textBetween(from, Math.min(from + 1, state.doc.content.size)) !== '') {
    tr = tr.replaceWith(from, from + 1, node);
  } else {
    tr = tr.replaceSelectionWith(node);
  }
  // A space after, so the next word does not run into the row.
  tr = tr.insertText(' ');
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// Show or put away a revealable part, and say so on its revealers.
function reveal(part, show) {
  part.hidden = !show;
  for (const button of document.querySelectorAll(`[data-reveals="${CSS.escape(part.id)}"]`)) {
    button.setAttribute('aria-expanded', show ? 'true' : 'false');
  }
  if (!show) return;
  const view = views.get(part.querySelector('[data-pattern="editor"]'));
  if (!view) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  view.focus();
}

function visibleOffers(list) {
  return [...list.querySelectorAll('[data-offer]')].filter((b) => !b.closest('[hidden]'));
}

function openList(list, root, view, from) {
  summoned = { view, from, picked: false };
  const search = list.querySelector('input[type="search"]');
  if (search) {
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  }
  list.showPopover({ source: root });
  (search ?? visibleOffers(list)[0])?.focus();
}

// One listener each for the whole document, added once: offers and
// summoners are the page's, not any one editor's.
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('click', (e) => {
    // A revealer shows the part it names and puts the caret at the end
    // of the editor in it; pressed again, it puts the part away.
    const revealer = e.target.closest?.('[data-reveals]');
    if (revealer) {
      const part = document.getElementById(revealer.getAttribute('data-reveals'));
      // A revealer in a menu closes the menu it was picked from.
      revealer.closest('[popover]')?.hidePopover();
      if (part) reveal(part, part.hidden);
      return;
    }
    const summon = e.target.closest?.('[data-summon]');
    if (summon) {
      const root = document.getElementById(summon.getAttribute('data-editor'));
      const list = document.getElementById(summon.getAttribute('data-summon'));
      const view = root && views.get(root);
      if (view && list) openList(list, root, view, null);
      return;
    }
    const offer = e.target.closest?.('[data-offer]');
    if (!offer) return;
    const ref = offer.getAttribute('data-offer');
    known.set(ref, offer.getAttribute('data-chip'));
    const beside = offer.getAttribute('data-editor');
    if (beside) {
      const view = views.get(document.getElementById(beside));
      if (view) nameRow(view, ref, null);
      return;
    }
    if (!summoned) return;
    const { view, from } = summoned;
    summoned.picked = true;
    offer.closest('[popover]')?.hidePopover();
    nameRow(view, ref, from);
  });
  // In an open list: the arrows walk the offers still shown, Enter in
  // the search box takes the first, and typing goes back to the box.
  document.addEventListener('keydown', (e) => {
    const list = e.target.closest?.('[popover]');
    if (!list || !summoned || !list.querySelector('[data-offer]')) return;
    const offers = visibleOffers(list);
    const at = offers.indexOf(document.activeElement);
    const search = list.querySelector('input[type="search"]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (offers.length === 0) return;
      const next = e.key === 'ArrowDown' ? (at + 1) % offers.length : (at <= 0 ? offers.length : at) - 1;
      offers[next].focus();
    } else if (e.key === 'Enter' && e.target === search) {
      e.preventDefault();
      offers[0]?.click();
    } else if (search && e.target !== search && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      search.focus();
    }
  });
  // A list closed without a pick gives the keyboard back to its editor.
  document.addEventListener('toggle', (e) => {
    if (e.newState !== 'closed' || !summoned || !e.target.querySelector?.('[data-offer]')) return;
    const { view, picked } = summoned;
    summoned = null;
    if (!picked) view.focus();
  }, true);
}

export default function (root, signal) {
  const content = root.querySelector('[data-editor-content]');
  const wire = root.querySelector('textarea');
  if (!content || !wire) throw new Error('an editor root holds its drawn content and its wire');
  // Every row the page already draws: in this content, and on offers.
  for (const el of content.querySelectorAll('span[data-named]')) known.set(el.getAttribute('data-named'), el.innerHTML);
  for (const el of document.querySelectorAll('[data-offer]')) known.set(el.getAttribute('data-offer'), el.getAttribute('data-chip'));
  schema ??= buildSchema();
  listen();

  // The characters that open a list, and the list each opens.
  const summons = new Map();
  for (const entry of (root.getAttribute('data-summons') ?? '').split(' ').filter(Boolean)) {
    summons.set(entry[0], entry.slice(1));
  }

  const list = (command) => chainCommands(command, () => false);
  const view = new EditorView({ mount: content }, {
    state: EditorState.create({
      doc: DOMParser.fromSchema(schema).parse(content, { preserveWhitespace: 'full' }),
      plugins: [
        inputRules({
          rules: [
            wrappingInputRule(/^\s*[-*]\s$/, schema.nodes.bullet_list),
            markRule(/(^|[^*])\*\*([^*]+)\*\*$/, schema.marks.strong),
            markRule(/(^|[^*])\*([^*\n]+)\*$/, schema.marks.em),
            markRule(/()`([^`\n]+)`$/, schema.marks.code),
          ],
        }),
        keymap({
          'Mod-b': toggleMark(schema.marks.strong),
          'Mod-i': toggleMark(schema.marks.em),
          'Mod-e': toggleMark(schema.marks.code),
          'Mod-z': undo,
          'Shift-Mod-z': redo,
          'Mod-y': redo,
          Enter: list(splitListItem(schema.nodes.list_item)),
          'Shift-Tab': liftListItem(schema.nodes.list_item),
          // A line break inside a paragraph is the paragraph's own; a
          // list item is one line.
          'Shift-Enter': (state, dispatch) => {
            if (state.selection.$from.node(-1)?.type === schema.nodes.list_item) return true;
            if (dispatch) dispatch(state.tr.insertText('\n').scrollIntoView());
            return true;
          },
          // Escape clears what is written, where the form offers a
          // clear (a reset button of its own): the same act, from the
          // keyboard, and one undo brings the words back. Elsewhere the
          // key is whoever's is next (a dialog closing).
          Escape: (state) => {
            const form = wire.form;
            if (!form) return false;
            // In a revealed part the key puts the part away, written in
            // or not.
            if (root.closest('[data-revealable]')) {
              form.reset();
              return true;
            }
            if (serialize(state.doc) === '') return false;
            if (!document.querySelector(`[type="reset"][form="${CSS.escape(form.id)}"]`) && !form.querySelector('[type="reset"]')) return false;
            form.reset();
            return true;
          },
          // The form's own submit, from the keyboard.
          'Mod-Enter': () => {
            const form = wire.form;
            if (!form) return false;
            const button = form.querySelector('[type="submit"]') ?? document.querySelector(`[type="submit"][form="${CSS.escape(form.id)}"]`);
            form.requestSubmit(button ?? undefined);
            return true;
          },
        }),
        keymap(baseKeymap),
        history(),
      ],
    }),
    attributes: { role: 'textbox', 'aria-multiline': 'true' },
    // A trigger character at the start of a word opens its list; the
    // character is typed as usual, and a pick replaces it.
    handleTextInput(view, from, _to, text) {
      const opens = summons.get(text);
      if (!opens) return false;
      const before = from > 0 ? view.state.doc.textBetween(from - 1, from, '\n', ' ') : '';
      if (before !== '' && !/\s/.test(before)) return false;
      const target = document.getElementById(opens);
      if (!target) return false;
      view.dispatch(view.state.tr.insertText(text, from, _to));
      openList(target, root, view, from);
      return true;
    },
    dispatchTransaction(tr) {
      const state = view.state.apply(tr);
      view.updateState(state);
      if (tr.docChanged) sync(state);
    },
  });
  views.set(root, view);

  function sync(state) {
    const text = serialize(state.doc);
    root.toggleAttribute('data-empty', text === '');
    if (wire.value === text) return;
    wire.value = text;
    wire.dispatchEvent(new Event('input', { bubbles: true }));
  }
  sync(view.state);

  // The accessible name the render gave the root is the textbox's, and a
  // `<label for>` names it by reference and focuses it.
  for (const name of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-errormessage']) {
    if (root.hasAttribute(name)) content.setAttribute(name, root.getAttribute(name));
  }
  const label = root.id && document.querySelector(`label[for="${CSS.escape(root.id)}"]`);
  if (label) {
    label.id ||= `${root.id}-label`;
    content.setAttribute('aria-labelledby', label.id);
    label.addEventListener('click', () => view.focus(), { signal });
  }
  if (root.hasAttribute('autofocus')) {
    content.autofocus = true;
    if (!root.closest('dialog:not([open])')) view.focus();
  }
  // A required text with nothing written: the submit does nothing at
  // all (no post, no message), and the caret goes where the words would.
  if (root.hasAttribute('data-required')) {
    wire.form?.addEventListener('submit', (e) => {
      if (serialize(view.state.doc) !== '') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      view.focus();
    }, { signal, capture: true });
  }
  // A form reset puts the editor back to what it opened on, with its
  // wire; in a revealed part, the part goes away again too.
  const opened = view.state.doc;
  wire.form?.addEventListener('reset', () => {
    const { state } = view;
    view.dispatch(state.tr.replaceWith(0, state.doc.content.size, opened.content));
    const part = root.closest('[data-revealable]');
    if (part) reveal(part, false);
    else view.focus();
  }, { signal });

  signal.addEventListener('abort', () => {
    views.delete(root);
    if (summoned?.view === view) summoned = null;
    view.destroy();
  });
}
