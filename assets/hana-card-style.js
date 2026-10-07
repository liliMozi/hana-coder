/* ==========================================================================
   Hana Card Style · canonical 组件脚本
   --------------------------------------------------------------------------
   自包含、无依赖的浏览器脚本。它只做两件事：

     1. 控件增强：把已经写在 HTML 里的原生控件（Tabs / select / range / 图组）
        接上键盘与状态行为。控件本来的 DOM 与值接口不变，增强层是可撤销的。
     2. 图表渲染：按数据生成折线、面积、柱状、堆叠柱状、横向条形、饼图与环形图的
        SVG；renderChart(root, spec) 按 spec.kind 分发到对应渲染器。

   它不碰网络、localStorage、定时器、宿主 API 或全局焦点。每个挂载点
   （root）持有自己的监听与状态，互不影响。

   用法：
     var controller = HanaCardStyle.mount(document.querySelector('.hs-page'));
     controller.destroy();                    // 还原 DOM、释放监听，可再次 mount
     var chart = HanaCardStyle.renderLineChart(el, { labels, series, unit });
     chart.destroy();
     HanaCardStyle.renderChart(el, { kind: 'column', labels, series, unit });

   mount(root) 识别这些显式标记：
     [data-hs-tabs]            tablist 容器；[data-hs-tab="v"] 按钮，[data-hs-panel="v"] 面板
     [data-hs-select]          包住一个原生 <select>；原生 select 仍是值接口
     [data-hs-range]           type=range 的 input；JS 只负责轨道填充比例
     [data-hs-media-group]     图组容器；[data-hs-layout="v"] 按钮，[data-hs-media-item]
                               图项（data-in="v1 v2"），[data-hs-media-status] 状态行
   ========================================================================== */
(function (global) {
  'use strict';

  var MOUNT_KEY = '__hanaCardStyleMount';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uidCounter = 0;

  /* ── 小工具 ─────────────────────────────────────────────────────── */
  function slice(list) { return Array.prototype.slice.call(list); }

  function fail(message) { throw new Error(message); }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function uid(prefix) { uidCounter += 1; return 'hs-' + prefix + '-' + uidCounter; }

  function format(value, unit) { return unit ? value + ' ' + unit : String(value); }

  function round(value) { return Math.round(value * 100) / 100; }

  function element(doc, tag, attrs, text) {
    var node = doc.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        if (attrs[key] == null) continue;
        node.setAttribute(key, String(attrs[key]));
      }
    }
    if (text != null) node.textContent = String(text);
    return node;
  }

  function svgElement(doc, tag, attrs) {
    var node = doc.createElementNS(SVGNS, tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        if (attrs[key] == null) continue;
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  function snapshotAttributes(el) {
    var map = {};
    for (var i = 0; i < el.attributes.length; i += 1) {
      map[el.attributes[i].name] = el.attributes[i].value;
    }
    return map;
  }

  function restoreAttributes(el, map) {
    for (var i = el.attributes.length - 1; i >= 0; i -= 1) {
      var name = el.attributes[i].name;
      if (!Object.prototype.hasOwnProperty.call(map, name)) el.removeAttribute(name);
    }
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      if (el.getAttribute(key) !== map[key]) el.setAttribute(key, map[key]);
    }
  }

  /* 取一个“好看”的刻度步长：1 / 2 / 5 / 10 的整数倍。 */
  function niceTicks(max, count) {
    if (!isFiniteNumber(max) || max <= 0) return { top: 1, ticks: [0, 1] };
    var raw = max / count;
    var exponent = Math.floor(Math.log(raw) / Math.LN10);
    var base = Math.pow(10, exponent);
    var normalized = raw / base;
    var step;
    if (normalized <= 1) step = 1;
    else if (normalized <= 2) step = 2;
    else if (normalized <= 5) step = 5;
    else step = 10;
    step *= base;
    var top = Math.ceil(max / step) * step;
    return { top: axisNumber(top, step), ticks: tickSeries(0, top, step) || [] };
  }

  /* 有界刻度序列。极端量级下累加会停在原地（`value += step` 变成 Infinity），
     无界循环会一路 push 到数组长度溢出——那时真正的报错信息会被 "Invalid array
     length" 顶掉，而作者看到的是一句与数据无关的内部错误。这里给序列一个硬上界，
     超界返回 null，把“这个域画不出来”交回调用方去明确报错。 */
  var MAX_TICK_COUNT = 64;
  function tickSeries(from, to, step) {
    if (!isFiniteNumber(from) || !isFiniteNumber(to) || !isFiniteNumber(step) || !(step > 0)) return null;
    var values = [];
    for (var value = from; value <= to + step * 1e-9; value += step) {
      values.push(axisNumber(value, step));
      if (values.length > MAX_TICK_COUNT) return null;
    }
    return values;
  }

  /* 刻度值的收敛：常规量级仍四舍五入到两位小数（与定稿几何逐字一致）；步长比
     0.01 还小时，两位小数会把刻度抹成一排 0、甚至把 top 抹成 0 之后引入除零，
     这类量级改为保留 12 位有效数字，值本身不再丢失。 */
  function axisNumber(value, step) {
    if (!isFiniteNumber(value)) return value;
    if (Math.abs(step) >= 0.01 && Math.abs(value) < 1e6) return round(value);
    return Number(value.toPrecision(12));
  }

  function tickStep(scale) {
    return scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : scale.top;
  }

  /* 覆盖数据全段、且一定包含 0 的刻度域。全正数据走的仍是原来那条路径（bottom
     恒为 0，top 与步长与 niceTicks 完全一致），定稿几何不变；出现负值时用同一
     步长向下延伸，零基线因此始终留在视口内，而不是被画到轴外。 */
  function axisScale(min, max, count) {
    if (min >= 0) {
      var positiveOnly = niceTicks(max, count);
      return { top: positiveOnly.top, bottom: 0, step: tickStep(positiveOnly), ticks: positiveOnly.ticks };
    }
    if (max <= 0) {
      var step = tickStep(niceTicks(-min, count));
      var bottom = -Math.ceil(-min / step - 1e-9) * step;
      return { top: 0, bottom: axisNumber(bottom, step), step: step, ticks: tickSeries(bottom, 0, step) || [] };
    }
    var positive = niceTicks(max, count);
    var mixedStep = tickStep(positive);
    var mixedBottom = -Math.ceil(-min / mixedStep - 1e-9) * mixedStep;
    return {
      top: positive.top,
      bottom: axisNumber(mixedBottom, mixedStep),
      step: mixedStep,
      ticks: tickSeries(mixedBottom, positive.top, mixedStep) || [],
    };
  }

  /* 极端 finite 会让刻度域自己溢出（top 变 Infinity、步长归零）。这时明确报错，
     让作者去调单位或量级，绝不把坏值当 0 画出去。 */
  function assertDrawableScale(api, scale) {
    var span = scale.top - scale.bottom;
    if (!isFiniteNumber(scale.top) || !isFiniteNumber(scale.bottom) || !isFiniteNumber(scale.step)
      || !(scale.step > 0) || !isFiniteNumber(span) || !(span > 0)) {
      fail(api + ': 数值超出可绘制的刻度范围，请调整单位或数据量级');
    }
  }

  /* 一组有限数字连同 0 一起的边界：零基线必须在视口内，所以 0 永远在域里。 */
  function numericBounds(values) {
    var min = 0;
    var max = 0;
    values.forEach(function (value) {
      if (value < min) min = value;
      if (value > max) max = value;
    });
    return { min: min, max: max };
  }

  /* 刻度文字：常规量级保持两位小数的原样；极小或极大改用科学记数，避开“一排
     都显示成 0”和“一长串数字”两种不可读。 */
  function formatTick(value) {
    if (!isFiniteNumber(value)) return String(value);
    if (value === 0) return '0';
    var magnitude = Math.abs(value);
    if (magnitude >= 0.01 && magnitude < 1e6) return String(round(value));
    return value.toExponential();
  }

  /* 轴说明：全正数据保持“从 0 起”的定稿说法，出现负值时如实写出区间与基线。 */
  function verticalRangeText(scale) {
    return scale.bottom === 0
      ? '纵轴从 0 起'
      : '纵轴为 ' + formatTick(scale.bottom) + ' 到 ' + formatTick(scale.top) + '，0 位于基线';
  }

  function zeroLineText(scale) {
    return scale.bottom === 0
      ? '坐标从 0 起'
      : '坐标为 ' + formatTick(scale.bottom) + ' 到 ' + formatTick(scale.top) + '，0 为基线';
  }

  /* 读数与数据表里显示的数字：经 Intl.NumberFormat 收敛，浮点误差（0.1 + 0.2）不会
     漏到屏幕上。常规量级最多保留 digits 位小数，比 0.01 还小的非零值改取 4 位有效
     数字，避免被抹成 0；不使用千分位，与数据表里的原值保持同一写法。 */
  var numberFormats = {};
  function formatNumber(value, digits) {
    if (!isFiniteNumber(value)) return String(value);
    if (value === 0) return '0';
    var fraction = digits == null ? 2 : digits;
    var small = Math.abs(value) < Math.pow(10, -fraction);
    var key = small ? 's' : 'f' + fraction;
    var text;
    if (typeof Intl !== 'undefined' && Intl.NumberFormat) {
      if (!numberFormats[key]) {
        numberFormats[key] = new Intl.NumberFormat('zh-CN', small
          ? { maximumSignificantDigits: 4, useGrouping: false }
          : { maximumFractionDigits: fraction, useGrouping: false });
      }
      text = numberFormats[key].format(value);
    } else {
      text = small ? String(Number(value.toPrecision(4))) : String(Math.round(value * Math.pow(10, fraction)) / Math.pow(10, fraction));
    }
    return text === '-0' ? '0' : text;
  }

  function formatReading(value, unit) { return unit ? formatNumber(value) + ' ' + unit : formatNumber(value); }

  /* 占比：最多一位小数；非零但不足 0.1% 的写成“<0.1%”，不抹成 0 也不拖出长尾小数。 */
  function formatPercent(fraction) {
    var percent = fraction * 100;
    if (percent > 0 && percent < 0.05) return '<0.1%';
    return formatNumber(percent, 1) + '%';
  }

  /* 图表最小宽度：默认值写在 CSS 里（折线 520px、条形 440px），这里只在作者显式
     给出 spec.minWidth 时覆盖。0 表示完全跟随容器宽度（幻灯片等由父级定尺寸的场合）。
     也可以不经 spec，直接在祖先上设置 CSS 变量 --hs-chart-min-width。 */
  function readMinWidth(api, spec) {
    if (spec.minWidth == null) return null;
    if (!isFiniteNumber(spec.minWidth) || spec.minWidth < 0) {
      fail(api + ': spec.minWidth 必须是不小于 0 的有限数字（像素），收到 ' + String(spec.minWidth));
    }
    return spec.minWidth;
  }

  function applyMinWidth(wrap, minWidth) {
    if (minWidth == null) return;
    wrap.style.setProperty('--hs-chart-min-width', minWidth + 'px');
  }

  /* 所有图表共用的外框：横滚区 + 带标题/描述的 SVG。 */
  function chartFrame(doc, options) {
    var wrap = element(doc, 'div', { 'class': 'hs-chart-wrap' });
    var scroll = element(doc, 'div', {
      'class': 'hs-chart-scroll', tabindex: '0', role: 'group', 'aria-label': options.ariaLabel,
    });
    var titleId = uid('cs-title');
    var descId = uid('cs-desc');
    var chart = svgElement(doc, 'svg', {
      'class': options.className, viewBox: '0 0 ' + options.width + ' ' + options.height,
      role: 'img', 'aria-labelledby': titleId + ' ' + descId,
    });
    var title = svgElement(doc, 'title', { id: titleId });
    title.textContent = options.title;
    chart.appendChild(title);
    var desc = svgElement(doc, 'desc', { id: descId });
    desc.textContent = options.desc;
    chart.appendChild(desc);
    scroll.appendChild(chart);
    wrap.appendChild(scroll);
    return { wrap: wrap, scroll: scroll, chart: chart };
  }

  /* 图下“查看数据”折叠区里的同一份数据表：headers 为表头文字，
     rows 为 [{ label, cells: [文本…] }]。 */
  function dataDisclosure(doc, headers, rows) {
    var details = element(doc, 'details', { 'class': 'hs-disclosure' });
    details.appendChild(element(doc, 'summary', null, '查看数据'));
    var detailsBody = element(doc, 'div', { 'class': 'hs-disclosure-body hs-stack' });
    var tableRegion = element(doc, 'div', { 'class': 'hs-table-region', tabindex: '0', role: 'region', 'aria-label': '数据表，可横向滚动' });
    var table = element(doc, 'table', { 'class': 'hs-table' });
    var thead = element(doc, 'thead');
    var headRow = element(doc, 'tr');
    headers.forEach(function (header) {
      headRow.appendChild(element(doc, 'th', { scope: 'col' }, header));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = element(doc, 'tbody');
    rows.forEach(function (rowData) {
      var row = element(doc, 'tr');
      row.appendChild(element(doc, 'th', { scope: 'row' }, rowData.label));
      rowData.cells.forEach(function (cell) { row.appendChild(element(doc, 'td', null, cell)); });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableRegion.appendChild(table);
    detailsBody.appendChild(tableRegion);
    details.appendChild(detailsBody);
    return details;
  }

  /* 渲染句柄：destroy 先跑本次渲染的清理栈，再移除本次生成的节点，可重复调用。 */
  function chartHandle(created, cleanup) {
    return {
      destroy: function () {
        cleanup();
        created.forEach(function (node) {
          if (node.parentNode) node.parentNode.removeChild(node);
        });
        created.length = 0;
      },
    };
  }

  function cleanupStack() {
    var cleanups = [];
    return {
      add: function (fn) { cleanups.push(fn); },
      run: function () {
        for (var i = cleanups.length - 1; i >= 0; i -= 1) {
          try { cleanups[i](); } catch (error) { /* 单个失败不阻塞其余 */ }
        }
        cleanups.length = 0;
      },
    };
  }

  /* 读数提示框贴到 viewBox 坐标 (x, y)：按 SVG 实际渲染尺寸换算，并夹在容器内。 */
  function anchorTip(chart, wrap, tip, viewWidth, viewHeight, x, y) {
    if (typeof chart.getBoundingClientRect !== 'function' || typeof wrap.getBoundingClientRect !== 'function') return;
    var chartRect = chart.getBoundingClientRect();
    var wrapRect = wrap.getBoundingClientRect();
    if (!chartRect.width || !wrapRect.width) return;
    var left = (chartRect.left - wrapRect.left) + x * (chartRect.width / viewWidth);
    var top = (chartRect.top - wrapRect.top) + y * (chartRect.height / viewHeight);
    var half = (tip.offsetWidth || 0) / 2;
    var min = 6 + half;
    var max = wrapRect.width - 6 - half;
    if (max >= min) {
      if (left < min) left = min;
      if (left > max) left = max;
    } else {
      left = wrapRect.width / 2;
    }
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function setHidden(node, hidden) {
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  /* 一组可聚焦的读数单元（柱组、扇区）共用的指针与键盘接线：悬停、聚焦、点按选中并
     出提示，方向键/Home/End 换单元，Enter/Space 出提示。返回前把监听登记进清理栈。 */
  function bindReadingGroups(groups, handlers, addCleanup) {
    groups.forEach(function (group, index) {
      var onEnter = function () { handlers.select(index, true); };
      var onLeave = function () { handlers.hide(); };
      var onFocus = function () { handlers.select(index, true); };
      var onBlur = function () { handlers.hide(); };
      var onClick = function () { handlers.select(index, true); };
      var onKeyDown = function (event) {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); handlers.focus(index + 1); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); handlers.focus(index - 1); }
        else if (event.key === 'Home') { event.preventDefault(); handlers.focus(0); }
        else if (event.key === 'End') { event.preventDefault(); handlers.focus(groups.length - 1); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handlers.select(index, true); }
      };
      group.addEventListener('mouseenter', onEnter);
      group.addEventListener('mouseleave', onLeave);
      group.addEventListener('focus', onFocus);
      group.addEventListener('blur', onBlur);
      group.addEventListener('click', onClick);
      group.addEventListener('keydown', onKeyDown);
      addCleanup(function () {
        group.removeEventListener('mouseenter', onEnter);
        group.removeEventListener('mouseleave', onLeave);
        group.removeEventListener('focus', onFocus);
        group.removeEventListener('blur', onBlur);
        group.removeEventListener('click', onClick);
        group.removeEventListener('keydown', onKeyDown);
      });
    });
  }

  /* ======================================================================
     mount(root)
     ====================================================================== */
  function mount(root) {
    if (!root || root.nodeType !== 1) fail('HanaCardStyle.mount(root): root 必须是一个元素');
    if (root[MOUNT_KEY]) return root[MOUNT_KEY];

    var doc = root.ownerDocument || global.document;
    var cleanups = [];
    var destroyed = false;
    var selectControllers = [];

    function addCleanup(fn) { cleanups.push(fn); }

    /* ── Tabs：role=tablist / tab / tabpanel，roving tabindex ──────── */
    function enhanceTabs() {
      slice(root.querySelectorAll('[data-hs-tabs]')).forEach(function (container) {
        var tabs = slice(container.querySelectorAll('[data-hs-tab]'));
        if (!tabs.length) return;
        var scope = container.parentNode || container;
        var panels = slice(scope.querySelectorAll('[data-hs-panel]'));
        var snapshots = [];
        var tablistId = container.id || uid('tablist');
        var firstSelected = 0;

        tabs.forEach(function (tab, index) {
          if (tab.getAttribute('aria-selected') === 'true') firstSelected = index;
        });

        snapshots.push([container, snapshotAttributes(container)]);
        tabs.forEach(function (tab, index) {
          snapshots.push([tab, snapshotAttributes(tab)]);
          var value = tab.getAttribute('data-hs-tab');
          var tabId = tab.id || (tablistId + '-tab-' + index);
          tab.id = tabId;
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-selected', String(index === firstSelected));
          tab.setAttribute('tabindex', index === firstSelected ? '0' : '-1');
          panels.forEach(function (panel) {
            if (panel.getAttribute('data-hs-panel') !== value) return;
            if (!panel.id) panel.id = tablistId + '-panel-' + panels.indexOf(panel);
            tab.setAttribute('aria-controls', panel.id);
          });
        });
        if (!container.getAttribute('role')) container.setAttribute('role', 'tablist');
        if (!container.id) container.id = tablistId;

        panels.forEach(function (panel, index) {
          snapshots.push([panel, snapshotAttributes(panel)]);
          if (!panel.id) panel.id = tablistId + '-panel-' + index;
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('tabindex', '0');
          var owner = null;
          tabs.forEach(function (tab) {
            if (tab.getAttribute('data-hs-tab') === panel.getAttribute('data-hs-panel')) owner = tab.id;
          });
          if (owner) panel.setAttribute('aria-labelledby', owner);
        });

        function activate(index, focus) {
          tabs.forEach(function (tab, i) {
            tab.setAttribute('aria-selected', String(i === index));
            tab.setAttribute('tabindex', i === index ? '0' : '-1');
          });
          panels.forEach(function (panel) {
            var on = panel.getAttribute('data-hs-panel') === tabs[index].getAttribute('data-hs-tab');
            if (on) panel.removeAttribute('hidden');
            else panel.setAttribute('hidden', '');
          });
          if (focus && typeof tabs[index].focus === 'function') tabs[index].focus();
        }

        tabs.forEach(function (tab, index) {
          var onClick = function () { activate(index, false); };
          var onKeyDown = function (event) {
            var next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            else return;
            event.preventDefault();
            activate(next, true);
          };
          tab.addEventListener('click', onClick);
          tab.addEventListener('keydown', onKeyDown);
          addCleanup(function () {
            tab.removeEventListener('click', onClick);
            tab.removeEventListener('keydown', onKeyDown);
          });
        });

        addCleanup(function () {
          snapshots.forEach(function (pair) { restoreAttributes(pair[0], pair[1]); });
        });
        activate(firstSelected, false);
      });
    }

    /* ── select：自绘触发器 + 弹层，原生 select 仍是值接口 ─────────── */
    function closeAllSelects(except) {
      selectControllers.forEach(function (controller) {
        if (controller !== except) controller.close(false);
      });
    }

    function enhanceSelects() {
      var hosts = slice(root.querySelectorAll('[data-hs-select]'));
      if (!hosts.length) return;

      hosts.forEach(function (host) {
        var nativeSelect = host.querySelector('select');
        if (!nativeSelect) return;
        var hostSnapshot = snapshotAttributes(host);
        var nativeSnapshot = snapshotAttributes(nativeSelect);
        var labelledBy = nativeSelect.getAttribute('aria-labelledby');
        var labelText = nativeSelect.getAttribute('aria-label');
        var listId = (nativeSelect.id || uid('select')) + '-listbox';
        var items = [];
        var active = -1;

        var trigger = element(doc, 'button', { type: 'button', 'class': 'hs-select__trigger' });
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', listId);
        if (labelledBy) trigger.setAttribute('aria-labelledby', labelledBy);
        else if (labelText) trigger.setAttribute('aria-label', labelText);
        var valueSpan = element(doc, 'span', { 'class': 'hs-select__value' });
        trigger.appendChild(valueSpan);
        var chevron = svgElement(doc, 'svg', {
          'class': 'hs-select__chevron', viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round',
          'stroke-linejoin': 'round', 'aria-hidden': 'true',
        });
        chevron.appendChild(svgElement(doc, 'path', { d: 'M4 6l4 4 4-4' }));
        trigger.appendChild(chevron);

        var popup = element(doc, 'div', { 'class': 'hs-select__popup', id: listId, role: 'listbox' });
        popup.hidden = true;
        if (labelledBy) popup.setAttribute('aria-labelledby', labelledBy);
        else if (labelText) popup.setAttribute('aria-label', labelText);

        slice(nativeSelect.options).forEach(function (option, index) {
          var item = element(doc, 'div', {
            'class': 'hs-select__option', role: 'option', id: listId + '-opt-' + index,
            'data-value': option.value,
          }, option.textContent);
          items.push(item);
          popup.appendChild(item);
        });

        host.appendChild(trigger);
        host.appendChild(popup);
        nativeSelect.setAttribute('aria-hidden', 'true');
        nativeSelect.setAttribute('tabindex', '-1');

        function isOpen() { return !popup.hidden; }

        function selectedIndex() {
          return nativeSelect.selectedIndex < 0 ? 0 : nativeSelect.selectedIndex;
        }

        function sync() {
          var selected = selectedIndex();
          var option = nativeSelect.options[selected];
          valueSpan.textContent = option ? option.textContent : '';
          items.forEach(function (item, i) { item.setAttribute('aria-selected', String(i === selected)); });
          if (!isOpen()) active = selected;
        }

        function setActive(index) {
          if (!items.length) return;
          active = Math.max(0, Math.min(index, items.length - 1));
          items.forEach(function (item, i) {
            if (i === active) item.setAttribute('data-active', '');
            else item.removeAttribute('data-active');
          });
          trigger.setAttribute('aria-activedescendant', items[active].id);
        }

        function open() {
          closeAllSelects(controller);
          popup.hidden = false;
          trigger.setAttribute('aria-expanded', 'true');
          setActive(selectedIndex());
        }

        function close(focus) {
          popup.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
          trigger.removeAttribute('aria-activedescendant');
          items.forEach(function (item) { item.removeAttribute('data-active'); });
          if (focus && typeof trigger.focus === 'function') trigger.focus();
        }

        function choose(index) {
          var option = nativeSelect.options[index];
          if (!option) return;
          nativeSelect.selectedIndex = index;
          sync();
          nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
          close(true);
        }

        items.forEach(function (item, index) {
          item.addEventListener('click', function () { choose(index); });
          item.addEventListener('mousemove', function () { setActive(index); });
        });

        var onTriggerClick = function () { if (isOpen()) close(false); else open(); };
        var onTriggerKeyDown = function (event) {
          var key = event.key;
          if (isOpen()) {
            if (key === 'ArrowDown') { event.preventDefault(); setActive(active + 1); }
            else if (key === 'ArrowUp') { event.preventDefault(); setActive(active - 1); }
            else if (key === 'Home') { event.preventDefault(); setActive(0); }
            else if (key === 'End') { event.preventDefault(); setActive(items.length - 1); }
            else if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(active); }
            else if (key === 'Escape') { event.preventDefault(); close(true); }
            else if (key === 'Tab') { close(false); }
          } else if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault();
            open();
          }
        };
        var onNativeChange = function () { sync(); };

        trigger.addEventListener('click', onTriggerClick);
        trigger.addEventListener('keydown', onTriggerKeyDown);
        nativeSelect.addEventListener('change', onNativeChange);

        var controller = { close: close };
        selectControllers.push(controller);
        sync();

        addCleanup(function () {
          var index = selectControllers.indexOf(controller);
          if (index >= 0) selectControllers.splice(index, 1);
          trigger.removeEventListener('click', onTriggerClick);
          trigger.removeEventListener('keydown', onTriggerKeyDown);
          nativeSelect.removeEventListener('change', onNativeChange);
          if (trigger.parentNode) trigger.parentNode.removeChild(trigger);
          if (popup.parentNode) popup.parentNode.removeChild(popup);
          restoreAttributes(host, hostSnapshot);
          restoreAttributes(nativeSelect, nativeSnapshot);
        });
      });

      var onDocumentPointerDown = function (event) {
        var target = event.target;
        if (target && target.closest && target.closest('[data-hs-select]')) return;
        closeAllSelects(null);
      };
      doc.addEventListener('pointerdown', onDocumentPointerDown);
      addCleanup(function () { doc.removeEventListener('pointerdown', onDocumentPointerDown); });
    }

    /* ── range：只负责轨道填充比例，值仍由原生 input 与 input 事件给 ── */
    function enhanceRanges() {
      slice(root.querySelectorAll('[data-hs-range]')).forEach(function (input) {
        if (input.tagName !== 'INPUT' || input.type !== 'range') return;
        function paint() {
          var min = Number(input.min);
          var max = Number(input.max);
          var value = Number(input.value);
          var percent = (isFiniteNumber(min) && isFiniteNumber(max) && max > min)
            ? ((value - min) / (max - min)) * 100 : 0;
          input.style.setProperty('--hs-range-progress', round(percent) + '%');
        }
        input.addEventListener('input', paint);
        paint();
        addCleanup(function () {
          input.removeEventListener('input', paint);
          input.style.removeProperty('--hs-range-progress');
        });
      });
    }

    /* ── 图组：按 data-in 显示对应布局的图项 ───────────────────────── */
    function enhanceMediaGroups() {
      slice(root.querySelectorAll('[data-hs-media-group]')).forEach(function (group) {
        var buttons = slice(group.querySelectorAll('[data-hs-layout]'));
        var items = slice(group.querySelectorAll('[data-hs-media-item]'));
        if (!buttons.length || !items.length) return;
        var status = group.querySelector('[data-hs-media-status]');

        function apply(layout) {
          group.setAttribute('data-layout', layout);
          var visible = 0;
          items.forEach(function (item) {
            var tokens = (item.getAttribute('data-in') || '').split(/\s+/);
            var on = tokens.indexOf(layout) > -1;
            if (on) { item.removeAttribute('hidden'); visible += 1; }
            else item.setAttribute('hidden', '');
          });
          buttons.forEach(function (button) {
            button.setAttribute('aria-pressed', String(button.getAttribute('data-hs-layout') === layout));
          });
          if (status) status.textContent = '当前显示 ' + visible + ' 张图';
        }

        buttons.forEach(function (button) {
          var onClick = function () { apply(button.getAttribute('data-hs-layout')); };
          button.addEventListener('click', onClick);
          addCleanup(function () { button.removeEventListener('click', onClick); });
        });

        var pressed = null;
        buttons.forEach(function (button) {
          if (!pressed && button.getAttribute('aria-pressed') === 'true') pressed = button;
        });
        apply(group.getAttribute('data-layout')
          || (pressed && pressed.getAttribute('data-hs-layout'))
          || buttons[0].getAttribute('data-hs-layout'));
      });
    }

    enhanceTabs();
    enhanceSelects();
    enhanceRanges();
    enhanceMediaGroups();

    var controller = {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        for (var i = cleanups.length - 1; i >= 0; i -= 1) {
          try { cleanups[i](); } catch (error) { /* 单个还原失败不阻塞其余 */ }
        }
        cleanups.length = 0;
        delete root[MOUNT_KEY];
      },
    };
    root[MOUNT_KEY] = controller;
    return controller;
  }

  /* ======================================================================
     折线图与面积图（同一套内部实现，面积图只多一层填充）
     ====================================================================== */
  var LINE = { width: 660, padLeft: 48, padRight: 20, padTop: 20, padBottom: 40, plotHeight: 172 };
  LINE.plotWidth = LINE.width - LINE.padLeft - LINE.padRight;
  LINE.axisY = LINE.padTop + LINE.plotHeight;
  LINE.height = LINE.axisY + LINE.padBottom;

  function validateLabels(labels, api) {
    if (!Array.isArray(labels) || !labels.length) fail(api + ': spec.labels 必须是非空数组');
    labels.forEach(function (label, index) {
      if (typeof label !== 'string' || !label) fail(api + ': spec.labels[' + index + '] 必须是非空字符串');
    });
  }

  /* 共享数据形状 { labels, series: [{ id, label, values }], unit }：折线、面积、柱状、
     堆叠、饼图共用同一份入口校验，幻灯片切换 kind 时无需改写数据。 */
  function readSeriesSpec(api, root, spec) {
    if (!root || root.nodeType !== 1) fail(api + '(root, spec): root 必须是一个元素');
    if (!isPlainObject(spec)) fail(api + ': spec 必须是对象');
    validateLabels(spec.labels, api);
    var labels = spec.labels;
    if (!Array.isArray(spec.series) || !spec.series.length) fail(api + ': spec.series 必须是非空数组');
    if (spec.series.length > 6) fail(api + ': 最多 6 个系列，与六个数据色一致');
    var series = spec.series.map(function (entry, index) {
      if (!isPlainObject(entry)) fail(api + ': spec.series[' + index + '] 必须是对象');
      if (typeof entry.id !== 'string' || !entry.id) fail(api + ': spec.series[' + index + '].id 必须是非空字符串');
      if (typeof entry.label !== 'string' || !entry.label) fail(api + ': spec.series[' + index + '].label 必须是非空字符串');
      if (!Array.isArray(entry.values) || entry.values.length !== labels.length) {
        fail(api + ': spec.series[' + index + '].values 的长度必须与 labels 相同');
      }
      entry.values.forEach(function (value, i) {
        if (!isFiniteNumber(value)) {
          fail(api + ': spec.series[' + index + '].values[' + i + '] 必须是有限数字，收到 ' + String(value));
        }
      });
      return { id: entry.id, label: entry.label, values: entry.values.slice() };
    });
    /* 系列 id 是图例按钮与显隐选择的键：重复会让两条线共用一个开关，入口拒绝。 */
    var seenSeriesIds = {};
    series.forEach(function (entry, index) {
      if (Object.prototype.hasOwnProperty.call(seenSeriesIds, entry.id)) {
        fail(api + ': spec.series[' + index + '].id 与前面的系列重复（' + entry.id + '）');
      }
      seenSeriesIds[entry.id] = true;
    });
    return {
      labels: labels,
      series: series,
      unit: spec.unit == null ? '' : String(spec.unit),
      minWidth: readMinWidth(api, spec),
    };
  }

  function renderLineChart(root, spec) { return buildTrendChart('renderLineChart', root, spec, false); }

  function renderAreaChart(root, spec) { return buildTrendChart('renderAreaChart', root, spec, true); }

  function buildTrendChart(api, root, spec, area) {
    var data = readSeriesSpec(api, root, spec);
    var labels = data.labels;
    var series = data.series;
    var unit = data.unit;
    /* 折线沿用定稿的原样数字写法；面积图是新增类型，读数与数据表统一经 Intl 收敛。 */
    var num = area ? function (value) { return formatNumber(value); } : String;
    function reading(value) { return unit ? num(value) + ' ' + unit : num(value); }

    var doc = root.ownerDocument || global.document;
    var created = [];
    /* 本次渲染自有的清理栈：两张图互不影响。 */
    var stack = cleanupStack();
    var addCleanup = stack.add;

    /* 纵轴覆盖数据全段并包含 0：负值因此落在视口内，全正数据走的是与定稿完全
       相同的那条路径（bottom 为 0、span 就是 top）。 */
    var lineValues = [];
    series.forEach(function (entry) { lineValues = lineValues.concat(entry.values); });
    var lineBounds = numericBounds(lineValues);
    var scale = axisScale(lineBounds.min, lineBounds.max, 3);
    assertDrawableScale(api, scale);
    var span = scale.top - scale.bottom;

    function xAt(index) {
      return labels.length > 1
        ? LINE.padLeft + index * (LINE.plotWidth / (labels.length - 1))
        : LINE.padLeft + LINE.plotWidth / 2;
    }
    function yAt(value) { return LINE.axisY - ((value - scale.bottom) / span) * LINE.plotHeight; }

    /* 图例（spec.legend === false 时不生成，由调用方自己接管选择） */
    var showLegend = spec.legend !== false;
    var legend = element(doc, 'div', { 'class': 'hs-legend', role: 'group', 'aria-label': '切换数据系列' });
    var legendButtons = series.map(function (entry, index) {
      var button = element(doc, 'button', {
        type: 'button', 'class': 'hs-button hs-legend-btn', 'data-series': entry.id, 'aria-pressed': 'true',
      });
      button.appendChild(element(doc, 'span', {
        'class': index % 2 === 0 ? 'hs-key' : 'hs-key hs-key--dashed', 'aria-hidden': 'true',
      }));
      button.appendChild(doc.createTextNode(entry.label));
      legend.appendChild(button);
      return button;
    });
    if (showLegend) created.push(legend);

    /* 画布 */
    var description = series.map(function (entry) {
      return entry.label + '：' + entry.values.map(num).join('、') + (unit ? ' ' + unit : '');
    }).join('；');
    var frame = chartFrame(doc, {
      ariaLabel: spec.ariaLabel || (area ? '面积图，窄屏时可横向滚动' : '折线图，窄屏时可横向滚动'),
      className: area ? 'hs-chart hs-chart--trend hs-chart--area' : 'hs-chart hs-chart--trend',
      width: LINE.width,
      height: LINE.height,
      title: spec.title || (labels.join('、') + '的走势'),
      desc: (area ? '面积图' : '折线图') + '，横轴为 ' + labels.join('、') + '，' + verticalRangeText(scale) + '。' + description,
    });
    var wrap = frame.wrap;
    var chart = frame.chart;
    applyMinWidth(wrap, data.minWidth);

    var gridGroup = svgElement(doc, 'g', { 'class': 'hs-chart-grid' });
    scale.ticks.forEach(function (tick) {
      var y = yAt(tick);
      gridGroup.appendChild(svgElement(doc, 'line', {
        'class': tick === 0 ? 'hs-axis' : 'hs-grid', x1: LINE.padLeft, y1: round(y), x2: LINE.padLeft + LINE.plotWidth, y2: round(y),
      }));
    });
    chart.appendChild(gridGroup);

    var tickGroup = svgElement(doc, 'g', { 'class': 'hs-chart-ticks' });
    scale.ticks.forEach(function (tick) {
      tickGroup.appendChild(svgElement(doc, 'text', {
        'class': 'hs-tick', x: LINE.padLeft - 8, y: round(yAt(tick)), 'text-anchor': 'end', 'dominant-baseline': 'middle',
      })).textContent = formatTick(tick);
    });
    if (unit) {
      var axisTitle = svgElement(doc, 'text', {
        'class': 'hs-axis-title', x: LINE.padLeft - 34, y: LINE.axisY - LINE.plotHeight / 2,
        'text-anchor': 'middle', transform: 'rotate(-90 ' + (LINE.padLeft - 34) + ' ' + (LINE.axisY - LINE.plotHeight / 2) + ')',
      });
      axisTitle.textContent = unit;
      tickGroup.appendChild(axisTitle);
    }
    labels.forEach(function (label, index) {
      tickGroup.appendChild(svgElement(doc, 'text', {
        'class': 'hs-tick', x: round(xAt(index)), y: LINE.axisY + 22, 'text-anchor': 'middle',
      })).textContent = label;
    });
    chart.appendChild(tickGroup);

    /* 折线（后画的在下层，所以倒序添加，让第一个系列压在最上） */
    var seriesGroups = [];
    for (var s = series.length - 1; s >= 0; s -= 1) {
      var entry = series[s];
      var points = entry.values.map(function (value, index) {
        return round(xAt(index)) + ',' + round(yAt(value));
      }).join(' ');
      var group = svgElement(doc, 'g', { 'class': 'hs-series', 'data-series': entry.id, 'data-series-index': s });
      /* 面积图：折线下方到零基线的填充，先画，折线压在上面。只有一个标签时没有宽度可填。 */
      if (area && labels.length > 1) {
        var zeroY = round(yAt(0));
        group.appendChild(svgElement(doc, 'polygon', {
          'class': 'hs-area', 'data-series': entry.id, 'data-series-index': s,
          points: round(xAt(0)) + ',' + zeroY + ' ' + points + ' ' + round(xAt(labels.length - 1)) + ',' + zeroY,
        }));
      }
      group.appendChild(svgElement(doc, 'polyline', {
        'class': 'hs-line', 'data-series': entry.id, 'data-series-index': s, points: points,
      }));
      chart.appendChild(group);
      seriesGroups.push(group);
    }

    /* 数据点：每天一个可聚焦组，含各系列的点与选中环 */
    var pointsGroup = svgElement(doc, 'g', { 'class': 'hs-chart-points' });
    var pointGroups = labels.map(function (label, index) {
      var summary = series.map(function (entry) {
        return entry.label + ' ' + reading(entry.values[index]);
      }).join('，');
      var group = svgElement(doc, 'g', {
        'class': 'hs-pt', 'data-day': index, tabindex: '0', role: 'img', 'aria-label': label + '：' + summary,
      });
      group.appendChild(svgElement(doc, 'rect', {
        'class': 'hs-pt-hit', x: round(xAt(index) - 14), y: LINE.padTop, width: 28, height: LINE.plotHeight, fill: 'transparent',
      }));
      series.forEach(function (entry, seriesIndex) {
        group.appendChild(svgElement(doc, 'circle', {
          'class': 'hs-pt-dot', 'data-series': entry.id, 'data-series-index': seriesIndex,
          cx: round(xAt(index)), cy: round(yAt(entry.values[index])), r: 3.6,
        }));
      });
      group.appendChild(svgElement(doc, 'circle', {
        'class': 'hs-pt-ring', cx: round(xAt(index)), cy: round(yAt(series[0].values[index])), r: 9,
      }));
      pointsGroup.appendChild(group);
      return group;
    });
    chart.appendChild(pointsGroup);

    var tip = element(doc, 'div', { 'class': 'hs-chart-tip', id: uid('cs-tip') });
    tip.hidden = true;
    wrap.appendChild(tip);
    created.push(wrap);

    var empty = element(doc, 'p', { 'class': 'hs-chart-empty' });
    empty.hidden = true;
    empty.textContent = '所有系列都隐藏了，图里暂时没有线。用上面的图例按钮把它们打开。';
    created.push(empty);

    var output = element(doc, 'output', { 'class': 'hs-chart-output', 'aria-live': 'polite' });
    created.push(output);

    var hint = element(doc, 'p', { 'class': 'hs-chart-hint' });
    hint.textContent = '点按图中的数据点，或用 ← → 选择标签。';
    created.push(hint);

    created.push(dataDisclosure(doc,
      ['标签'].concat(series.map(function (entry) { return unit ? entry.label + '（' + unit + '）' : entry.label; })),
      labels.map(function (label, index) {
        return { label: label, cells: series.map(function (entry) { return area ? formatNumber(entry.values[index], 6) : String(entry.values[index]); }) };
      })));

    created.forEach(function (node) { root.appendChild(node); });

    var current = 0;
    var buttonBySeries = {};
    legendButtons.forEach(function (button) { buttonBySeries[button.getAttribute('data-series')] = button; });

    function isVisible(entry) {
      if (!showLegend) return true;
      var button = buttonBySeries[entry.id];
      return !!button && button.getAttribute('aria-pressed') === 'true';
    }

    function daySummary() {
      var parts = [];
      series.forEach(function (entry) {
        if (isVisible(entry)) parts.push(entry.label + ' ' + reading(entry.values[current]));
      });
      return labels[current] + ' · ' + (parts.length ? parts.join(' / ') : '所有系列都已隐藏');
    }

    function positionTip(group) {
      var dot = null;
      var index = Number(group.getAttribute('data-day'));
      series.forEach(function (entry) {
        if (!dot && isVisible(entry)) {
          dot = [entry, round(xAt(index)), round(yAt(entry.values[index]))];
        }
      });
      if (!dot) return;
      anchorTip(chart, wrap, tip, LINE.width, LINE.height, dot[1], dot[2]);
    }

    function showTip(group) {
      tip.textContent = daySummary();
      tip.removeAttribute('hidden');
      positionTip(group);
    }

    function hideTip() { tip.setAttribute('hidden', ''); }

    function selectDay(index, withTip) {
      current = ((index % labels.length) + labels.length) % labels.length;
      pointGroups.forEach(function (group, i) {
        if (i === current) group.classList.add('is-active');
        else group.classList.remove('is-active');
      });
      output.textContent = daySummary();
      if (withTip) showTip(pointGroups[current]);
      else hideTip();
    }

    function focusDay(index) {
      var i = ((index % labels.length) + labels.length) % labels.length;
      if (typeof pointGroups[i].focus === 'function') pointGroups[i].focus();
      selectDay(i, true);
    }

    function syncSeries() {
      series.forEach(function (entry, seriesIndex) {
        var visible = isVisible(entry);
        seriesGroups.forEach(function (group) {
          if (group.getAttribute('data-series') === entry.id) setHidden(group, !visible);
        });
        slice(chart.querySelectorAll('.hs-pt-dot[data-series-index="' + seriesIndex + '"]')).forEach(function (dot) {
          setHidden(dot, !visible);
        });
      });
      var anyVisible = series.some(isVisible);
      setHidden(empty, anyVisible);
      /* 选中环跟到最上面一个可见系列的高度 */
      var anchor = null;
      series.forEach(function (entry) {
        if (!anchor && isVisible(entry)) anchor = entry;
      });
      pointGroups.forEach(function (group, index) {
        var ring = group.querySelector('.hs-pt-ring');
        if (!ring || !anchor) return;
        ring.setAttribute('cy', round(yAt(anchor.values[index])));
      });
      hideTip();
      selectDay(current, false);
    }

    legendButtons.forEach(function (button) {
      if (!showLegend) return;
      var onClick = function () {
        var on = button.getAttribute('aria-pressed') === 'true';
        button.setAttribute('aria-pressed', on ? 'false' : 'true');
        syncSeries();
      };
      button.addEventListener('click', onClick);
      addCleanup(function () { button.removeEventListener('click', onClick); });
    });

    pointGroups.forEach(function (group, index) {
      var onEnter = function () { selectDay(index, true); };
      var onLeave = function () { hideTip(); };
      var onFocus = function () { selectDay(index, true); };
      var onBlur = function () { hideTip(); };
      var onClick = function () { selectDay(index, true); };
      var onKeyDown = function (event) {
        var base = Number(group.getAttribute('data-day'));
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusDay(base + 1); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusDay(base - 1); }
        else if (event.key === 'Home') { event.preventDefault(); focusDay(0); }
        else if (event.key === 'End') { event.preventDefault(); focusDay(labels.length - 1); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showTip(group); }
      };
      group.addEventListener('mouseenter', onEnter);
      group.addEventListener('mouseleave', onLeave);
      group.addEventListener('focus', onFocus);
      group.addEventListener('blur', onBlur);
      group.addEventListener('click', onClick);
      group.addEventListener('keydown', onKeyDown);
      addCleanup(function () {
        group.removeEventListener('mouseenter', onEnter);
        group.removeEventListener('mouseleave', onLeave);
        group.removeEventListener('focus', onFocus);
        group.removeEventListener('blur', onBlur);
        group.removeEventListener('click', onClick);
        group.removeEventListener('keydown', onKeyDown);
      });
    });

    syncSeries();

    return chartHandle(created, stack.run);
  }

  /* ======================================================================
     横向条形图
     ====================================================================== */
  var BAR = { width: 660, x0: 56, plotWidth: 460, height: 22, rowPitch: 40, top: 10, radius: 3 };

  /* 每个角用两段三次贝塞尔近似连续曲率（squircle），r 缩放时几何同比变化。 */
  function squircleBarPath(x, y, width, height, radius) {
    var r = Math.max(0, Math.min(radius, width / 2, height / 2));
    if (r === 0) {
      return 'M' + x + ' ' + y + 'h' + width + 'v' + height + 'h' + -width + 'Z';
    }
    var r2 = r * 2 / 3;
    var r3 = r / 3;
    var r6 = r / 6;
    var x1 = x + r;
    var x2 = x + width - r;
    var y1 = y + r;
    var y2 = y + height - r;
    var xr = x + width;
    var yb = y + height;
    return [
      'M', x1, y,
      'H', x2,
      'C', xr - r2, y, xr - r3, y, xr - r6, y + r6,
      'C', xr, y + r3, xr, y + r2, xr, y1,
      'V', y2,
      'C', xr, yb - r2, xr, yb - r3, xr - r6, yb - r6,
      'C', xr - r3, yb, xr - r2, yb, x2, yb,
      'H', x1,
      'C', x + r2, yb, x + r3, yb, x + r6, yb - r6,
      'C', x, yb - r3, x, yb - r2, x, y2,
      'V', y1,
      'C', x, y + r2, x, y + r3, x + r6, y + r6,
      'C', x + r3, y, x + r2, y, x1, y,
      'Z',
    ].join(' ');
  }

  function renderBarChart(root, spec) {
    if (!root || root.nodeType !== 1) fail('renderBarChart(root, spec): root 必须是一个元素');
    if (!isPlainObject(spec)) fail('renderBarChart: spec 必须是对象');
    var api = 'renderBarChart';
    if (!Array.isArray(spec.items) || !spec.items.length) fail(api + ': spec.items 必须是非空数组');
    var items = spec.items.map(function (item, index) {
      if (!isPlainObject(item)) fail(api + ': spec.items[' + index + '] 必须是对象');
      if (typeof item.label !== 'string' || !item.label) fail(api + ': spec.items[' + index + '].label 必须是非空字符串');
      if (!isFiniteNumber(item.value)) {
        fail(api + ': spec.items[' + index + '].value 必须是有限数字，收到 ' + String(item.value));
      }
      return { label: item.label, value: item.value };
    });
    var unit = spec.unit == null ? '' : String(spec.unit);
    var minWidth = readMinWidth(api, spec);

    var doc = root.ownerDocument || global.document;
    var created = [];
    /* 条形图当前只生成 DOM，没有事件监听；保留同一形状的清理约定。 */
    var stack = cleanupStack();

    var total = 0;
    items.forEach(function (item) { total += item.value; });
    /* 与折线同一套域：包含 0，负值因此从零基线往左画，且不会跑出视口。全正
       数据下 bottom 为 0，perUnit 与定稿完全一致。 */
    var barBounds = numericBounds(items.map(function (item) { return item.value; }));
    var scale = axisScale(barBounds.min, barBounds.max, 3);
    assertDrawableScale(api, scale);
    var perUnit = BAR.plotWidth / (scale.top - scale.bottom);
    var zeroX = BAR.x0 + (0 - scale.bottom) * perUnit;

    function barTop(index) { return BAR.top + index * BAR.rowPitch; }
    var lastBottom = barTop(items.length - 1) + BAR.height;
    var axisY = lastBottom + 8;
    var tickY = axisY + 16;
    var height = tickY + 14;

    var frame = chartFrame(doc, {
      ariaLabel: spec.ariaLabel || '横向条形图，窄屏时可横向滚动',
      className: 'hs-chart hs-chart--bars',
      width: BAR.width,
      height: height,
      title: spec.title || '各项目的数值',
      desc: '横向条形图，' + zeroLineText(scale) + '。' + items.map(function (item) {
        return item.label + ' ' + format(item.value, unit);
      }).join('，') + '，合计 ' + format(round(total), unit) + '。',
    });
    var wrap = frame.wrap;
    var chart = frame.chart;
    applyMinWidth(wrap, minWidth);

    var gridGroup = svgElement(doc, 'g', { 'class': 'hs-chart-grid' });
    scale.ticks.forEach(function (tick) {
      var x = BAR.x0 + (tick - scale.bottom) * perUnit;
      gridGroup.appendChild(svgElement(doc, 'line', {
        'class': tick === 0 ? 'hs-axis' : 'hs-grid', x1: round(x), y1: 6, x2: round(x), y2: axisY,
      }));
    });
    chart.appendChild(gridGroup);

    items.forEach(function (item, index) {
      var y = barTop(index);
      /* 长度严格等于 |value| × perUnit：圆角由路径自己按宽高 clamp，绝不拿最小
         圆角去撑大一个真实长度不足的小正值，也不把负值当成 0。 */
      var width = Math.abs(item.value) * perUnit;
      var startX = item.value >= 0 ? zeroX : zeroX - width;
      chart.appendChild(svgElement(doc, 'text', {
        'class': 'hs-bar-label', x: BAR.x0 - 8, y: round(y + BAR.height / 2), 'text-anchor': 'end', 'dominant-baseline': 'middle',
      })).textContent = item.label;
      var bar = svgElement(doc, 'path', {
        'class': 'hs-bar', 'data-series-index': index % 6, 'data-label': item.label,
        d: squircleBarPath(startX, y, width, BAR.height, BAR.radius),
      });
      bar.appendChild(svgElement(doc, 'title')).textContent = item.label + ' ' + format(item.value, unit);
      chart.appendChild(bar);
      /* 读数贴在条形自己的那一侧：负值靠零基线右对齐，不会挤进左侧的名称栏。 */
      var valueAttrs = {
        'class': 'hs-bar-value', x: round(item.value >= 0 ? zeroX + width + 8 : zeroX - 6),
        y: round(y + BAR.height / 2), 'dominant-baseline': 'middle',
      };
      if (item.value < 0) valueAttrs['text-anchor'] = 'end';
      chart.appendChild(svgElement(doc, 'text', valueAttrs)).textContent = String(item.value);
    });

    var tickGroup = svgElement(doc, 'g', { 'class': 'hs-chart-ticks' });
    scale.ticks.forEach(function (tick) {
      var x = BAR.x0 + (tick - scale.bottom) * perUnit;
      tickGroup.appendChild(svgElement(doc, 'line', {
        'class': 'hs-tick-mark', x1: round(x), y1: axisY - 2, x2: round(x), y2: axisY + 2,
      }));
      tickGroup.appendChild(svgElement(doc, 'text', {
        'class': 'hs-tick', x: round(x), y: tickY, 'text-anchor': 'middle',
      })).textContent = formatTick(tick);
    });
    chart.appendChild(tickGroup);

    created.push(wrap);

    if (unit) {
      var caption = element(doc, 'p', { 'class': 'hs-chart-hint' });
      caption.textContent = '单位：' + unit + '。';
      created.push(caption);
    }

    created.push(dataDisclosure(doc, ['项目', unit || '数值'], items.map(function (item) {
      return { label: item.label, cells: [String(item.value)] };
    })));

    created.forEach(function (node) { root.appendChild(node); });

    return chartHandle(created, stack.run);
  }

  /* ======================================================================
     柱状图与堆叠柱状图
     ====================================================================== */
  var COLUMN = {
    width: 660, padLeft: 48, padRight: 20, padTop: 26, plotHeight: 172,
    groupFill: 0.72, stackFill: 0.62, barMax: 56, stackMax: 64, gap: 3, radius: 3,
  };
  COLUMN.plotWidth = COLUMN.width - COLUMN.padLeft - COLUMN.padRight;
  COLUMN.axisY = COLUMN.padTop + COLUMN.plotHeight;

  /* 数字标签是否放得进一个宽度里（按数字字符的大致宽度估算）；放不下就省略，读数与
     数据表仍然完整。 */
  function labelFits(text, width) { return String(text).length * 7.2 + 4 <= width; }

  /* 系列图例：interactive 时是可切换显隐的按钮组，否则是静态列表。色块用数据色，
     名称直接写出，不靠颜色单独传达。 */
  function seriesKey(doc, series, interactive) {
    var legend;
    if (interactive) {
      legend = element(doc, 'div', { 'class': 'hs-legend', role: 'group', 'aria-label': '切换数据系列' });
    } else {
      legend = element(doc, 'ul', { 'class': 'hs-legend hs-legend--static', 'aria-label': '数据系列' });
    }
    var items = series.map(function (entry, index) {
      var item;
      if (interactive) {
        item = element(doc, 'button', {
          type: 'button', 'class': 'hs-button hs-legend-btn', 'data-series': entry.id, 'aria-pressed': 'true',
        });
      } else {
        item = element(doc, 'li', { 'class': 'hs-legend-item', 'data-series': entry.id });
      }
      item.appendChild(element(doc, 'span', {
        'class': 'hs-swatch', 'data-series-index': index % 6, 'aria-hidden': 'true',
      }));
      item.appendChild(doc.createTextNode(entry.label));
      legend.appendChild(item);
      return item;
    });
    return { legend: legend, items: items };
  }

  function renderColumnChart(root, spec) { return buildColumnChart('renderColumnChart', root, spec, false); }

  function renderStackedColumnChart(root, spec) { return buildColumnChart('renderStackedColumnChart', root, spec, true); }

  function buildColumnChart(api, root, spec, stacked) {
    var data = readSeriesSpec(api, root, spec);
    var labels = data.labels;
    var series = data.series;
    var unit = data.unit;
    var count = labels.length;
    var normalize = false;
    var negativeStack = false;
    var totals = [];

    if (stacked) {
      if (spec.normalize != null && typeof spec.normalize !== 'boolean') {
        fail(api + ': spec.normalize 必须是布尔值，收到 ' + String(spec.normalize));
      }
      normalize = spec.normalize === true;
      var hasPositive = false;
      var hasNegative = false;
      series.forEach(function (entry) {
        entry.values.forEach(function (value) {
          if (value > 0) hasPositive = true;
          if (value < 0) hasNegative = true;
        });
      });
      if (hasPositive && hasNegative) {
        fail(api + ': 堆叠柱状图的数值不能正负混合（同一根柱里的正负段会互相抵消，占比失去意义），'
          + '请只用非负或只用非正的数据；需要正负并列时改用 renderColumnChart');
      }
      negativeStack = hasNegative;
      labels.forEach(function (label, index) {
        var total = 0;
        series.forEach(function (entry) { total += entry.values[index]; });
        totals.push(total);
      });
      totals.forEach(function (total, index) {
        if (!isFiniteNumber(total)) fail(api + ': ' + labels[index] + ' 的合计超出可计算的范围，请调整单位或数据量级');
      });
      if (normalize && !totals.some(function (total) { return total !== 0; })) {
        fail(api + ': normalize 需要至少一根柱的合计不为 0');
      }
    }

    var doc = root.ownerDocument || global.document;
    var created = [];
    var stack = cleanupStack();
    var addCleanup = stack.add;

    var scale;
    if (stacked && normalize) {
      scale = negativeStack
        ? { top: 0, bottom: -100, step: 25, ticks: [-100, -75, -50, -25, 0] }
        : { top: 100, bottom: 0, step: 25, ticks: [0, 25, 50, 75, 100] };
    } else {
      var domainValues = [];
      if (stacked) domainValues = totals;
      else series.forEach(function (entry) { domainValues = domainValues.concat(entry.values); });
      var bounds = numericBounds(domainValues);
      scale = axisScale(bounds.min, bounds.max, 3);
    }
    assertDrawableScale(api, scale);
    var span = scale.top - scale.bottom;
    var hasBelow = scale.bottom < 0;
    var height = COLUMN.axisY + 40 + (hasBelow ? 14 : 0);
    var tickLabelY = COLUMN.axisY + 22 + (hasBelow ? 14 : 0);

    function yAt(value) { return COLUMN.axisY - ((value - scale.bottom) / span) * COLUMN.plotHeight; }
    var zeroY = yAt(0);
    var band = COLUMN.plotWidth / count;
    function centerX(index) { return COLUMN.padLeft + band * (index + 0.5); }
    function tickText(tick) { return normalize ? formatTick(tick) + '%' : formatTick(tick); }

    /* 单根柱 / 一组柱的宽度：分组时同组等宽，封顶，避免标签少时柱子宽得离谱。 */
    var groupSize = stacked ? 1 : series.length;
    var barWidth = stacked
      ? Math.max(1, Math.min(COLUMN.stackMax, band * COLUMN.stackFill))
      : Math.max(1, Math.min(COLUMN.barMax, (band * COLUMN.groupFill - COLUMN.gap * (groupSize - 1)) / groupSize));
    var clusterWidth = groupSize * barWidth + (groupSize - 1) * COLUMN.gap;

    /* 每个标签下各系列的几何：{ x, y, w, h, value, share }，y/h 已换算成像素；
       y 恒为这根柱（或这一段）最上方的像素。 */
    function columnShapes(index) {
      var shapes = [];
      var left = centerX(index) - clusterWidth / 2;
      if (!stacked) {
        series.forEach(function (entry, j) {
          var value = entry.values[index];
          var h = Math.abs(value) / span * COLUMN.plotHeight;
          shapes.push({
            x: left + j * (barWidth + COLUMN.gap), w: barWidth, h: h,
            y: value >= 0 ? zeroY - h : zeroY, value: value, share: null,
          });
        });
        return shapes;
      }
      var cursor = 0;
      var total = totals[index];
      series.forEach(function (entry) {
        var value = entry.values[index];
        var share = normalize ? (total === 0 ? 0 : Math.abs(value) / Math.abs(total)) : null;
        var size = normalize ? share * 100 : Math.abs(value);
        var h = size / span * COLUMN.plotHeight;
        shapes.push({
          x: left, w: barWidth, h: h, value: value, share: share,
          y: negativeStack ? zeroY + cursor : zeroY - cursor - h,
        });
        cursor += h;
      });
      return shapes;
    }

    var showLegend = spec.legend !== false;
    var key = seriesKey(doc, series, !stacked);
    if (showLegend) created.push(key.legend);

    var kindText = stacked ? (normalize ? '百分比堆叠柱状图' : '堆叠柱状图') : '柱状图';
    var describe = series.map(function (entry) {
      return entry.label + '：' + entry.values.map(function (value) { return formatNumber(value); }).join('、') + (unit ? ' ' + unit : '');
    }).join('；');
    var axisNote = normalize ? '纵轴为各柱内的占比，0 到 100%' : verticalRangeText(scale);
    var frame = chartFrame(doc, {
      ariaLabel: spec.ariaLabel || kindText + '，窄屏时可横向滚动',
      className: 'hs-chart hs-chart--columns' + (stacked ? ' hs-chart--stacked' : ''),
      width: COLUMN.width,
      height: height,
      title: spec.title || labels.join('、') + '的数值',
      desc: kindText + '，横轴为 ' + labels.join('、') + '，' + axisNote + '。' + describe,
    });
    var wrap = frame.wrap;
    var chart = frame.chart;
    applyMinWidth(wrap, data.minWidth);

    var gridGroup = svgElement(doc, 'g', { 'class': 'hs-chart-grid' });
    scale.ticks.forEach(function (tick) {
      var y = round(yAt(tick));
      gridGroup.appendChild(svgElement(doc, 'line', {
        'class': tick === 0 ? 'hs-axis' : 'hs-grid', x1: COLUMN.padLeft, y1: y, x2: COLUMN.padLeft + COLUMN.plotWidth, y2: y,
      }));
    });
    chart.appendChild(gridGroup);

    var tickGroup = svgElement(doc, 'g', { 'class': 'hs-chart-ticks' });
    scale.ticks.forEach(function (tick) {
      tickGroup.appendChild(svgElement(doc, 'text', {
        'class': 'hs-tick', x: COLUMN.padLeft - 8, y: round(yAt(tick)), 'text-anchor': 'end', 'dominant-baseline': 'middle',
      })).textContent = tickText(tick);
    });
    var axisCaption = normalize ? '占比' : unit;
    if (axisCaption) {
      var axisTitle = svgElement(doc, 'text', {
        'class': 'hs-axis-title', x: COLUMN.padLeft - 34, y: COLUMN.axisY - COLUMN.plotHeight / 2,
        'text-anchor': 'middle', transform: 'rotate(-90 ' + (COLUMN.padLeft - 34) + ' ' + (COLUMN.axisY - COLUMN.plotHeight / 2) + ')',
      });
      axisTitle.textContent = axisCaption;
      tickGroup.appendChild(axisTitle);
    }
    labels.forEach(function (label, index) {
      tickGroup.appendChild(svgElement(doc, 'text', {
        'class': 'hs-tick', x: round(centerX(index)), y: tickLabelY, 'text-anchor': 'middle',
      })).textContent = label;
    });
    chart.appendChild(tickGroup);

    /* 读数文字：分组柱列出各可见系列；堆叠柱附合计，百分比堆叠同时给出原值。 */
    function seriesReading(entry, index) {
      var value = entry.values[index];
      if (stacked && normalize) {
        var total = totals[index];
        var share = total === 0 ? 0 : Math.abs(value) / Math.abs(total);
        return entry.label + ' ' + formatPercent(share) + '（' + formatReading(value, unit) + '）';
      }
      return entry.label + ' ' + formatReading(value, unit);
    }
    var buttonBySeries = {};
    if (!stacked) key.items.forEach(function (item) { buttonBySeries[item.getAttribute('data-series')] = item; });
    function isVisible(entry) {
      if (stacked || !showLegend) return true;
      var button = buttonBySeries[entry.id];
      return !!button && button.getAttribute('aria-pressed') === 'true';
    }

    var columnsGroup = svgElement(doc, 'g', { 'class': 'hs-chart-points' });
    var shapesByGroup = [];
    var groups = labels.map(function (label, index) {
      var shapes = columnShapes(index);
      shapesByGroup.push(shapes);
      var summary = series.map(function (entry) { return seriesReading(entry, index); }).join('，');
      if (stacked) summary += '，合计 ' + formatReading(totals[index], unit);
      var group = svgElement(doc, 'g', {
        'class': 'hs-pt hs-col-group', 'data-day': index, tabindex: '0', role: 'img', 'aria-label': label + '：' + summary,
      });
      var bandX = COLUMN.padLeft + band * index;
      group.appendChild(svgElement(doc, 'rect', {
        'class': 'hs-col-band', x: round(bandX + 1), y: COLUMN.padTop, width: round(Math.max(0, band - 2)), height: COLUMN.plotHeight,
      }));
      group.appendChild(svgElement(doc, 'rect', {
        'class': 'hs-pt-hit', x: round(bandX), y: COLUMN.padTop, width: round(band), height: COLUMN.plotHeight, fill: 'transparent',
      }));
      shapes.forEach(function (shape, j) {
        var entry = series[j];
        /* 堆叠段不加圆角、零高度的段不画：圆角会在段与段之间留缝，零高度会画出一条线。 */
        if (stacked && !(shape.h > 0)) return;
        group.appendChild(svgElement(doc, 'path', {
          'class': 'hs-col', 'data-series': entry.id, 'data-series-index': j, 'data-label': label,
          d: squircleBarPath(round(shape.x), round(shape.y), round(shape.w), round(shape.h), stacked ? 0 : COLUMN.radius),
        }));
        /* 直接标数值：放得下才画，补充颜色之外的识别线索。 */
        var text = stacked && normalize ? formatPercent(shape.share) : formatNumber(shape.value);
        var inside = stacked && shape.h >= 16 && labelFits(text, shape.w);
        var outside = !stacked && labelFits(text, shape.w + COLUMN.gap);
        if (inside || outside) {
          var labelAttrs = {
            'class': inside ? 'hs-col-value hs-col-value--inside' : 'hs-col-value', 'data-series': entry.id,
            'data-series-index': j, x: round(shape.x + shape.w / 2), 'text-anchor': 'middle',
          };
          if (inside) {
            labelAttrs.y = round(shape.y + shape.h / 2);
            labelAttrs['dominant-baseline'] = 'middle';
          } else if (shape.value >= 0) {
            labelAttrs.y = round(shape.y - 5);
          } else {
            labelAttrs.y = round(shape.y + shape.h + 14);
          }
          group.appendChild(svgElement(doc, 'text', labelAttrs)).textContent = text;
        }
      });
      if (stacked && !normalize) {
        var totalText = formatNumber(totals[index]);
        if (totals[index] !== 0 && labelFits(totalText, band)) {
          var edge = negativeStack ? zeroY + (Math.abs(totals[index]) / span) * COLUMN.plotHeight + 14 : yAt(totals[index]) - 5;
          group.appendChild(svgElement(doc, 'text', {
            'class': 'hs-col-value hs-col-total', x: round(centerX(index)), y: round(edge), 'text-anchor': 'middle',
          })).textContent = totalText;
        }
      }
      columnsGroup.appendChild(group);
      return group;
    });
    chart.appendChild(columnsGroup);

    var tip = element(doc, 'div', { 'class': 'hs-chart-tip', id: uid('cs-tip') });
    tip.hidden = true;
    wrap.appendChild(tip);
    created.push(wrap);

    var empty = element(doc, 'p', { 'class': 'hs-chart-empty' });
    empty.hidden = true;
    empty.textContent = '所有系列都隐藏了，图里暂时没有柱。用上面的图例按钮把它们打开。';
    created.push(empty);

    var output = element(doc, 'output', { 'class': 'hs-chart-output', 'aria-live': 'polite' });
    created.push(output);

    var hint = element(doc, 'p', { 'class': 'hs-chart-hint' });
    hint.textContent = '点按图中的柱，或用 ← → 选择标签。';
    created.push(hint);

    var headers = ['标签'].concat(series.map(function (entry) { return unit ? entry.label + '（' + unit + '）' : entry.label; }));
    if (stacked) headers.push(unit ? '合计（' + unit + '）' : '合计');
    created.push(dataDisclosure(doc, headers, labels.map(function (label, index) {
      var cells = series.map(function (entry) {
        var text = formatNumber(entry.values[index], 6);
        if (stacked && normalize) {
          var total = totals[index];
          text += '（' + formatPercent(total === 0 ? 0 : Math.abs(entry.values[index]) / Math.abs(total)) + '）';
        }
        return text;
      });
      if (stacked) cells.push(formatNumber(totals[index], 6));
      return { label: label, cells: cells };
    })));

    created.forEach(function (node) { root.appendChild(node); });

    var current = 0;

    function indexSummary() {
      var parts = [];
      series.forEach(function (entry) {
        if (isVisible(entry)) parts.push(seriesReading(entry, current));
      });
      var text = labels[current] + ' · ' + (parts.length ? parts.join(' / ') : '所有系列都已隐藏');
      if (stacked) text += ' · 合计 ' + formatReading(totals[current], unit);
      return text;
    }

    function showTip(index) {
      tip.textContent = indexSummary();
      tip.removeAttribute('hidden');
      var top = null;
      shapesByGroup[index].forEach(function (shape, j) {
        if (!isVisible(series[j])) return;
        if (top === null || shape.y < top) top = shape.y;
      });
      if (top === null) return;
      anchorTip(chart, wrap, tip, COLUMN.width, height, round(centerX(index)), round(top));
    }

    function hideTip() { tip.setAttribute('hidden', ''); }

    function selectIndex(index, withTip) {
      current = ((index % count) + count) % count;
      groups.forEach(function (group, i) {
        if (i === current) group.classList.add('is-active');
        else group.classList.remove('is-active');
      });
      output.textContent = indexSummary();
      if (withTip) showTip(current);
      else hideTip();
    }

    function focusIndex(index) {
      var i = ((index % count) + count) % count;
      if (typeof groups[i].focus === 'function') groups[i].focus();
      selectIndex(i, true);
    }

    function syncSeries() {
      series.forEach(function (entry, seriesIndex) {
        var visible = isVisible(entry);
        slice(chart.querySelectorAll('[data-series-index="' + seriesIndex + '"]')).forEach(function (node) {
          setHidden(node, !visible);
        });
      });
      setHidden(empty, series.some(isVisible));
      hideTip();
      selectIndex(current, false);
    }

    if (!stacked && showLegend) {
      key.items.forEach(function (button) {
        var onClick = function () {
          var on = button.getAttribute('aria-pressed') === 'true';
          button.setAttribute('aria-pressed', on ? 'false' : 'true');
          syncSeries();
        };
        button.addEventListener('click', onClick);
        addCleanup(function () { button.removeEventListener('click', onClick); });
      });
    }

    bindReadingGroups(groups, { select: selectIndex, focus: focusIndex, hide: hideTip }, addCleanup);
    syncSeries();

    return chartHandle(created, stack.run);
  }

  /* ======================================================================
     饼图与环形图
     ====================================================================== */
  var PIE = { width: 340, height: 300, cx: 170, cy: 150, radius: 128 };

  function renderPieChart(root, spec) { return buildPieChart('renderPieChart', root, spec, 0); }

  function renderDonutChart(root, spec) { return buildPieChart('renderDonutChart', root, spec, 0.6); }

  function polarPoint(radius, angle) {
    return round(PIE.cx + radius * Math.cos(angle)) + ' ' + round(PIE.cy + radius * Math.sin(angle));
  }

  /* 扇区路径：角度以 12 点钟方向起算，顺时针；整圆无法用一段弧表示，拆成两段半弧。 */
  function slicePath(start, end, inner) {
    var outer = PIE.radius;
    var sweep = end - start;
    var innerRadius = round(outer * inner);
    if (sweep >= Math.PI * 2 - 1e-9) {
      var ring = 'M' + round(PIE.cx - outer) + ' ' + PIE.cy
        + 'A' + outer + ' ' + outer + ' 0 1 1 ' + round(PIE.cx + outer) + ' ' + PIE.cy
        + 'A' + outer + ' ' + outer + ' 0 1 1 ' + round(PIE.cx - outer) + ' ' + PIE.cy + 'Z';
      if (innerRadius > 0) {
        ring += 'M' + round(PIE.cx - innerRadius) + ' ' + PIE.cy
          + 'A' + innerRadius + ' ' + innerRadius + ' 0 1 0 ' + round(PIE.cx + innerRadius) + ' ' + PIE.cy
          + 'A' + innerRadius + ' ' + innerRadius + ' 0 1 0 ' + round(PIE.cx - innerRadius) + ' ' + PIE.cy + 'Z';
      }
      return ring;
    }
    var large = sweep > Math.PI + 1e-9 ? 1 : 0;
    if (innerRadius <= 0) {
      return 'M' + PIE.cx + ' ' + PIE.cy + 'L' + polarPoint(outer, start)
        + 'A' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + polarPoint(outer, end) + 'Z';
    }
    return 'M' + polarPoint(outer, start)
      + 'A' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + polarPoint(outer, end)
      + 'L' + polarPoint(innerRadius, end)
      + 'A' + innerRadius + ' ' + innerRadius + ' 0 ' + large + ' 0 ' + polarPoint(innerRadius, start) + 'Z';
  }

  function buildPieChart(api, root, spec, defaultInner) {
    var data = readSeriesSpec(api, root, spec);
    var labels = data.labels;
    var unit = data.unit;
    if (data.series.length !== 1) {
      fail(api + ': 只接受一个系列（spec.series 长度必须为 1），收到 ' + data.series.length + ' 个；多系列请改用堆叠柱状图');
    }
    var values = data.series[0].values;
    var total = 0;
    values.forEach(function (value, index) {
      if (value < 0) {
        fail(api + ': spec.series[0].values[' + index + '] 不能是负数（' + labels[index] + '：' + formatNumber(value) + '），占比只能由非负数值构成');
      }
      total += value;
    });
    if (!isFiniteNumber(total)) fail(api + ': 数值合计超出可计算的范围，请调整单位或数据量级');
    if (!(total > 0)) fail(api + ': 数值合计为 0，无法划分扇区');
    var inner = defaultInner;
    if (spec.innerRadius != null) {
      if (!isFiniteNumber(spec.innerRadius) || spec.innerRadius < 0 || spec.innerRadius > 0.9) {
        fail(api + ': spec.innerRadius 必须是 0 到 0.9 之间的数字（外半径的比例），收到 ' + String(spec.innerRadius));
      }
      inner = spec.innerRadius;
    }

    var doc = root.ownerDocument || global.document;
    var created = [];
    var stack = cleanupStack();
    var addCleanup = stack.add;
    var donut = inner > 0;

    var entries = labels.map(function (label, index) {
      return { label: label, value: values[index], share: values[index] / total, index: index };
    });
    var drawn = entries.filter(function (entry) { return entry.value > 0; });
    function entryText(entry) {
      return entry.label + ' ' + formatReading(entry.value, unit) + '（' + formatPercent(entry.share) + '）';
    }
    function entryReading(entry) {
      return entry.label + ' · ' + formatReading(entry.value, unit) + '（' + formatPercent(entry.share) + '）';
    }

    var kindText = donut ? '环形图' : '饼图';
    var frame = chartFrame(doc, {
      ariaLabel: spec.ariaLabel || kindText + '，窄屏时可横向滚动',
      className: 'hs-chart hs-chart--pie' + (donut ? ' hs-chart--donut' : ''),
      width: PIE.width,
      height: PIE.height,
      title: spec.title || labels.join('、') + '的占比',
      desc: kindText + '，从 12 点钟方向顺时针依次为 ' + entries.map(entryText).join('，') + '，合计 ' + formatReading(total, unit) + '。',
    });
    var wrap = frame.wrap;
    var chart = frame.chart;
    applyMinWidth(wrap, data.minWidth);

    var slicesGroup = svgElement(doc, 'g', { 'class': 'hs-chart-points' });
    var cursor = 0;
    var anchors = [];
    var groups = drawn.map(function (entry) {
      var start = -Math.PI / 2 + (cursor / total) * Math.PI * 2;
      cursor += entry.value;
      var end = -Math.PI / 2 + (cursor / total) * Math.PI * 2;
      var middle = (start + end) / 2;
      var group = svgElement(doc, 'g', {
        'class': 'hs-slice-group hs-pt', 'data-slice': entry.index, tabindex: '0', role: 'img', 'aria-label': entryText(entry),
      });
      group.appendChild(svgElement(doc, 'path', {
        'class': 'hs-slice', 'data-series-index': entry.index % 6, 'data-label': entry.label,
        d: slicePath(start, end, inner), 'fill-rule': 'evenodd',
      }));
      /* 百分比直接写在扇区上：扇区太窄或环太细放不下时省略，图例和读数仍然完整。 */
      var textRadius = donut ? PIE.radius * (1 + inner) / 2 : PIE.radius * 0.64;
      var roomy = donut ? PIE.radius * (1 - inner) >= 26 : true;
      if (entry.share >= 0.07 && roomy) {
        group.appendChild(svgElement(doc, 'text', {
          'class': 'hs-slice-value', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          x: round(PIE.cx + textRadius * Math.cos(middle)), y: round(PIE.cy + textRadius * Math.sin(middle)),
        })).textContent = formatPercent(entry.share);
      }
      anchors.push([round(PIE.cx + PIE.radius * 0.9 * Math.cos(middle)), round(PIE.cy + PIE.radius * 0.9 * Math.sin(middle))]);
      slicesGroup.appendChild(group);
      return group;
    });
    chart.appendChild(slicesGroup);

    /* 环心写合计：洞够大才写，避免文字压到环上。 */
    if (inner >= 0.4) {
      var totalLabel = svgElement(doc, 'text', {
        'class': 'hs-pie-total-label', x: PIE.cx, y: PIE.cy - 8, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      });
      totalLabel.textContent = '合计';
      chart.appendChild(totalLabel);
      var totalValue = svgElement(doc, 'text', {
        'class': 'hs-pie-total', x: PIE.cx, y: PIE.cy + 12, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      });
      totalValue.textContent = formatReading(total, unit);
      chart.appendChild(totalValue);
    }

    var tip = element(doc, 'div', { 'class': 'hs-chart-tip', id: uid('cs-tip') });
    tip.hidden = true;
    wrap.appendChild(tip);

    var layout = element(doc, 'div', { 'class': 'hs-pie' });
    layout.appendChild(wrap);
    if (spec.legend !== false) {
      var list = element(doc, 'ul', { 'class': 'hs-pie-legend', 'aria-label': '各部分的数值与占比' });
      entries.forEach(function (entry) {
        var item = element(doc, 'li', { 'class': 'hs-pie-legend-item', 'data-label': entry.label });
        item.appendChild(element(doc, 'span', { 'class': 'hs-swatch', 'data-series-index': entry.index % 6, 'aria-hidden': 'true' }));
        item.appendChild(element(doc, 'span', { 'class': 'hs-pie-legend-label' }, entry.label));
        item.appendChild(element(doc, 'span', { 'class': 'hs-pie-legend-value' },
          formatReading(entry.value, unit) + ' · ' + formatPercent(entry.share)));
        list.appendChild(item);
      });
      layout.appendChild(list);
    }
    created.push(layout);

    var output = element(doc, 'output', { 'class': 'hs-chart-output', 'aria-live': 'polite' });
    created.push(output);

    var hint = element(doc, 'p', { 'class': 'hs-chart-hint' });
    hint.textContent = '点按图中的扇区，或用 ← → 选择。';
    created.push(hint);

    var valueHeader = unit ? data.series[0].label + '（' + unit + '）' : data.series[0].label;
    created.push(dataDisclosure(doc, ['标签', valueHeader, '占比'], entries.map(function (entry) {
      return { label: entry.label, cells: [formatNumber(entry.value, 6), formatPercent(entry.share)] };
    })));

    created.forEach(function (node) { root.appendChild(node); });

    var current = 0;

    function hideTip() { tip.setAttribute('hidden', ''); }

    function selectIndex(index, withTip) {
      current = ((index % drawn.length) + drawn.length) % drawn.length;
      groups.forEach(function (group, i) {
        if (i === current) group.classList.add('is-active');
        else group.classList.remove('is-active');
      });
      output.textContent = entryReading(drawn[current]);
      if (withTip) {
        tip.textContent = output.textContent;
        tip.removeAttribute('hidden');
        anchorTip(chart, wrap, tip, PIE.width, PIE.height, anchors[current][0], anchors[current][1]);
      } else {
        hideTip();
      }
    }

    function focusIndex(index) {
      var i = ((index % drawn.length) + drawn.length) % drawn.length;
      if (typeof groups[i].focus === 'function') groups[i].focus();
      selectIndex(i, true);
    }

    bindReadingGroups(groups, { select: selectIndex, focus: focusIndex, hide: hideTip }, addCleanup);
    selectIndex(0, false);

    return chartHandle(created, stack.run);
  }

  /* ======================================================================
     按 spec.kind 分发
     ====================================================================== */
  var CHART_KINDS = {
    line: renderLineChart,
    bar: renderBarChart,
    column: renderColumnChart,
    stacked: renderStackedColumnChart,
    area: renderAreaChart,
    pie: renderPieChart,
    donut: renderDonutChart,
  };

  function renderChart(root, spec) {
    if (!root || root.nodeType !== 1) fail('renderChart(root, spec): root 必须是一个元素');
    if (!isPlainObject(spec)) fail('renderChart: spec 必须是对象');
    if (typeof spec.kind !== 'string' || !Object.prototype.hasOwnProperty.call(CHART_KINDS, spec.kind)) {
      fail('renderChart: spec.kind 必须是 ' + Object.keys(CHART_KINDS).join(' / ') + ' 之一，收到 ' + String(spec.kind));
    }
    var shaped = spec;
    /* 横向条形图本身吃 items；这里允许沿用 labels + 单个系列的共享数据形状，
       让幻灯片切换 kind 时不必改写数据。 */
    if (spec.kind === 'bar' && spec.items == null) {
      var shared = readSeriesSpec('renderChart', root, spec);
      if (shared.series.length !== 1) {
        fail('renderChart: kind 为 bar 时 spec.series 只能有一个系列，收到 ' + shared.series.length + ' 个；多系列请用 column 或 stacked');
      }
      shaped = {};
      for (var key in spec) {
        if (Object.prototype.hasOwnProperty.call(spec, key)) shaped[key] = spec[key];
      }
      shaped.items = shared.labels.map(function (label, index) {
        return { label: label, value: shared.series[0].values[index] };
      });
    }
    return CHART_KINDS[spec.kind](root, shaped);
  }

  global.HanaCardStyle = {
    mount: mount,
    renderLineChart: renderLineChart,
    renderBarChart: renderBarChart,
    renderColumnChart: renderColumnChart,
    renderStackedColumnChart: renderStackedColumnChart,
    renderAreaChart: renderAreaChart,
    renderPieChart: renderPieChart,
    renderDonutChart: renderDonutChart,
    renderChart: renderChart,
  };
}(typeof window !== 'undefined' ? window : this));
