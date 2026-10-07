const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets/pr-review.card.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'assets/pr-runtime.js'), 'utf8');
const exampleModel = JSON.parse(html.match(/<script type="application\/json" data-card-state>(.*?)<\/script>/s)[1]).model;
const deep = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const liveModel = () => ({
  ...deep(exampleModel), repoPath: '/tmp/demo-repo', repoLabel: 'demo-repo', remote: 'team/demo', host: 'github.com', at: '2026-10-07T12:00:00Z',
  prs: [{ number: 7, title: 'Example PR', branch: 'topic', base: 'main', author: 'contributor', status: '待审阅', tone: 'pending', checks: 'CI queued', review: '尚未审阅', merge: '未知', files: 2, additions: 5, deletions: 1, body: 'description', url: 'https://github.com/team/demo/pull/7', headSha: 'sha-old', baseSha: 'base-1', checkLinks: [{ name: 'CI job', url: 'https://github.com/team/demo/actions/runs/8' }] }],
  summaries: {}, reviews: {}, notes: {}, page: 0, phase: 'idle', refreshId: null, reviewRequest: null, message: ''
});

async function setup({ host = 'full', model = liveModel(), invoke, emit } = {}) {
  const markup = host === 'full' ? html.replace('"toolBindings":{}', '"toolBindings":{"scan":{"tool":"exec_command"}}') : html;
  const dom = new JSDOM(markup, { runScripts: 'outside-only', url: 'https://card.local/' });
  const w = dom.window;
  const store = { model: deep(model) };
  const handlers = { change: null };
  const calls = { invoke: [], emit: [], set: [] };
  if (host !== 'none') {
    w.card = {
      capabilities: async () => ({ ok: true, result: { capabilities: host === 'state-only' ? { state: 'available', 'data.get': { status: 'available' }, invoke: 'unavailable', emit: 'unavailable' } : { state: 'available', 'data.get': { status: 'available' }, invoke: 'available', emit: 'available' } } }),
      state: {
        get: async key => ({ ok: true, result: { value: store[key] } }),
        set: async (key, value) => { calls.set.push([key, deep(value)]); store[key] = deep(value); return { ok: true }; }
      },
      data: { onChange: fn => { handlers.change = fn; }, get: async () => ({ ok: true, result: { data: null } }) },
      invoke: async name => { calls.invoke.push(name); return invoke ? invoke(name) : { ok: true, result: { stdout: 'HANA_SNAPSHOT=' + JSON.stringify({ ...store.model, at: '2026-10-07T13:00:00Z', prs: store.model.prs }) } }; },
      emit: async (name, payload) => { calls.emit.push([name, deep(payload)]); return emit ? emit(name, payload, store) : { ok: true }; }
    };
  }
  w.eval(runtime);
  await tick();
  return { dom, w, store, handlers, calls, close: () => dom.window.close() };
}
async function test(name, fn) { await fn(); console.log('PASS ' + name); }

(async () => {
  await test('full host refresh updates facts before Agent emit and sends bounded contract', async () => {
    let snapshot;
    const app = await setup({ invoke: async () => ({ ok: true, result: { stdout: 'HANA_SNAPSHOT=' + JSON.stringify({ ...liveModel(), at: '2026-10-07T13:30:00Z', prs: [{ ...liveModel().prs[0], title: 'Fresh facts', headSha: 'sha-new' }] }) } }), emit: async (name, payload, store) => { snapshot = deep(store.model); assert.equal(store.model.prs[0].title, 'Fresh facts'); return { ok: true }; } });
    app.w.document.getElementById('refresh').click(); await tick();
    assert.deepEqual(app.calls.invoke, ['scan']);
    assert.equal(snapshot.prs[0].headSha, 'sha-new');
    assert.equal(app.calls.emit[0][0], 'hana-corder.enrich-prs');
    assert.equal(app.calls.emit[0][1].repoPath, '/tmp/demo-repo');
    assert.ok(Buffer.byteLength(JSON.stringify(app.calls.emit[0][1])) <= 8192);
    assert.equal(app.store.model.phase, 'agent'); app.close();
  });

  await test('no host and state-only host keep refresh/review unavailable', async () => {
    const offline = await setup({ host: 'none' });
    assert.equal(offline.w.document.getElementById('refresh').disabled, true);
    assert.match(offline.w.document.getElementById('status').textContent, /离线快照/); offline.close();
    const limited = await setup({ host: 'state-only' });
    assert.equal(limited.w.document.getElementById('refresh').disabled, true);
    limited.w.document.getElementById('dots').querySelectorAll('button')[1].click(); await tick();
    assert.equal(limited.w.document.querySelector('.review-button').disabled, true); limited.close();
  });

  await test('empty PR snapshot renders zero state and correct statistics', async () => {
    const model = liveModel(); model.prs = [];
    const app = await setup({ model });
    assert.match(app.w.document.getElementById('stats').textContent, /0 个 PR/);
    assert.match(app.w.document.querySelector('.pages').textContent, /没有开放的 PR/); app.close();
  });

  await test('stale enrichment reply is ignored and notes remain keyed by PR id after refresh', async () => {
    const app = await setup();
    app.w.document.getElementById('dots').querySelectorAll('button')[1].click(); await tick();
    const note = app.w.document.querySelector('.hs-textarea'); note.value = '请核对边界'; note.dispatchEvent(new app.w.Event('input', { bubbles: true })); await tick();
    app.w.document.getElementById('prev').click(); await tick(); app.w.document.getElementById('refresh').click(); await tick();
    const requestId = app.store.model.refreshId;
    app.handlers.change({ kind: 'pr-enrich', refreshId: 'old-request', phase: 'done', summaries: { 'github.com/team/demo#7': { summary: 'STALE' } } });
    assert.equal(app.store.model.summaries['github.com/team/demo#7'], undefined);
    app.handlers.change({ kind: 'pr-enrich', refreshId: requestId, phase: 'done', summaries: { 'github.com/team/demo#7': { summary: 'fresh summary' } } }); await tick();
    app.w.document.getElementById('dots').querySelectorAll('button')[1].click(); await tick();
    assert.equal(app.w.document.querySelector('.hs-textarea').value, '请核对边界');
    assert.match(app.w.document.querySelector('.body').textContent, /fresh summary/); app.close();
  });

  await test('review freezes identity, ignores old reply, marks old SHA outdated and preserves CI', async () => {
    let scanCount = 0;
    const app = await setup({ invoke: async (_name) => { scanCount++; const source = liveModel(); if (scanCount >= 1) source.prs[0].headSha = 'sha-new'; return { ok: true, result: { stdout: 'HANA_SNAPSHOT=' + JSON.stringify(source) } }; } });
    app.w.document.getElementById('dots').querySelectorAll('button')[1].click(); await tick();
    const beforeCI = app.store.model.prs[0].checks;
    app.w.document.querySelector('.review-button').click(); await tick();
    const [event, payload] = app.calls.emit.at(-1);
    assert.equal(event, 'hana-corder.review-pr'); assert.equal(payload.prId, 'github.com/team/demo#7'); assert.equal(payload.headSha, 'sha-old');
    assert.ok(Object.hasOwn(payload, 'instruction'));
    app.handlers.change({ kind: 'pr-review', reviewId: 'stale', prId: payload.prId, reviewedHeadSha: payload.headSha, phase: 'done', review: { conclusion: 'STALE' } });
    assert.equal(app.store.model.phase, 'review');
    app.handlers.change({ kind: 'pr-review', reviewId: payload.reviewId, prId: payload.prId, reviewedHeadSha: payload.headSha, phase: 'done', review: { conclusion: '发现问题', summary: '检查结论', findings: [], validation: '未运行', limitations: '示例', latestHeadSha: 'sha-new' } }); await tick();
    assert.equal(app.store.model.prs[0].checks, beforeCI);
    assert.match(app.w.document.getElementById('pages').textContent, /审阅结果已过期/);
    app.w.document.getElementById('refresh').click(); await tick();
    app.handlers.change({ kind: 'pr-enrich', refreshId: app.store.model.refreshId, phase: 'done', summaries: { 'github.com/team/demo#7': { summary: 'new version summary' } } }); await tick();
    assert.match(app.w.document.getElementById('pages').textContent, /审阅结果已过期/); app.close();
  });

  await test('emit failure restores action and exposes reason', async () => {
    const app = await setup({ emit: async () => ({ ok: false, error: 'delivery failed' }) });
    app.w.document.getElementById('refresh').click(); await tick();
    assert.equal(app.store.model.phase, 'idle');
    assert.match(app.w.document.getElementById('status').textContent, /delivery failed/);
    assert.equal(app.w.document.getElementById('refresh').disabled, false); app.close();
  });

  await test('refresh preserves selected identity after reorder and exposes real source links', async () => {
    const first = liveModel().prs[0], second = { ...first, number: 8, title: 'Second', url: 'https://github.com/team/demo/pull/8' };
    const model = liveModel(); model.prs = [first, second];
    const app = await setup({ model, invoke: async () => ({ ok: true, result: { stdout: 'HANA_SNAPSHOT=' + JSON.stringify({ ...model, capped: true, limit: 2, prs: [second, first] }) } }) });
    app.w.document.getElementById('dots').querySelectorAll('button')[1].click(); await tick();
    assert.equal(app.w.document.querySelector('.number').href, first.url);
    app.w.document.getElementById('refresh').click(); await tick();
    app.handlers.change({ kind: 'pr-enrich', refreshId: app.store.model.refreshId, phase: 'done', summaries: { 'github.com/team/demo#7': { summary: 'First' }, 'github.com/team/demo#8': { summary: 'Second' } } }); await tick();
    assert.equal(app.w.document.querySelector('.number').href, first.url);
    assert.match(app.w.document.getElementById('stats').textContent, /最多 2 条/);
    assert(app.w.document.querySelector('a[href="https://github.com/team/demo/actions/runs/8"]')); app.close();
  });
  await test('restored pending request stays pending until explicit cancellation', async () => {
    const model = liveModel(); model.phase = 'agent'; model.refreshId = 'waiting';
    const app = await setup({ model }); assert.equal(app.store.model.phase, 'agent');
    assert.equal(app.w.document.getElementById('cancelRequest').hidden, false);
    app.w.document.getElementById('cancelRequest').click(); await tick();
    app.handlers.change({ kind: 'pr-enrich', refreshId: 'waiting', phase: 'done', summaries: { 'github.com/team/demo#7': { summary: 'old' } } }); await tick();
    assert.equal(app.store.model.phase, 'idle'); assert.equal(app.store.model.summaries['github.com/team/demo#7'], undefined); app.close();
  });
  console.log('All PR runtime interaction tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });