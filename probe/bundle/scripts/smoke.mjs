// Load the runtime unbundled and as each bundle in headless Chromium; report what
// each evaluation left behind: console messages, page errors, the shim stamp,
// and the event listeners on window and document (type and count).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
const [corpus, vendor, ...bundles] = process.argv.slice(2);
const patterns = fs.readdirSync(path.join(corpus, 'patterns')).map(f => f.replace(/\.js$/, ''));
const importMap = { imports: { 'vendor/prosemirror': '/vendor/prosemirror.js', ...Object.fromEntries(patterns.map(p => [`pattern/${p}`, `/runtime/patterns/${p}.js`])) } };
const page = src => `<!doctype html><html><head><script type="importmap">${JSON.stringify(importMap)}</script>
${src === '/original' ? '<script src="/original.js"></script>' : `<script type="module" src="${src}"></script>`}</head><body>
<form data-autosubmit><input name="q"></form>
${patterns.map(p => `<div data-pattern="${p}"></div>`).join('\n')}
</body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/page') { res.setHeader('content-type', 'text/html'); return res.end(page(url.searchParams.get('src'))); }
  let file;
  if (url.pathname.startsWith('/runtime/')) file = path.join(corpus, url.pathname.slice(9));
  else if (url.pathname === '/vendor/prosemirror.js') file = vendor;
  else if (url.pathname === '/original.js') file = process.env.ORIGINAL;
  else if (url.pathname.startsWith('/bundle/')) file = bundles[Number(url.pathname.slice(8))];
  if (!file || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(file));
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const variants = [...(process.env.ORIGINAL ? [['original progressive.js', '/original']] : []), [`unbundled ${process.env.ENTRY ?? 'entry'}`, `/runtime/${process.env.ENTRY ?? 'entry'}.js`], ...bundles.map((b, i) => [path.basename(b), `/bundle/${i}`])];
for (const [name, src] of variants) {
  const ctx = await browser.newContext(); const p = await ctx.newPage(); const log = [];
  p.on('requestfailed', r => log.push('failed ' + r.url())); p.on('response', r => { if (r.status() === 404) log.push('404 ' + r.url()); });
  p.on('console', m => log.push(`${m.type()}: ${m.text().split('\n')[0]}`)); p.on('pageerror', e => log.push(`pageerror: ${e.message}`));
  await p.goto(`http://localhost:${port}/page?src=${encodeURIComponent(src)}`, { waitUntil: 'load' });
  await p.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(p); await cdp.send('Debugger.enable');
  const listeners = {};
  for (const target of ['window', 'document']) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: target });
    const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const l of ls) { listeners[`${target}.${l.type}`] = (listeners[`${target}.${l.type}`] ?? 0) + 1; if (process.env.WHERE && ['accepted','refused','popstate','click'].includes(l.type)) { const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: l.scriptId }); console.log(name, target, l.type, scriptSource.split('\n')[l.lineNumber]?.slice(Math.max(0,l.columnNumber-60), l.columnNumber+80)); } }
  }
  const shim = await p.evaluate(() => document.documentElement.hasAttribute('data-shim'));
  const summary = Object.entries(listeners).sort().map(([k, v]) => `${k}×${v}`).join(' ');
  console.log(`== ${name}\nshim stamp: ${shim}\nlisteners: ${summary}\n${log.sort().join('\n')}`);
  await ctx.close();
}
await browser.close(); server.close();
