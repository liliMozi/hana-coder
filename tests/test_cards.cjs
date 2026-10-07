const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

function load(name, options = {}) {
  let html = fs.readFileSync(path.join(root, 'assets', name + '.card.html'), 'utf8');
  if (options.scan) html = html.replace(/(<script[^>]*data-card-manifest>)([\s\S]*?)(<\/script>)/, (_, a, json, b) => {
    const value = JSON.parse(json); value.toolBindings = { scan: { tool: 'time.now' } };
    return a + JSON.stringify(value) + b;
  });
  const store = {}, events = [], errors = [];
  let listener, failEmit = false, failState = false;
  const host = {
    capabilities: async () => ({ ok: true, result: { capabilities: options.limited ? { state: 'available', emit: 'requires_host', invoke: 'requires_host' } : { state: 'available', emit: 'available', invoke: 'available', 'data.get': { status: 'available' }, track: { status: 'requires_host' } } } }),
    state: { get: async key => ({ ok: true, result: { value: store[key] } }), set: async (key, value) => { if (failState) return { ok: false, error: 'state failure' }; store[key] = JSON.parse(JSON.stringify(value)); return { ok: true }; } },
    data: { get: async () => ({ ok: true, result: { data: {} } }), onChange: cb => { listener = cb; return () => {}; } },
    emit: async (name, payload) => { events.push({ name, payload }); return failEmit ? { ok: false, error: 'emit failure' } : { ok: true }; },
    invoke: async () => ({ ok: true, result: { content: [{ text: 'HANA_SNAPSHOT=' + JSON.stringify({ at: '2026-01-01T12:00:00Z', rows: [{ id: 'new-tree', branch: 'new', head: 'sha', status: '', commits: 'new change', upstream: '' }, { id: 'missing-tree', branch: 'missing', head: 'old', status: '', error: 'directory missing', commits: '', upstream: '' }] }) }] } }),
  };
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://card.invalid', beforeParse(w) {
    w.TextEncoder = TextEncoder;
    if (!options.offline) w.card = host;
    w.addEventListener('error', e => errors.push(e.error));
  } });
  return { dom, doc: dom.window.document, store, events, errors, data: data => listener(data), failEmit: value => { failEmit = value; }, failState: value => { failState = value; } };
}

(async () => {
  for (const [name, prefix, timestamp] of [['issue-gate', 'gt', 'submittedAt'], ['issue-report', 'sw', 'notesSubmittedAt']]) {
    const t = load(name); await tick(); await tick();
    const textarea = t.doc.querySelector('textarea');
    textarea.value = 'Keep this note'; textarea.dispatchEvent(new t.dom.window.Event('change'));
    await tick(); t.failEmit(true); t.doc.getElementById(prefix + 'SubmitBtn').click(); await tick(); await tick();
    assert.match(t.doc.getElementById(prefix + 'Status').textContent, /emit failure/);
    assert(!t.store[timestamp]); assert(!t.doc.getElementById(prefix + 'SubmitBtn').disabled);
    assert(Object.values(t.store.notes).includes('Keep this note'));
    t.failEmit(false); t.doc.getElementById(prefix + 'SubmitBtn').click(); await tick(); await tick();
    assert(t.store[timestamp]); assert(t.events.at(-1).payload.instruction.includes('来源卡片'));
    assert.equal(t.events.at(-1).payload.notes[0].note, 'Keep this note');
    const large = t.doc.querySelector('textarea'); large.value = '长'.repeat(4000); large.dispatchEvent(new t.dom.window.Event('change'));
    const before = t.events.length; t.doc.getElementById(prefix + 'SubmitBtn').click(); await tick();
    assert.equal(t.events.length, before); assert.match(t.doc.getElementById(prefix + 'Status').textContent, /过长/);
    assert.deepEqual(t.errors, []); t.dom.window.close();
    const offline = load(name, { offline: true }); assert(offline.doc.querySelector('h1').textContent); assert.deepEqual(offline.errors, []); offline.dom.window.close();
    console.log('PASS', name, 'successful/failed submission, notes, embedded prompt, 8KiB limit, offline');
  }
  const t = load('worktrees', { scan: true }); await tick(); await tick();
  assert.equal(t.doc.getElementById('refresh').disabled, false);
  await t.dom.window.refresh();
  assert.equal(t.store.model.phase, 'agent'); assert.equal(t.store.model.rows.length, 2);
  assert.match(t.doc.getElementById('pages').textContent, /读取失败/);
  assert.match(t.doc.getElementById('stats').textContent, /1 个干净/);
  t.data({ kind: 'worktree-enrich', refreshId: 'stale', phase: 'done', summaries: {} });
  assert.equal(t.doc.getElementById('refresh').disabled, true);
  const requestId = t.store.model.refreshId;
  t.data({ kind: 'worktree-enrich', refreshId: requestId, phase: 'done', summaries: { 'new-tree': 'New task', 'missing-tree': 'Unavailable task' } }); await tick();
  assert.equal(t.doc.getElementById('refresh').disabled, false); assert.match(t.doc.body.textContent, /New task/);
  assert(t.events[0].payload.instruction.includes('phase:')); t.failEmit(true); await t.dom.window.refresh();
  assert.equal(t.doc.getElementById('refresh').disabled, false); assert.match(t.doc.getElementById('status').textContent, /emit failure/);
  t.failEmit(false); await t.dom.window.refresh(); const old = t.store.model.refreshId; t.doc.getElementById('cancel').click(); await tick();
  t.data({ refreshId: old, phase: 'done', summaries: { 'new-tree': 'Late result', 'missing-tree': 'Late result' } }); await tick();
  assert(!t.doc.body.textContent.includes('Late result')); assert.deepEqual(t.errors, []); t.dom.window.close();
  for (const options of [{ offline: true }, { limited: true }, {}]) {
    const card = load('worktrees', options); await tick(); await tick(); assert(card.doc.getElementById('refresh').disabled); assert(card.doc.querySelector('.entry')); assert.deepEqual(card.errors, []); card.dom.window.close();
  }
  console.log('PASS worktrees facts-first, stale response, per-row error, failure reset, cancellation, limited hosts');
})().catch(error => { console.error(error); process.exitCode = 1; });
