// One-off: cut progressive.js's IIFE into ES modules by section line ranges,
// importing every cross-module top-level name and exporting what others use.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import fs from 'node:fs';
const [src, outDir] = process.argv.slice(2);
const text = fs.readFileSync(src, 'utf8');
const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
const iife = ast.body.find(s => s.type === 'ExpressionStatement').expression.callee.body.body;
const cuts = [ // [module, first line]
  ['core', 41], ['windows', 464], ['tallies', 530], ['live', 601], ['navigation', 706],
  ['state', 993], ['keys', 1214], ['enhancements', 1324], ['stateform', 1632],
];
const modOf = line => { let m = cuts[0][0]; for (const [n, l] of cuts) if (line >= l) m = n; return m; };
const declared = new Map(); // name -> {mod, kind}
const stmts = iife.map(s => ({ s, mod: modOf(s.loc.start.line) }));
for (const { s, mod } of stmts) {
  const names = [];
  if (s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') names.push(s.id.name);
  if (s.type === 'VariableDeclaration') for (const d of s.declarations) walk.fullAncestor(d.id, (n, _, anc) => { if (n.type === 'Identifier' && anc.length && !(anc.at(-2)?.type === 'Property' && anc.at(-2).key === n && !anc.at(-2).shorthand)) names.push(n.name); }, walk.base);
  for (const n of names) declared.set(n, { mod, kind: s.kind ?? 'fn' });
}
const imports = new Map(), exported = new Set(), problems = [];
for (const { s, mod } of stmts) {
  walk.fullAncestor(s, (n, _, anc) => {
    if (n.type !== 'Identifier') return;
    const p = anc.at(-2);
    if (p && (p.type === 'MemberExpression' && p.property === n && !p.computed)) return;
    if (p && (p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n && !p.computed && !p.shorthand) return;
    if (p && (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement')) return;
    const d = declared.get(n.name);
    if (!d || d.mod === mod) return;
    if (p && ((p.type === 'AssignmentExpression' && p.left === n) || p.type === 'UpdateExpression')) problems.push(`${mod}:${n.loc.start.line} assigns ${n.name} of ${d.mod}`);
    if (!imports.has(mod)) imports.set(mod, new Map());
    const m = imports.get(mod); if (!m.has(d.mod)) m.set(d.mod, new Set()); m.get(d.mod).add(n.name);
    exported.add(n.name);
  }, walk.base);
}
fs.mkdirSync(outDir, { recursive: true });
const lines = text.split('\n');
for (const [mod] of cuts) {
  let out = `// ${mod}: cut from progressive.js for the bundling probe (#754).\n`;
  for (const [from, names] of imports.get(mod) ?? []) out += `import { ${[...names].sort().join(', ')} } from './${from}.js';\n`;
  let prev = null;
  for (const { s, mod: m } of stmts) {
    if (m !== mod) continue;
    // keep the comments above a statement: from the end of the previous statement
    const startLine = prev === null ? s.loc.start.line : Math.max(prev + 1, s.loc.start.line - 40);
    let first = s.loc.start.line;
    while (first - 1 > (prev ?? cuts.find(c => c[0] === mod)[1] - 1) && /^\s*\/\//.test(lines[first - 2])) first--;
    let body = lines.slice(first - 1, s.loc.end.line).join('\n');
    const names = s.type === 'VariableDeclaration' ? s.declarations.map(d => d.id.name) : s.id ? [s.id.name] : [];
    if (names.some(n => exported.has(n))) {
      body = body.replace(/^(\s*)(async function|function|const|let|class)\b/m, '$1export $2');
    }
    out += '\n' + body.replace(/^  /gm, '');
    prev = s.loc.end.line;
  }
  fs.writeFileSync(`${outDir}/${mod}.js`, out + '\n');
}
console.log('problems:', problems.join('\n') || 'none');
for (const [m, f] of imports) console.log(m, '<-', [...f.keys()].join(' '));
