(function () {
  'use strict';
  const initial = JSON.parse(document.querySelector('[data-card-state]').textContent);
  const manifest = JSON.parse(document.querySelector('[data-card-manifest]').textContent);
  let panel = initial.panel, caps = {}, ready = false, saving = Promise.resolve();
  panel.runs = panel.runs || {};
  const $ = id => document.getElementById(id);
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const textCommand = argv => argv.map(a => /[\s"'\\]/.test(a) ? JSON.stringify(a) : a).join(' ');
  function status(message) { panel.message = message; $('status').textContent = message; }
  function save() {
    if (!['available', 'local_fallback'].includes(caps.state)) return Promise.resolve(false);
    const value = JSON.parse(JSON.stringify(panel));
    const request = saving.then(async () => { const e = await window.card.state.set('panel', value); if (!e.ok) throw Error(e.error || '状态保存失败'); return true; });
    saving = request.catch(() => {});
    return request.catch(error => { status(error.message); return false; });
  }
  function draw() {
    const busy = panel.pending || !!panel.activeRun;
    $('repoLabel').textContent = panel.repoLabel || '仓库未绑定';
    $('count').textContent = panel.commands.length + ' 条命令';
    $('executionHint').textContent = panel.repoPath ? '逐条执行' : '未绑定';
    $('cwdLabel').textContent = '执行目录：' + (panel.repoPath || '未绑定');
    $('cwdLabel').style.overflowWrap = 'anywhere';
    $('list').replaceChildren();
    panel.commands.forEach(c => {
      const wrapper = node('section', ''), row = node('article', 'command');
      const code = node('code', 'code', c.command || textCommand(c.argv || [])); code.title = (c.command || '') + '\n' + (c.cwd || panel.repoPath || '');
      const button = node('button', 'hs-button play'); button.type = 'button';
      button.setAttribute('aria-label', '运行 ' + c.name + (c.mode === 'agent' ? '（Agent 执行）' : ''));
      button.title = c.mode === 'agent' ? 'Agent 执行：' + c.name : '直接运行：' + c.name;
      button.disabled = !ready || busy || (c.mode === 'binding' ? !manifest.toolBindings?.[c.bindingId] || caps.invoke !== 'available' : c.mode !== 'agent' || caps.emit !== 'available');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M4 2.5Q4 1.5 5 2.1L13 7.1Q14 8 13 8.9L5 13.9Q4 14.5 4 13.5Z'); svg.append(path); button.append(svg);
      button.onclick = () => execute(c);
      row.append(node('span', 'name', c.name), code, button); wrapper.append(row);
      const result = panel.runs[c.id];
      if (result) {
        const details = node('details', 'hs-disclosure'); details.style.cssText = 'font-size:11px;margin:0 8px 8px;';
        details.open = result.phase === 'running' || result.phase === 'error';
        details.append(node('summary', '', result.phase === 'running' ? '运行中…' : result.phase === 'error' ? '未成功 · ' + (result.error || '退出码 ' + result.exitCode) : '已完成 · 退出码 ' + result.exitCode));
        const output = node('pre', '', (result.output || '暂无输出') + (result.outputTruncated ? '\n[输出已截断]' : '')); output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;'; details.append(output);
        if (result.phase === 'running' && result.processId) details.append(node('p', '', '进程：' + result.processId));
        if (result.phase === 'running') { const retry = node('button', 'hs-button hs-button--quiet', '请 Agent 跟进'); retry.disabled = !ready || caps.emit !== 'available'; retry.onclick = () => followup(c, result); details.append(retry); }
        wrapper.append(details);
      }
      $('list').append(wrapper);
    });
    $('request').value = panel.draft || ''; $('request').disabled = busy;
    $('add').disabled = !ready || busy || caps.emit !== 'available' || !panel.repoPath;
    $('add').textContent = panel.pending ? '添加中' : '添加';
    $('cancelAdd').hidden = !panel.pending;
    $('status').textContent = panel.message || '';
  }
  async function emit(name, payload) {
    if (caps.emit !== 'available') throw Error('当前宿主无法联系 Agent');
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 8192) throw Error('请求过长，请缩短后重试；输入已保留。');
    const e = await window.card.emit(name, payload); if (!e.ok) throw Error(e.error || '请求未送达');
  }
  function finish(commandId, runId, result) {
    const prior = panel.runs[commandId];
    if (!prior || prior.runId !== runId || prior.phase !== 'running') return;
    const success = result.exitCode === 0 && !result.error;
    panel.runs[commandId] = { ...prior, ...result, phase: success ? 'done' : 'error', error: result.error || (success ? '' : '命令未成功') };
    if (panel.activeRun?.runId === runId) panel.activeRun = null;
    status(success ? '命令已完成。' : '命令未成功，请展开结果查看。'); draw(); save();
  }
  function decode(result) {
    const objects = [result], seen = new Set(); let processId = null;
    while (objects.length) {
      const value = objects.shift();
      if (typeof value === 'string') {
        const match = value.match(/^HANA_COMMAND_RESULT=(\{[^\n]*\})/m);
        if (match) return { result: JSON.parse(match[1]) };
        if (value.trim().startsWith('{')) { try { objects.push(JSON.parse(value)); } catch (_) {} }
      } else if (value && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        if (value.process_id || value.processId) processId = value.process_id || value.processId;
        objects.push(...Object.values(value));
      }
    }
    if (processId) return { processId };
    throw Error('工具未返回可核验的命令结果；不能判定成功。');
  }
  async function followup(c, result) {
    try {
      await emit('hana-corder.command-followup', { commandId: c.id, runId: result.runId, processId: result.processId || null, instruction: '读取来源卡片state.panel.runs及activeRun，核对runId。若有processId，使用write_stdin空输入带预算等待这个已运行进程，绝不重新执行命令，不轮询。读取HANA_COMMAND_RESULT或真实退出码与输出后，向来源cardEntityId回写{kind:"command-run",runId,commandId,phase:"done"或"error",exitCode,output,error,outputTruncated}。没有processId时先核对原执行事件是否仍在进行，不盲目重复。权限拒绝或进程不可恢复时明确回写error以复位。' });
      status('已请 Agent 跟进原执行，不会重新运行。');
    } catch (error) { status('跟进请求失败：' + error.message + '；原命令可能仍在运行。'); }
  }
  async function execute(c) {
    if (!ready || panel.pending || panel.activeRun) return;
    const runId = crypto.randomUUID();
    panel.activeRun = { runId, commandId: c.id, mode: c.mode };
    panel.runs[c.id] = { runId, phase: 'running', output: '' }; status('正在运行「' + c.name + '」…'); draw();
    try {
      if (!await save()) throw Error('无法保存执行请求');
      if (c.mode === 'binding') {
        const e = await window.card.invoke(c.bindingId); if (!e.ok) throw Error(e.error || '工具执行失败');
        const decoded = decode(e.result);
        if (decoded.result) finish(c.id, runId, decoded.result);
        else { panel.runs[c.id].processId = decoded.processId; await save(); draw(); await followup(c, panel.runs[c.id]); }
      } else if (c.mode === 'agent') {
        await emit('hana-corder.run-command', { runId, commandId: c.id, instruction: '读取本事件来源卡片state.panel，核对activeRun的runId与commandId。只运行对应已添加命令的argv/cwd，不将command展示字符串交给shell解释。先核实用户本次点击的授权，远端写入、破坏性操作或付费仍需明确授权；未经授权则回写说明而不执行。可用配方scripts/run_command.py取得真实exitCode和输出；长任务用完成事件或带预算等待，不轮询。向来源cardEntityId回写{kind:"command-run",runId,commandId,phase:"done"或"error",exitCode,output,error,outputTruncated}，失败也回写以复位。不要新开卡、不要修改HTML。' });
      } else throw Error('当前命令未绑定执行方式');
    } catch (error) { finish(c.id, runId, { exitCode: null, output: '', error: error.message }); }
  }
  function apply(data) {
    if (!data) return;
    if (data.kind === 'command-run') {
      if (data.phase !== 'done' && data.phase !== 'error') return;
      finish(data.commandId, data.runId, { exitCode: data.exitCode ?? null, output: String(data.output || ''), error: data.phase === 'error' ? String(data.error || '执行失败') : data.error, outputTruncated: !!data.outputTruncated, finishedAt: data.finishedAt });
      return;
    }
    if (data.kind !== 'command-add' || !panel.pending || data.requestId !== panel.requestId || !['done', 'error'].includes(data.phase)) return;
    try {
      if (data.phase === 'error') throw Error(data.error || '添加失败');
      if (!Array.isArray(data.commands)) throw Error('返回的命令列表无效');
      const list = data.commands, ids = new Set();
      for (const c of list) {
        if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || !Array.isArray(c.argv) || !c.argv.length || !c.argv.every(a => typeof a === 'string') || typeof c.cwd !== 'string' || !c.cwd || ids.has(c.id)) throw Error('命令必须有唯一id、名称、argv与cwd');
        ids.add(c.id);
      }
      for (const existing of panel.commands) {
        const same = list.find(c => c.id === existing.id);
        if (!same || JSON.stringify(same.argv) !== JSON.stringify(existing.argv) || same.cwd !== existing.cwd || same.name !== existing.name) throw Error('添加操作不能删除或修改已有命令');
      }
      panel.commands = list.map(c => panel.commands.find(old => old.id === c.id) || { id: c.id, name: c.name, argv: c.argv, cwd: c.cwd, command: textCommand(c.argv), mode: 'agent' });
      panel.draft = ''; status('已添加，尚未执行。');
    } catch (error) { status(error.message + '；原列表与输入已保留。'); }
    panel.pending = false; draw(); save();
  }
  $('request').oninput = () => { panel.draft = $('request').value; save(); };
  $('composer').onsubmit = async event => {
    event.preventDefault(); const request = $('request').value.trim(); if (!request || $('add').disabled) return;
    panel.pending = true; panel.requestId = crypto.randomUUID(); panel.draft = request; status('Agent 正在添加命令…'); draw();
    try {
      if (!await save()) throw Error('无法保存添加请求');
      await emit('hana-corder.add-command', { requestId: panel.requestId, repoPath: panel.repoPath, request, instruction: '读取本事件来源卡片state.panel并核对requestId。核实仓库实际脚本/工具后添加用户所需命令，保留已有条目不变。新增条目包含唯一id、简短name、明确argv字符串数组和cwd。只添加不执行，不自动安装依赖，不修改HTML或新开卡。向来源cardEntityId回写{kind:"command-add",requestId,phase:"done",commands:完整列表}；失败回写同kind/id和phase:"error",error。新增命令将标为Agent执行，待用户点击后才运行。' });
    } catch (error) { panel.pending = false; status(error.message); draw(); await save(); }
  };
  $('cancelAdd').onclick = () => { panel.pending = false; panel.requestId = null; status('已取消等待添加，输入已保留。'); draw(); save(); };
  draw();
  (async () => {
    if (!window.card) { status('离线快照：执行和添加需要 Hana。'); return; }
    const c = await window.card.capabilities(); if (!c.ok) { status(c.error || '宿主不可用'); return; } caps = c.result.capabilities;
    const stateOk = ['available', 'local_fallback'].includes(caps.state);
    if (stateOk) { const s = await window.card.state.get('panel'); if (!s.ok) { status(s.error || '状态读取失败'); return; } if (s.result.value) panel = s.result.value; }
    const dataOk = caps['data.get'] && ['available', 'local_fallback'].includes(caps['data.get'].status);
    if (!stateOk || !dataOk) { status('当前宿主仅支持查看快照，执行与添加不可用。'); draw(); return; }
    const off = window.card.data.onChange(apply); window.addEventListener('pagehide', () => { if (typeof off === 'function') off(); }, { once: true });
    const d = await window.card.data.get(); if (!d.ok) { status(d.error || '结果读取失败'); draw(); return; } apply(d.result.data);
    ready = true; if (panel.pending) status('等待 Agent 添加命令…'); if (panel.activeRun) status('已有命令运行中，请展开结果查看或请 Agent 跟进。'); draw();
  })();
})();
