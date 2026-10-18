const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const fakeIDB = require('fake-indexeddb');
const ROOT = process.env.KANVU_DIR || path.resolve(__dirname, '..');
async function boot(seed = {}, extra = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.detail || e.message || e)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
    const f = path.join(ROOT, src);
    if (!fs.existsSync(f)) return '';
    let code = fs.readFileSync(f, 'utf8');
    if (src === 'config.js' && extra.apiUrl) code = code.replace("apiUrl: ''", `apiUrl: '${extra.apiUrl}'`);
    return '<script>' + code.replace(/<\/script>/g, '<\\/script>') + '</script>';
  });
  const dom = new JSDOM(html, {
    url: extra.url || 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = fakeIDB.indexedDB; w.IDBKeyRange = fakeIDB.IDBKeyRange;
      Object.entries(seed).forEach(([k, v]) => w.localStorage.setItem(k, v));
      Object.entries(extra.sessionSeed || {}).forEach(([k, v]) => w.sessionStorage.setItem(k, v));
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} disconnect() {} unobserve() {} };
      if (extra.jar) w.fetch = makeFetch(extra.jar);
      if (extra.beforeParse) extra.beforeParse(w);
    }
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await new Promise(r => setTimeout(r, 50));
  const w = dom.window;
  // `const kanban` in a classic script is a global lexical binding, not a window property
  w.eval('window.__k = kanban');
  return { dom, w, k: w.__k, errors, ls: w.localStorage };
}
function makeFetch(jar) {
  return async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    const c = Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (c) headers.Cookie = c;
    jar.calls = (jar.calls || 0) + 1;
    const res = await fetch(url, { method: opts.method, headers, body: opts.body, redirect: 'manual' });
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach(sc => {
      const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/i.test(sc)) delete jar.cookies[k]; else jar.cookies[k] = v;
    });
    return res;
  };
}
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } }
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
module.exports = { boot, ok, wait, summary: () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); } };
