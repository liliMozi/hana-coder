const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const rows = [
  { id: '/repo', branch: 'main', head: 'mainsha', status: '', commits: 'main', upstream: 'origin/main' },
  { id: '/repo-fix', branch: 'fix/one', head: 'fixsha', status: '', commits: 'fix', upstream: '' },
  { id: '/repo-feature', branch: 'feature/two', head: 'featuresha', status: 'M file', commits: 'feature', upstream: '' },
  { id: '/repo-detached', branch: 'notes', head: 'detsha', status: '', detached: true, commits: '', upstream: '' },
  { id: '/repo-locked', branch: 'locked-work', head: 'locksha', status: '', locked: true, commits: '', upstream: '' },
  { id: '/repo-prunable', branch: 'old-work', head: 'prunesha', status: '', prunable: true, commits: '', upstream: '' },
  { id: '/repo-missing', branch: 'missing', head: 'misssha', status: '', error: 'directory missing', commits: '', upstream: '' },
];

function load(options = {}) {
  let html = fs.readFileSync(path.join(root, 'assets/worktrees.card.html'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'assets/hana-card-style.js'), 'utf8');
  const runtime = fs.readFileSync(path.join(root, 'assets/worktrees-runtime.js'), 'utf8');
  html = html.replace('<script src="assets/hana-card-style.js"></script>', () => '<script>' + style + '</script>');
  html = html.replace('<script src="assets/worktrees-runtime.js"></script>', () => '<script>' + runtime + '</script>');
  html = replaceScript(html, 'data-card-state', { uiLanguage: 'zh', model: {
    repoPath: '/repo', repoLabel: 'repo', at: '2026-10-07T12:00:00Z', rows, summaries: { '/repo': '主树' },
    phase: 'idle', refreshId: null, message: '', checkedIds: ['/repo', '/repo-missing', '/gone'], branchType: 'feature', branchName: '  kept  ',
  } });
  if (options.scan) {
    const manifest = JSON.parse(readScript(html, 'data-card-manifest'));
    manifest.toolBindings = { scan: { tool: 'time.now' } };
    html = replaceScript(html, 'data-card-manifest', manifest);
  }
  const store = {}, events = [], errors = [];
  let listener, failEmit = false, failState = false;
  const host = {
    capabilities: async () => ({ ok: true, result: { capabilities: { state: 'available', emit: 'available', invoke: 'available', 'data.get': { status: 'available' } } } }),
    state: { get: async key => ({ ok: true, result: { value: options.restore ? options.restore : store[key] } }), set: async (key, value) => { if (failState) return { ok: false, error: 'state failure' }; store[key] = JSON.parse(JSON.stringify(value)); return { ok: true }; } },
    data: { get: async () => ({ ok: true, result: { data: {} } }), onChange: cb => { listener = cb; return () => {}; } },
    emit: async (name, payload) => { events.push({ name, payload }); return failEmit ? { ok: false, error: 'emit failure' } : { ok: true }; },
    invoke: async () => ({ ok: true, result: { content: [{ text: 'HANA_SNAPSHOT=' + JSON.stringify({ at: '2026-10-07T12:30:00Z', rows: rows.filter(row => row.id !== '/repo-feature') }) }] } }),
  };
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://card.invalid', beforeParse(windowObject) {
    windowObject.TextEncoder = TextEncoder;
    if (!options.offline) windowObject.card = host;
    windowObject.addEventListener('error', event => errors.push(event.error || event.message));
  } });
  return { dom, doc: dom.window.document, store, events, errors, data: data => listener(data), failEmit: value => { failEmit = value; }, failState: value => { failState = value; } };
}

function picks(doc) { return [...doc.querySelectorAll('.pick-row .pick')]; }
function entry(doc, branch) { return [...doc.querySelectorAll('.pick-row .entry')].find(button => button.textContent.includes(branch)); }

(async () => {
  const card = load({ scan: true }); await tick(); await tick();
  assert.deepEqual(card.errors, []);
  assert.equal(card.doc.querySelectorAll('[role="combobox"]').length, 1);
  const native = card.doc.getElementById('branchType');
  assert.equal(native.classList.contains('hs-select__native'), true);
  assert.equal(native.getAttribute('aria-hidden'), 'true');
  assert.equal(native.value, 'feature');
  assert.equal(getComputedStyleValue(card, '.type-select', '--type-bg'), '#e1e9dc');
  native.value = 'docs'; native.dispatchEvent(new card.dom.window.Event('change', { bubbles: true })); await tick();
  assert.equal(card.store.model.branchType, 'docs');
  assert.equal(getComputedStyleValue(card, '.type-select', '--type-ink'), '#607c8b');

  const before = card.doc.querySelector('.group');
  picks(card.doc)[0].click();
  assert.equal(card.doc.querySelector('.group'), before);
  assert.equal(picks(card.doc)[0].checked, false);
  assert.equal(picks(card.doc)[0].disabled, true);
  entry(card.doc, 'fix/one').click(); await tick();
  assert.match(card.doc.querySelector('.group').textContent, /fixsha/);
  card.doc.querySelector('.detail-pick .pick').click(); await tick();
  assert.deepEqual(card.store.model.checkedIds, ['/repo-fix']);
  assert.equal(card.doc.querySelector('.detail-pick .pick').checked, true);
  card.doc.getElementById('next').click(); await tick();
  assert.equal(card.doc.querySelector('.branch').textContent, 'feature/two');
  assert.equal(card.doc.querySelector('.detail-pick .pick').checked, false);
  card.doc.getElementById('prev').click(); await tick();
  assert.equal(card.doc.querySelector('.detail-pick .pick').checked, true);
  assert.match(card.doc.querySelector('.group').textContent, /fixsha/);
  card.doc.querySelector('.dot.home').click(); await tick();
  card.doc.getElementById('selectAll').click(); await tick();
  assert.deepEqual(card.store.model.checkedIds.slice().sort(), ['/repo-feature', '/repo-fix']);
  assert.equal(picks(card.doc).filter(input => !input.disabled).length, 2);
  assert.equal(picks(card.doc)[0].disabled, true);
  assert.equal(picks(card.doc).slice(3).every(input => input.disabled), true);

  card.doc.getElementById('branchName').value = '   ';
  card.doc.getElementById('branchName').dispatchEvent(new card.dom.window.Event('input'));
  card.doc.getElementById('createTree').click(); await tick(); await tick();
  const created = card.events.at(-1);
  assert.equal(created.name, 'hana-corder.create-worktree');
  assert.equal(created.payload.repoPath, '/repo');
  assert.equal(created.payload.requestId, card.store.model.operation.requestId);
  assert.equal(card.store.model.operation.name, '');
  assert.equal(card.store.model.operation.type, 'docs');
  assert.equal(card.store.model.operation.baseBranch, 'main');
  assert.equal('targets' in created.payload, false);
  assert.equal(card.doc.getElementById('refresh').disabled, true);
  assert.equal(card.doc.getElementById('refresh').textContent, '刷新');
  assert.equal(card.doc.getElementById('mergeTrees').disabled, true);
  assert.equal(picks(card.doc).every(input => input.disabled), true);
  const requestId = created.payload.requestId;
  card.data({ kind: 'worktree-operation', requestId: 'stale', phase: 'done', message: '迟到完成' }); await tick();
  assert.equal(card.store.model.operation.requestId, requestId);
  card.data({ kind: 'worktree-operation', requestId, phase: 'error', error: '分支名冲突' }); await tick();
  assert.equal(card.store.model.operation, null);
  assert.match(card.doc.getElementById('status').textContent, /分支名冲突/);
  assert.equal(card.doc.getElementById('branchName').value, '');
  assert.deepEqual(card.store.model.checkedIds.sort(), ['/repo-feature', '/repo-fix']);

  card.doc.getElementById('mergeTrees').click(); await tick(); await tick();
  const merged = card.events.at(-1);
  assert.equal(merged.name, 'hana-corder.merge-worktrees');
  assert.deepEqual(card.store.model.operation.targets, [
    { id: '/repo-fix', branch: 'fix/one', head: 'fixsha' },
    { id: '/repo-feature', branch: 'feature/two', head: 'featuresha' },
  ]);
  assert.equal('targets' in merged.payload, false);
  card.data({ kind: 'worktree-operation', requestId: merged.payload.requestId, phase: 'done', message: '已合并两处' }); await tick();
  assert.equal(card.store.model.operation, null);
  assert.match(card.doc.getElementById('status').textContent, /已合并两处/);
  assert.match(card.doc.getElementById('status').textContent, /刷新查看/);
  assert.equal(card.doc.querySelectorAll('.branch').length, rows.length);

  card.failEmit(true);
  card.doc.getElementById('createTree').click(); await tick(); await tick();
  assert.equal(card.store.model.operation, null);
  assert.match(card.doc.getElementById('status').textContent, /emit failure/);
  assert.equal(card.doc.getElementById('createTree').disabled, false);
  card.failEmit(false); card.failState(true);
  card.doc.getElementById('mergeTrees').click(); await tick(); await tick();
  assert.equal(card.events.at(-1).name, 'hana-corder.create-worktree');
  assert.match(card.doc.getElementById('status').textContent, /state failure/);
  assert.equal(card.store.model.operation, null);
  card.failState(false);
  card.doc.getElementById('refresh').click(); await tick(); await tick();
  assert.equal(card.store.model.phase, 'agent');
  assert.equal(card.doc.getElementById('createTree').disabled, true);
  assert.deepEqual(card.store.model.checkedIds, ['/repo-fix']);
  assert.equal(card.events.at(-1).name, 'hana-corder.enrich-worktrees');
  card.dom.window.close();

  const offline = load({ offline: true }); await tick(); await tick();
  const emitted = offline.events.length;
  offline.doc.getElementById('createTree').click();
  offline.doc.getElementById('mergeTrees').click();
  await tick();
  assert.equal(offline.events.length, emitted);
  assert.match(offline.doc.getElementById('status').textContent, /离线快照/);
  assert.deepEqual(offline.errors, []);
  offline.dom.window.close();

  const waiting = load({ scan: true, restore: { repoPath: '/repo', repoLabel: 'repo', rows, summaries: {}, phase: 'idle', operation: { requestId: 'kept', action: 'create', type: 'fix', name: '', baseBranch: 'main' }, checkedIds: [] } });
  await tick(); await tick();
  assert.equal(waiting.events.length, 0);
  assert.equal(waiting.doc.getElementById('cancel').hidden, false);
  assert.equal(waiting.doc.getElementById('refresh').textContent, '刷新');
  assert.equal(picks(waiting.doc).every(input => input.disabled), true);
  waiting.doc.getElementById('cancel').click(); await tick();
  assert.match(waiting.doc.getElementById('status').textContent, /不会撤销/);
  waiting.data({ kind: 'worktree-operation', requestId: 'kept', phase: 'done', message: '陈旧回写不应出现' }); await tick();
  assert.equal(waiting.doc.body.textContent.includes('陈旧回写不应出现'), false);
  assert.deepEqual(waiting.errors, []);
  waiting.dom.window.close();
  console.log('PASS worktree selection, create/merge payload, failures, stale replies, refresh exclusion');
})().catch(error => { console.error(error); process.exitCode = 1; });

function getComputedStyleValue(card, selector, name) {
  return card.doc.querySelector(selector).style.getPropertyValue(name);
}

function scriptAt(html, attribute) {
  const open = html.indexOf(attribute);
  const start = html.lastIndexOf('<script', open);
  const content = html.indexOf('>', open) + 1;
  const end = html.indexOf('</script>', content);
  return { start, content, end };
}
function readScript(html, attribute) {
  const spot = scriptAt(html, attribute);
  return html.slice(spot.content, spot.end);
}
function replaceScript(html, attribute, value) {
  const spot = scriptAt(html, attribute);
  return html.slice(0, spot.content) + JSON.stringify(value) + html.slice(spot.end);
}
