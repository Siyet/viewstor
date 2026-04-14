// Diff panel webview script
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const data = window.diffData;
  if (!data) return;

  const rowDiff = data.rowDiff;
  const schemaDiff = data.schemaDiff;
  const objectsDiff = data.objectsDiff;
  const statsDiff = data.statsDiff;
  const leftLabel = data.leftLabel || 'Left';
  const rightLabel = data.rightLabel || 'Right';
  const keyColumns = data.keyColumns || [];

  let activeTab = 'rows';
  let activeFilter = 'all';

  // ---- Tab switching ----
  const tabs = document.querySelectorAll('.diff-tab');
  const panels = document.querySelectorAll('.diff-tab-panel');

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      const target = tab.dataset.tab;
      tabs.forEach(function (tabEl) { tabEl.classList.toggle('active', tabEl.dataset.tab === target); });
      panels.forEach(function (panelEl) { panelEl.classList.toggle('active', panelEl.id === 'panel-' + target); });
      activeTab = target;
      // Stats chart needs deferred init because ECharts measures container width at init time;
      // when the tab was display:none on initial render the chart got 0 width.
      if (target === 'stats') {
        if (!window.__diffStatsRendered) {
          renderStatsDiff();
          window.__diffStatsRendered = true;
        } else if (window.__diffStatsChart) {
          window.__diffStatsChart.resize();
        }
      }
    });
  });

  // ---- Filter buttons ----
  const filterBtns = document.querySelectorAll('.diff-filter-btn');
  filterBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeFilter = btn.dataset.filter;
      filterBtns.forEach(function (filterBtnEl) { filterBtnEl.classList.toggle('active', filterBtnEl.dataset.filter === activeFilter); });
      renderRowDiff();
    });
  });

  // ---- Export buttons ----
  var exportCsvBtn = document.getElementById('exportCsv');
  var exportJsonBtn = document.getElementById('exportJson');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'exportDiff', format: 'csv' });
    });
  }
  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'exportDiff', format: 'json' });
    });
  }

  // ---- Swap sides ----
  var swapBtn = document.getElementById('swapSides');
  if (swapBtn) {
    swapBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'swapSides' });
    });
  }

  // ---- Helpers ----
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatCell(value) {
    if (value === null || value === undefined) {
      return '<span class="diff-cell-empty">NULL</span>';
    }
    if (typeof value === 'object') {
      return escapeHtml(JSON.stringify(value));
    }
    return escapeHtml(String(value));
  }

  function isKeyColumn(colName) {
    return keyColumns.indexOf(colName) !== -1;
  }

  // ---- Render row diff ----
  function renderRowDiff() {
    var leftBody = document.getElementById('leftTableBody');
    var rightBody = document.getElementById('rightTableBody');
    if (!leftBody || !rightBody || !rowDiff) return;

    var leftHtml = '';
    var rightHtml = '';
    var columns = rowDiff.allColumns;

    // Matched rows (changed + unchanged)
    for (var matchIdx = 0; matchIdx < rowDiff.matched.length; matchIdx++) {
      var match = rowDiff.matched[matchIdx];
      var isUnchanged = match.changedColumns.length === 0;
      var rowCategory = isUnchanged ? 'unchanged' : 'changed';

      // Apply filter
      if (activeFilter !== 'all' && activeFilter !== rowCategory) continue;

      var rowClass = isUnchanged ? 'diff-unchanged' : 'diff-changed';
      leftHtml += '<tr class="' + rowClass + '">';
      rightHtml += '<tr class="' + rowClass + '">';
      for (var colIdx = 0; colIdx < columns.length; colIdx++) {
        var col = columns[colIdx];
        var isCellChanged = match.changedColumns.indexOf(col) !== -1;
        var cellClass = isCellChanged ? 'diff-cell diff-cell-changed' : 'diff-cell';
        leftHtml += '<td class="' + cellClass + '">' + formatCell(match.left[col]) + '</td>';
        rightHtml += '<td class="' + cellClass + '">' + formatCell(match.right[col]) + '</td>';
      }
      leftHtml += '</tr>';
      rightHtml += '</tr>';
    }

    // Removed rows (left only)
    if (activeFilter === 'all' || activeFilter === 'removed') {
      for (var removedIdx = 0; removedIdx < rowDiff.leftOnly.length; removedIdx++) {
        var removedRow = rowDiff.leftOnly[removedIdx];
        leftHtml += '<tr class="diff-removed">';
        rightHtml += '<tr class="diff-removed">';
        for (var removedColIdx = 0; removedColIdx < columns.length; removedColIdx++) {
          var removedCol = columns[removedColIdx];
          leftHtml += '<td class="diff-cell">' + formatCell(removedRow[removedCol]) + '</td>';
          rightHtml += '<td class="diff-cell diff-cell-empty"></td>';
        }
        leftHtml += '</tr>';
        rightHtml += '</tr>';
      }
    }

    // Added rows (right only)
    if (activeFilter === 'all' || activeFilter === 'added') {
      for (var addedIdx = 0; addedIdx < rowDiff.rightOnly.length; addedIdx++) {
        var addedRow = rowDiff.rightOnly[addedIdx];
        leftHtml += '<tr class="diff-added">';
        rightHtml += '<tr class="diff-added">';
        for (var addedColIdx = 0; addedColIdx < columns.length; addedColIdx++) {
          var addedCol = columns[addedColIdx];
          leftHtml += '<td class="diff-cell diff-cell-empty"></td>';
          rightHtml += '<td class="diff-cell">' + formatCell(addedRow[addedCol]) + '</td>';
        }
        leftHtml += '</tr>';
        rightHtml += '</tr>';
      }
    }

    leftBody.innerHTML = leftHtml;
    rightBody.innerHTML = rightHtml;

    // Synchronized scrolling
    syncScroll();
  }

  // ---- Build row diff table headers ----
  function buildRowHeaders() {
    var leftHead = document.getElementById('leftTableHead');
    var rightHead = document.getElementById('rightTableHead');
    if (!leftHead || !rightHead || !rowDiff) return;

    var columns = rowDiff.allColumns;
    var headerHtml = '<tr>';
    for (var headerIdx = 0; headerIdx < columns.length; headerIdx++) {
      var col = columns[headerIdx];
      var keyClass = isKeyColumn(col) ? ' class="diff-key-col"' : '';
      headerHtml += '<th><span' + keyClass + '>' + escapeHtml(col) + '</span></th>';
    }
    headerHtml += '</tr>';
    leftHead.innerHTML = headerHtml;
    rightHead.innerHTML = headerHtml;
  }

  // ---- Synchronized scrolling between left and right panes ----
  function syncScroll() {
    var leftPane = document.getElementById('leftPane');
    var rightPane = document.getElementById('rightPane');
    if (!leftPane || !rightPane) return;

    var syncing = false;

    leftPane.addEventListener('scroll', function () {
      if (syncing) return;
      syncing = true;
      rightPane.scrollTop = leftPane.scrollTop;
      syncing = false;
    });

    rightPane.addEventListener('scroll', function () {
      if (syncing) return;
      syncing = true;
      leftPane.scrollTop = rightPane.scrollTop;
      syncing = false;
    });
  }

  // ---- Render schema diff ----
  function renderSchemaDiff() {
    var schemaBody = document.getElementById('schemaTableBody');
    if (!schemaBody) return;

    if (!schemaDiff) {
      var noSchemaEl = document.querySelector('.diff-no-schema');
      if (noSchemaEl) noSchemaEl.style.display = 'flex';
      return;
    }

    var html = '';

    // Common columns
    for (var commonIdx = 0; commonIdx < schemaDiff.commonColumns.length; commonIdx++) {
      var col = schemaDiff.commonColumns[commonIdx];
      var hasDiff = col.typeDiffers || col.nullableDiffers || col.pkDiffers;
      var statusParts = [];
      if (col.typeDiffers) statusParts.push('type');
      if (col.nullableDiffers) statusParts.push('nullable');
      if (col.pkDiffers) statusParts.push('pk');
      var statusText = hasDiff ? statusParts.join(', ') + ' differs' : 'same';
      var statusClass = hasDiff ? 'diff-status-differs' : 'diff-status-same';

      html += '<tr>';
      html += '<td>' + escapeHtml(col.name) + '</td>';
      html += '<td' + (col.typeDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + escapeHtml(col.leftType) + ' / ' + escapeHtml(col.rightType) + '</td>';
      html += '<td' + (col.nullableDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + (col.leftNullable ? 'YES' : 'NO') + ' / ' + (col.rightNullable ? 'YES' : 'NO') + '</td>';
      html += '<td' + (col.pkDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + (col.leftIsPK ? 'YES' : 'NO') + ' / ' + (col.rightIsPK ? 'YES' : 'NO') + '</td>';
      html += '<td class="' + statusClass + '">' + statusText + '</td>';
      html += '</tr>';
    }

    // Left-only columns (removed from right) — use em dash for the missing side
    for (var leftIdx = 0; leftIdx < schemaDiff.leftOnlyColumns.length; leftIdx++) {
      var leftCol = schemaDiff.leftOnlyColumns[leftIdx];
      html += '<tr class="diff-removed">';
      html += '<td>' + escapeHtml(leftCol.name) + '</td>';
      html += '<td>' + escapeHtml(leftCol.dataType) + ' / \u2014</td>';
      html += '<td>' + (leftCol.nullable ? 'YES' : 'NO') + ' / \u2014</td>';
      html += '<td>' + (leftCol.isPrimaryKey ? 'YES' : 'NO') + ' / \u2014</td>';
      html += '<td class="diff-status-removed">removed</td>';
      html += '</tr>';
    }

    // Right-only columns (added)
    for (var rightIdx = 0; rightIdx < schemaDiff.rightOnlyColumns.length; rightIdx++) {
      var rightCol = schemaDiff.rightOnlyColumns[rightIdx];
      html += '<tr class="diff-added">';
      html += '<td>' + escapeHtml(rightCol.name) + '</td>';
      html += '<td>\u2014 / ' + escapeHtml(rightCol.dataType) + '</td>';
      html += '<td>\u2014 / ' + (rightCol.nullable ? 'YES' : 'NO') + '</td>';
      html += '<td>\u2014 / ' + (rightCol.isPrimaryKey ? 'YES' : 'NO') + '</td>';
      html += '<td class="diff-status-added">added</td>';
      html += '</tr>';
    }

    schemaBody.innerHTML = html;
  }

  // ---- Render objects diff (indexes, constraints, triggers, sequences) ----
  function renderObjectsDiff() {
    var container = document.getElementById('objectsDiffContainer');
    if (!container || !objectsDiff) return;

    var sections = [
      { key: 'indexes', title: 'Indexes' },
      { key: 'constraints', title: 'Constraints' },
      { key: 'triggers', title: 'Triggers' },
      { key: 'sequences', title: 'Sequences' },
    ];

    var html = '';
    for (var secIdx = 0; secIdx < sections.length; secIdx++) {
      var section = sections[secIdx];
      var items = objectsDiff[section.key];
      if (!items || items.length === 0) continue;

      html += '<h3 class="diff-section-title">' + escapeHtml(section.title) + ' (' + items.length + ')</h3>';
      html += '<table class="diff-schema-table">';
      html += '<thead><tr><th>Name</th><th>Left</th><th>Right</th><th>Status</th></tr></thead>';
      html += '<tbody>';
      for (var itemIdx = 0; itemIdx < items.length; itemIdx++) {
        var item = items[itemIdx];
        var rowClass = item.status === 'added' ? 'diff-added' : item.status === 'removed' ? 'diff-removed' : '';
        var statusText = item.status;
        if (item.differences && item.differences.length > 0) {
          statusText += ': ' + item.differences.join(', ');
        }
        html += '<tr' + (rowClass ? ' class="' + rowClass + '"' : '') + '>';
        html += '<td>' + escapeHtml(item.name) + '</td>';
        html += '<td>' + escapeHtml(item.leftDetail || '') + '</td>';
        html += '<td>' + escapeHtml(item.rightDetail || '') + '</td>';
        html += '<td class="diff-status-' + escapeHtml(item.status) + '">' + escapeHtml(statusText) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }

    container.innerHTML = html;
  }

  // ---- Format statistic value ----
  function formatStatValue(value, unit) {
    if (value === null || value === undefined) return '<span class="diff-cell-empty">\u2014</span>';
    if (unit === 'date') {
      var date = new Date(value);
      return escapeHtml(isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'));
    }
    if (typeof value === 'string') return escapeHtml(value);
    if (unit === 'bytes') return escapeHtml(formatBytes(value));
    if (unit === 'count') return escapeHtml(value.toLocaleString('en-US'));
    if (unit === 'percent') return escapeHtml(value.toFixed(2) + '%');
    return escapeHtml(String(value));
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    var abs = Math.abs(bytes);
    if (abs >= 1099511627776) return (bytes / 1099511627776).toFixed(2) + ' TB';
    if (abs >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (abs >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (abs >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
  }

  // ---- Render stats diff (chart for numeric, small list for non-numeric) ----
  function renderStatsDiff() {
    if (!statsDiff) return;
    renderStatsChart();
    renderStatsNonNumeric();
  }

  function isNumericStat(item) {
    if (item.unit === 'date' || item.unit === 'text') return false;
    var hasNum = typeof item.leftValue === 'number' || typeof item.rightValue === 'number';
    return hasNum;
  }

  function renderStatsChart() {
    var container = document.getElementById('statsChart');
    if (!container || !statsDiff) return;
    if (!window.echarts) {
      container.innerHTML = '<div class="diff-stats-empty">ECharts not loaded</div>';
      return;
    }

    var numericItems = [];
    for (var idx = 0; idx < statsDiff.items.length; idx++) {
      if (isNumericStat(statsDiff.items[idx])) numericItems.push(statsDiff.items[idx]);
    }
    if (numericItems.length === 0) {
      container.style.display = 'none';
      return;
    }

    var fg = getCssVar('--vscode-foreground') || '#cccccc';
    var fgMuted = getCssVar('--vscode-descriptionForeground') || '#808080';
    var warnColor = getCssVar('--vscode-editorWarning-foreground') || '#cca700';
    var leftColor = getCssVar('--vscode-charts-blue') || '#3794ff';
    var rightColor = getCssVar('--vscode-charts-green') || '#89d185';

    // Responsive matrix layout: choose column count from container width.
    // Each cell needs ~240px to render two bars + value labels comfortably.
    // Narrow window → 1 column; very wide screen → all metrics in a single row.
    var minCellWidth = 240;
    var containerWidth = container.clientWidth || container.parentElement.clientWidth || 800;
    var maxCols = Math.max(1, Math.floor(containerWidth / minCellWidth));
    var cols = Math.min(numericItems.length, maxCols);
    var rows = Math.ceil(numericItems.length / cols);
    var cellHeight = 170;
    var titleH = 22;
    var bottomPad = 18;
    var totalHeight = rows * cellHeight;
    container.style.height = (totalHeight + 8) + 'px';

    var titles = [], grids = [], xAxes = [], yAxes = [], serieses = [];
    var hPad = 1.5; // % horizontal padding inside each cell
    var cellWidthPct = 100 / cols;

    for (var i = 0; i < numericItems.length; i++) {
      var item = numericItems[i];
      var col = i % cols;
      var row = Math.floor(i / cols);

      var leftNum = typeof item.leftValue === 'number' ? item.leftValue : null;
      var rightNum = typeof item.rightValue === 'number' ? item.rightValue : null;
      var maxAbs = Math.max(Math.abs(leftNum || 0), Math.abs(rightNum || 0));
      var yMax = maxAbs === 0 ? 1 : maxAbs * 1.25; // headroom for value label above bar

      titles.push({
        text: item.label,
        left: ((col + 0.5) * cellWidthPct) + '%',
        top: row * cellHeight + 2,
        textAlign: 'center',
        textStyle: {
          fontSize: 12,
          color: item.status === 'differs' ? warnColor : fg,
          fontWeight: item.status === 'differs' ? 'bold' : 'normal',
        },
      });

      grids.push({
        left: (col * cellWidthPct + hPad) + '%',
        right: ((cols - col - 1) * cellWidthPct + hPad) + '%',
        top: row * cellHeight + titleH,
        bottom: totalHeight - (row + 1) * cellHeight + bottomPad,
        containLabel: false,
        // Highlight cells where the metric differs with a translucent warning tint.
        // grid.show must be true for backgroundColor to render.
        show: item.status === 'differs',
        borderWidth: 0,
        backgroundColor: item.status === 'differs' ? 'rgba(204, 167, 0, 0.10)' : 'transparent',
      });

      xAxes.push({
        type: 'category',
        gridIndex: i,
        data: ['', ''],
        axisLine: { show: true, lineStyle: { color: fgMuted } },
        axisTick: { show: false },
        axisLabel: { show: false },
      });

      yAxes.push({
        type: 'value',
        gridIndex: i,
        show: false,
        min: 0,
        max: yMax,
      });

      // IIFE to capture per-series unit/raw values for label formatter
      serieses.push({
        type: 'bar',
        xAxisIndex: i,
        yAxisIndex: i,
        barCategoryGap: '40%',
        data: [
          { value: leftNum === null ? 0 : leftNum, itemStyle: { color: leftColor } },
          { value: rightNum === null ? 0 : rightNum, itemStyle: { color: rightColor } },
        ],
        label: {
          show: true,
          position: 'top',
          color: fgMuted,
          fontSize: 11,
          formatter: (function (unit, leftRaw, rightRaw) {
            return function (params) {
              var raw = params.dataIndex === 0 ? leftRaw : rightRaw;
              return raw === null ? '\u2014' : stripHtml(formatStatValue(raw, unit));
            };
          })(item.unit, leftNum, rightNum),
        },
      });
    }

    var chart = window.echarts.init(container, null, { renderer: 'svg' });

    var option = {
      animation: false,
      title: titles,
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series: serieses,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: function (params) {
          if (!params || !params.length) return '';
          var seriesIdx = params[0].seriesIndex;
          var item = numericItems[seriesIdx];
          if (!item) return '';
          var html = '<b>' + escapeHtml(item.label) + '</b><br/>';
          html += escapeHtml(leftLabel) + ': ' + formatStatValue(item.leftValue, item.unit) + '<br/>';
          html += escapeHtml(rightLabel) + ': ' + formatStatValue(item.rightValue, item.unit);
          return html;
        },
      },
    };
    chart.setOption(option);

    if (window.__diffStatsChart) {
      try { window.__diffStatsChart.dispose(); } catch (e) { /* noop */ }
    }
    window.__diffStatsChart = chart;
    window.__diffStatsCols = cols;

    // Watch for container width changes (sidebar toggle, window resize, etc.)
    // and rebuild the chart only when the column count would actually change.
    if (!window.__diffStatsObserver && typeof ResizeObserver !== 'undefined') {
      var resizeTimer = null;
      window.__diffStatsObserver = new ResizeObserver(function (entries) {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          if (!window.__diffStatsRendered || !window.__diffStatsChart) return;
          var width = container.clientWidth;
          var newCols = Math.min(numericItems.length, Math.max(1, Math.floor(width / minCellWidth)));
          if (newCols !== window.__diffStatsCols) {
            renderStatsChart();
          } else {
            window.__diffStatsChart.resize();
          }
        }, 120);
      });
      window.__diffStatsObserver.observe(container.parentElement || container);
    }
  }

  // formatStatValue returns HTML for null — strip it before using in chart labels
  function stripHtml(str) {
    return String(str).replace(/<[^>]*>/g, '');
  }

  function getCssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function renderStatsNonNumeric() {
    var container = document.getElementById('statsNonNumeric');
    if (!container || !statsDiff) return;

    var rows = '';
    for (var idx = 0; idx < statsDiff.items.length; idx++) {
      var item = statsDiff.items[idx];
      if (isNumericStat(item)) continue;

      var rowClass = '';
      if (item.status === 'differs') rowClass = 'diff-stats-row-differs';
      else if (item.status === 'leftOnly') rowClass = 'diff-removed';
      else if (item.status === 'rightOnly') rowClass = 'diff-added';

      rows += '<tr' + (rowClass ? ' class="' + rowClass + '"' : '') + '>';
      rows += '<td>' + escapeHtml(item.label) + '</td>';
      rows += '<td>' + formatStatValue(item.leftValue, item.unit) + '</td>';
      rows += '<td>' + formatStatValue(item.rightValue, item.unit) + '</td>';
      rows += '</tr>';
    }

    if (!rows) { container.innerHTML = ''; return; }

    container.innerHTML =
      '<h3 class="diff-section-title">Other</h3>' +
      '<table class="diff-schema-table">' +
      '<thead><tr><th>Metric</th><th>' + escapeHtml(leftLabel) + '</th><th>' + escapeHtml(rightLabel) + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  // ---- Handle messages from host ----
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'updateDiff':
        // Host sent updated diff data after swap or refresh
        if (msg.rowDiff) {
          Object.assign(rowDiff, msg.rowDiff);
          buildRowHeaders();
          renderRowDiff();
        }
        if (msg.schemaDiff) {
          Object.assign(schemaDiff, msg.schemaDiff);
          renderSchemaDiff();
        }
        if (msg.leftLabel || msg.rightLabel) {
          var leftHeader = document.getElementById('leftHeader');
          var rightHeader = document.getElementById('rightHeader');
          if (leftHeader && msg.leftLabel) leftHeader.textContent = msg.leftLabel;
          if (rightHeader && msg.rightLabel) rightHeader.textContent = msg.rightLabel;
        }
        break;
    }
  });

  // ---- Initial render ----
  buildRowHeaders();
  renderRowDiff();
  renderSchemaDiff();
  renderObjectsDiff();
  // Stats are rendered lazily on tab activation — see tab click handler above.
})();
