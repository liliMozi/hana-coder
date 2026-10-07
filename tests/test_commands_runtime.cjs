const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function create(options = {}) {
  let html = fs.readFileSync(path.join(root, 'assets/commands.card.html'), 'utf8');
  const runtime = fs.readFileSync(path.join(root, 'assets/commands-runtime.js'), 'utf8');
  html = html.replace('<script src="assets/commands-runtime.js"></script>', () => '<script>' + runtime + '</script>');
  html = html.replace(/(<script[^>]*data-card-state>)[\s\S]*?(<\/script>)/, (_, a, b) => a + JSON.stringify({ uiLanguage: 'zh', panel: { repoPath: '/example', repoLabel: 'Example', commands: [{ id: 'status', name: '查看改动', argv: ['git', 'status'], cwd: '/example', command: 'git status', mode: 'binding', bindingId: 'run-status' }], runs: {}, pending: false, draft: '', message: '' } }) + b);
  html = html.replace(/(<script[^>]*data-card-manifest>)([\s\S]*?)(<\/script>)/, (_, a, j, b) => { const m = JSON.parse(j); m.toolBindings = { 'run-status': { tool: 'time.now' } }; return a + JSON.stringify(m) + b; });
  const store = {}, events = [], errors = [], invokes = []; let onData, failEmit = false, background = false;
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://card.invalid', beforeParse(w) {
    w.TextEncoder = TextEncoder;
    w.addEventListener('error', event => errors.push(event.error));
    if (options.offline) return;
    w.card = {
      capabilities: async () => ({ ok: true, result: { capabilities: options.limited ? { state: 'available' } : { state: 'available', invoke: 'available', emit: 'available', 'data.get': { status: 'available' } } } }),
      state: { get: async key => ({ ok: true, result: { value: store[key] } }), set: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); return { ok: true }; } },
      data: { get: async () => ({ ok: true, result: { data: {} } }), onChange: cb => { onData = cb; return () => {}; } },
      invoke: async binding => { invokes.push(binding); return { ok: true, result: background ? { process_id: 'existing-process' } : { content: [{ text: 'HANA_COMMAND_RESULT={"exitCode":0,"output":"clean","outputTruncated":false}' }] } }; },
      emit: async (name, payload) => { events.push({ name, payload }); return failEmit ? { ok: false, error: 'emit failed' } : { ok: true }; },
    };
  } });
  return { dom, doc: dom.window.document, store, events, errors, invokes, reply: data => onData(data), failure: () => { failEmit = true; }, background: () => { background = true; } };
}
(async () => {
  const t = create(); await tick(); await tick();
  t.doc.querySelector('.play').click(); await tick(); await tick();
  assert.deepEqual(t.invokes, ['run-status']); assert.equal(t.store.panel.runs.status.exitCode, 0); assert.equal(t.events.length, 0);
  const request = t.doc.getElementById('request'); request.value = '增加工作树列表'; request.dispatchEvent(new t.dom.window.Event('input'));
  t.doc.getElementById('composer').dispatchEvent(new t.dom.window.Event('submit', { cancelable: true })); await tick(); await tick();
  assert.equal(t.events[0].name, 'hana-corder.add-command'); assert(t.doc.getElementById('add').disabled);
  const rid = t.store.panel.requestId, existing = t.store.panel.commands[0];
  t.reply({ kind: 'command-add', requestId: 'wrong', phase: 'done', commands: [] }); assert(t.store.panel.pending);
  t.reply({ kind: 'command-add', requestId: rid, phase: 'done', commands: [existing, { id: 'trees', name: '工作树', argv: ['git', 'worktree', 'list'], cwd: '/example' }] }); await tick();
  assert.equal(t.doc.querySelectorAll('.play').length, 2); assert.equal(t.store.panel.commands[1].mode, 'agent'); assert.equal(t.invokes.length, 1);
  t.doc.querySelectorAll('.play')[1].click(); await tick(); await tick();
  const run = t.store.panel.activeRun; assert.equal(t.events.at(-1).name, 'hana-corder.run-command');
  t.reply({ kind: 'command-run', commandId: 'trees', runId: 'old', phase: 'done', exitCode: 0, output: 'old' }); assert(t.store.panel.activeRun);
  t.reply({ kind: 'command-run', commandId: 'trees', runId: run.runId, phase: 'error', exitCode: 2, error: 'real failure', output: 'bad' }); await tick();
  assert.equal(t.store.panel.activeRun, null); assert.equal(t.store.panel.runs.trees.phase, 'error'); assert.match(t.doc.body.textContent, /real failure/);
  t.background(); t.doc.querySelector('.play').click(); await tick(); await tick();
  assert.equal(t.events.at(-1).name, 'hana-corder.command-followup'); assert.equal(t.events.at(-1).payload.processId, 'existing-process'); assert.equal(t.invokes.length, 2);
  const run2 = t.store.panel.activeRun; t.reply({ kind: 'command-run', commandId: 'status', runId: run2.runId, phase: 'done', exitCode: 0, output: 'finished' }); await tick();
  assert.equal(t.store.panel.activeRun, null); assert.deepEqual(t.errors, []); t.dom.window.close();
  for (const options of [{ offline: true }, { limited: true }]) { const x = create(options); await tick(); await tick(); assert(x.doc.querySelector('.play').disabled); assert(x.doc.getElementById('add').disabled); assert.deepEqual(x.errors, []); x.dom.window.close(); }
  const failure = create(); await tick(); await tick(); failure.failure(); const input = failure.doc.getElementById('request'); input.value = '保留此输入'; input.dispatchEvent(new failure.dom.window.Event('input')); failure.doc.getElementById('composer').dispatchEvent(new failure.dom.window.Event('submit', { cancelable: true })); await tick(); await tick(); assert.equal(failure.store.panel.pending, false); assert.equal(input.value, '保留此输入'); assert.match(failure.doc.getElementById('status').textContent, /emit failed/); failure.dom.window.close();
  console.log('PASS commands: fixed direct binding, additive Agent command, no auto-run, stale reply, true failure, existing process followup, limited hosts, failure recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
