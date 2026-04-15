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
  const activeFilters = {
    rows: { unchanged: true, changed: true, added: true, removed: true },
    schema: { differs: true, same: true },
    stats: { differs: true, same: true },
  };

  // ---- Tab switching ----
  const tabs = document.querySelectorAll('.diff-tab');
  const panels = document.querySelectorAll('.diff-tab-panel');
  const summaryFilterGroups = document.querySelectorAll('.diff-summary-filters');

  function updateSummaryFilterGroups(target) {
    summaryFilterGroups.forEach(function (group) {
      group.classList.toggle('hidden', group.dataset.for !== target);
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      const target = tab.dataset.tab;
      tabs.forEach(function (tabEl) { tabEl.classList.toggle('active', tabEl.dataset.tab === target); });
      panels.forEach(function (panelEl) { panelEl.classList.toggle('active', panelEl.id === 'panel-' + target); });
      updateSummaryFilterGroups(target);
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

  // ---- Badge-as-filter clicks ----
  // Plain click = solo (only the clicked badge stays on).
  // Shift+click = additive toggle (flip the clicked, keep the rest).
  // Mirror of toggleFilter() in src/diff/diffEngine.ts — keep them in sync.
  function applyToggle(state, key, shift) {
    if (!(key in state)) return state;
    if (shift) {
      var next = Object.assign({}, state);
      next[key] = !next[key];
      var hasAny = false;
      for (var k in next) if (next[k]) { hasAny = true; break; }
      return hasAny ? next : state;
    }
    var result = {};
    for (var k2 in state) result[k2] = (k2 === key);
    return result;
  }

  function syncBadgeStates(tabKey) {
    var group = document.querySelector('.diff-summary-filters[data-for="' + tabKey + '"]');
    if (!group) return;
    var state = activeFilters[tabKey];
    group.querySelectorAll('.diff-badge-filter').forEach(function (b) {
      b.classList.toggle('active', !!state[b.dataset.filter]);
    });
  }

  const filterBadges = document.querySelectorAll('.diff-badge-filter');
  filterBadges.forEach(function (badge) {
    badge.addEventListener('click', function (evt) {
      var tabKey = badge.parentElement.dataset.for;
      var filterKey = badge.dataset.filter;
      var state = activeFilters[tabKey];
      if (!state) return;
      var nextState = applyToggle(state, filterKey, !!evt.shiftKey);
      if (nextState === state) return; // no-op (blocked or unknown key)
      activeFilters[tabKey] = nextState;
      syncBadgeStates(tabKey);
      if (tabKey === 'rows') renderRowDiff();
      else if (tabKey === 'schema') { renderSchemaDiff(); renderObjectsDiff(); }
      else if (tabKey === 'stats' && window.__diffStatsRendered) renderStatsDiff();
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

  // ---- Custom query editor ----
  var queryLeftEl = document.getElementById('diffQueryLeft');
  var queryRightEl = document.getElementById('diffQueryRight');
  var querySyncEl = document.getElementById('diffQuerySync');
  var queryRunEl = document.getElementById('diffRunQuery');
  var queryStatusEl = document.getElementById('diffQueryStatus');
  var queryLeftErrEl = document.getElementById('diffQueryLeftError');
  var queryRightErrEl = document.getElementById('diffQueryRightError');

  function setQueryStatus(text) {
    if (queryStatusEl) queryStatusEl.textContent = text || '';
  }

  function clearQueryErrors() {
    if (queryLeftErrEl) { queryLeftErrEl.textContent = ''; queryLeftErrEl.style.display = 'none'; }
    if (queryRightErrEl) { queryRightErrEl.textContent = ''; queryRightErrEl.style.display = 'none'; }
  }

  function isSyncOn() {
    return !!(querySyncEl && querySyncEl.checked);
  }

  // Debounce host notifications to avoid a postMessage per keystroke.
  var sendQueryStateTimer = null;
  function sendQueryState() {
    if (!queryLeftEl || !queryRightEl) return;
    if (sendQueryStateTimer !== null) clearTimeout(sendQueryStateTimer);
    sendQueryStateTimer = setTimeout(function () {
      sendQueryStateTimer = null;
      vscode.postMessage({
        type: 'updateQueries',
        leftQuery: queryLeftEl.value,
        rightQuery: queryRightEl.value,
        syncMode: isSyncOn(),
      });
    }, 200);
  }

  // Clear stale "Error" status + inline error boxes when the user starts
  // editing so the panel doesn't keep the previous run's error visible.
  function clearQueryErrorsOnEdit() {
    if (queryStatusEl && queryStatusEl.textContent) queryStatusEl.textContent = '';
    if (queryLeftErrEl && queryLeftErrEl.style.display !== 'none') {
      queryLeftErrEl.textContent = '';
      queryLeftErrEl.style.display = 'none';
    }
    if (queryRightErrEl && queryRightErrEl.style.display !== 'none') {
      queryRightErrEl.textContent = '';
      queryRightErrEl.style.display = 'none';
    }
  }

  if (queryLeftEl && queryRightEl && queryRunEl) {
    // Mirror between panes while sync is ON
    var mirroring = false;
    queryLeftEl.addEventListener('input', function () {
      if (isSyncOn() && !mirroring) {
        mirroring = true;
        queryRightEl.value = queryLeftEl.value;
        mirroring = false;
      }
      clearQueryErrorsOnEdit();
      sendQueryState();
    });
    queryRightEl.addEventListener('input', function () {
      if (isSyncOn() && !mirroring) {
        mirroring = true;
        queryLeftEl.value = queryRightEl.value;
        mirroring = false;
      }
      clearQueryErrorsOnEdit();
      sendQueryState();
    });
    if (querySyncEl) {
      querySyncEl.addEventListener('change', function () {
        if (isSyncOn()) {
          // Snap right to match left when re-enabling sync
          queryRightEl.value = queryLeftEl.value;
        }
        sendQueryState();
      });
    }

    queryRunEl.addEventListener('click', function () {
      clearQueryErrors();
      setQueryStatus('Running\u2026');
      queryRunEl.disabled = true;
      vscode.postMessage({
        type: 'runDiffQuery',
        leftQuery: queryLeftEl.value,
        rightQuery: queryRightEl.value,
        syncMode: isSyncOn(),
      });
    });

    // Ctrl/Cmd+Enter in either textarea runs the diff
    function runOnCtrlEnter(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.code === 'Enter')) {
        e.preventDefault();
        queryRunEl.click();
      }
    }
    queryLeftEl.addEventListener('keydown', runOnCtrlEnter);
    queryRightEl.addEventListener('keydown', runOnCtrlEnter);
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

    var rowFilters = activeFilters.rows;

    // Matched rows (changed + unchanged)
    for (var matchIdx = 0; matchIdx < rowDiff.matched.length; matchIdx++) {
      var match = rowDiff.matched[matchIdx];
      var isUnchanged = match.changedColumns.length === 0;
      var rowCategory = isUnchanged ? 'unchanged' : 'changed';

      if (!rowFilters[rowCategory]) continue;

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
    if (rowFilters.removed) {
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
    if (rowFilters.added) {
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
    var schemaFilters = activeFilters.schema;

    // Compute covering indexes per column once — used in the "Indexed by" column for both sides
    var leftIndexByColumn = indexCoverageMap(objectsDiff, 'left');
    var rightIndexByColumn = indexCoverageMap(objectsDiff, 'right');

    function indexedByCell(columnName, typeDiffersFlag) {
      var leftIdx = (leftIndexByColumn[columnName] || []).join(', ') || '\u2014';
      var rightIdx = (rightIndexByColumn[columnName] || []).join(', ') || '\u2014';
      var differs = leftIdx !== rightIdx;
      return '<td' + (differs ? ' class="diff-cell-changed"' : '') + '>'
        + escapeHtml(leftIdx) + ' / ' + escapeHtml(rightIdx) + '</td>';
      void typeDiffersFlag;
    }

    // Common columns
    for (var commonIdx = 0; commonIdx < schemaDiff.commonColumns.length; commonIdx++) {
      var col = schemaDiff.commonColumns[commonIdx];
      var hasDiff = col.typeDiffers || col.nullableDiffers || col.pkDiffers || col.commentDiffers;
      if (hasDiff && !schemaFilters.differs) continue;
      if (!hasDiff && !schemaFilters.same) continue;

      html += '<tr>';
      html += '<td>' + escapeHtml(col.name) + '</td>';
      html += '<td' + (col.typeDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + escapeHtml(col.leftType) + ' / ' + escapeHtml(col.rightType) + '</td>';
      html += '<td' + (col.nullableDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + (col.leftNullable ? 'YES' : 'NO') + ' / ' + (col.rightNullable ? 'YES' : 'NO') + '</td>';
      html += '<td' + (col.pkDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + (col.leftIsPK ? 'YES' : 'NO') + ' / ' + (col.rightIsPK ? 'YES' : 'NO') + '</td>';
      html += '<td' + (col.commentDiffers ? ' class="diff-cell-changed"' : '') + '>'
        + escapeHtml(col.leftComment || '\u2014') + ' / ' + escapeHtml(col.rightComment || '\u2014') + '</td>';
      html += indexedByCell(col.name);
      html += '</tr>';
    }

    // Left-only columns (removed from right) — use em dash for the missing side
    if (schemaFilters.differs) for (var leftIdx = 0; leftIdx < schemaDiff.leftOnlyColumns.length; leftIdx++) {
      var leftCol = schemaDiff.leftOnlyColumns[leftIdx];
      html += '<tr class="diff-removed">';
      html += '<td>' + escapeHtml(leftCol.name) + '</td>';
      html += '<td>' + escapeHtml(leftCol.dataType) + ' / \u2014</td>';
      html += '<td>' + (leftCol.nullable ? 'YES' : 'NO') + ' / \u2014</td>';
      html += '<td>' + (leftCol.isPrimaryKey ? 'YES' : 'NO') + ' / \u2014</td>';
      html += '<td>' + escapeHtml(leftCol.comment || '\u2014') + ' / \u2014</td>';
      html += indexedByCell(leftCol.name);
      html += '</tr>';
    }

    // Right-only columns (added)
    if (schemaFilters.differs) for (var rightIdx = 0; rightIdx < schemaDiff.rightOnlyColumns.length; rightIdx++) {
      var rightCol = schemaDiff.rightOnlyColumns[rightIdx];
      html += '<tr class="diff-added">';
      html += '<td>' + escapeHtml(rightCol.name) + '</td>';
      html += '<td>\u2014 / ' + escapeHtml(rightCol.dataType) + '</td>';
      html += '<td>\u2014 / ' + (rightCol.nullable ? 'YES' : 'NO') + '</td>';
      html += '<td>\u2014 / ' + (rightCol.isPrimaryKey ? 'YES' : 'NO') + '</td>';
      html += '<td>\u2014 / ' + escapeHtml(rightCol.comment || '\u2014') + '</td>';
      html += indexedByCell(rightCol.name);
      html += '</tr>';
    }

    schemaBody.innerHTML = html;
  }

  // Build { columnName -> [indexName, ...] } from objectsDiff for a given side.
  function indexCoverageMap(objDiff, side) {
    var result = {};
    if (!objDiff || !objDiff.indexes) return result;
    for (var i = 0; i < objDiff.indexes.length; i++) {
      var item = objDiff.indexes[i];
      var info = item[side];
      if (!info || !info.columns) continue;
      for (var c = 0; c < info.columns.length; c++) {
        var colName = info.columns[c];
        if (!result[colName]) result[colName] = [];
        result[colName].push(item.name);
      }
    }
    return result;
  }

  // ---- Render objects diff (indexes, constraints, triggers, sequences) ----
  // Each section has its own column set. No Status column — row color carries the status.
  function renderObjectsDiff() {
    var container = document.getElementById('objectsDiffContainer');
    if (!container || !objectsDiff) return;

    var schemaFilters = activeFilters.schema;

    function filterBySchemaStatus(items) {
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var isSame = items[i].status === 'same';
        if (isSame && !schemaFilters.same) continue;
        if (!isSame && !schemaFilters.differs) continue;
        out.push(items[i]);
      }
      return out;
    }

    function rowClassFor(status) {
      if (status === 'differs') return 'diff-stats-row-differs';
      if (status === 'added') return 'diff-added';
      if (status === 'removed') return 'diff-removed';
      return '';
    }

    function pairCell(leftVal, rightVal, differs) {
      var l = (leftVal === undefined || leftVal === null || leftVal === '') ? '\u2014' : String(leftVal);
      var r = (rightVal === undefined || rightVal === null || rightVal === '') ? '\u2014' : String(rightVal);
      return '<td' + (differs ? ' class="diff-cell-changed"' : '') + '>' + escapeHtml(l) + ' / ' + escapeHtml(r) + '</td>';
    }

    function joinCols(arr) {
      return arr && arr.length > 0 ? arr.join(', ') : '';
    }

    // Source-labelled table header for "left / right" cells
    var sub = '<span class="diff-th-sub">' + escapeHtml(leftLabel) + ' / ' + escapeHtml(rightLabel) + '</span>';
    function pairTh(title) { return '<th>' + escapeHtml(title) + sub + '</th>'; }

    function openBlock(title, count) {
      return '<div class="diff-schema-block">'
        + '<h3 class="diff-section-title">' + escapeHtml(title) + ' (' + count + ')</h3>'
        + '<div class="diff-schema-block-scroll">'
        + '<table class="diff-schema-table">';
    }
    var closeBlock = '</table></div></div>';

    var html = '';

    // --- Indexes ---
    var indexItems = filterBySchemaStatus(objectsDiff.indexes || []);
    if (indexItems.length > 0) {
      html += openBlock('Indexes', indexItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th>' + pairTh('Unique') + pairTh('Type') + pairTh('Columns') + pairTh('Included') + pairTh('Predicate');
      html += '</tr></thead><tbody>';
      for (var ii = 0; ii < indexItems.length; ii++) {
        var idx = indexItems[ii];
        var iL = idx.left || {};
        var iR = idx.right || {};
        html += '<tr class="' + rowClassFor(idx.status) + '">';
        html += '<td>' + escapeHtml(idx.name) + '</td>';
        html += pairCell(iL.unique ? 'YES' : (idx.left ? 'NO' : ''), iR.unique ? 'YES' : (idx.right ? 'NO' : ''),
          !!idx.left && !!idx.right && iL.unique !== iR.unique);
        html += pairCell(iL.type, iR.type, !!idx.left && !!idx.right && (iL.type || '') !== (iR.type || ''));
        html += pairCell(joinCols(iL.columns), joinCols(iR.columns),
          !!idx.left && !!idx.right && joinCols(iL.columns) !== joinCols(iR.columns));
        html += pairCell(joinCols(iL.included), joinCols(iR.included),
          !!idx.left && !!idx.right && joinCols(iL.included) !== joinCols(iR.included));
        html += pairCell(iL.predicate, iR.predicate,
          !!idx.left && !!idx.right && (iL.predicate || '') !== (iR.predicate || ''));
        html += '</tr>';
      }
      html += '</tbody>' + closeBlock;
    }

    // --- Constraints ---
    var conItems = filterBySchemaStatus(objectsDiff.constraints || []);
    if (conItems.length > 0) {
      html += openBlock('Constraints', conItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th>' + pairTh('Type') + pairTh('Columns') + pairTh('References') + pairTh('On Delete') + pairTh('On Update') + pairTh('Check');
      html += '</tr></thead><tbody>';
      for (var ci = 0; ci < conItems.length; ci++) {
        var con = conItems[ci];
        var cL = con.left || {};
        var cR = con.right || {};
        html += '<tr class="' + rowClassFor(con.status) + '">';
        html += '<td>' + escapeHtml(con.name) + '</td>';
        html += pairCell(cL.type, cR.type, !!con.left && !!con.right && cL.type !== cR.type);
        html += pairCell(joinCols(cL.columns), joinCols(cR.columns),
          !!con.left && !!con.right && joinCols(cL.columns) !== joinCols(cR.columns));
        html += pairCell(cL.referencedTable, cR.referencedTable,
          !!con.left && !!con.right && (cL.referencedTable || '') !== (cR.referencedTable || ''));
        html += pairCell(cL.onDelete, cR.onDelete,
          !!con.left && !!con.right && (cL.onDelete || '') !== (cR.onDelete || ''));
        html += pairCell(cL.onUpdate, cR.onUpdate,
          !!con.left && !!con.right && (cL.onUpdate || '') !== (cR.onUpdate || ''));
        html += pairCell(cL.checkExpression, cR.checkExpression,
          !!con.left && !!con.right && (cL.checkExpression || '') !== (cR.checkExpression || ''));
        html += '</tr>';
      }
      html += '</tbody>' + closeBlock;
    }

    // --- Triggers ---
    var trgItems = filterBySchemaStatus(objectsDiff.triggers || []);
    if (trgItems.length > 0) {
      html += openBlock('Triggers', trgItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th>' + pairTh('Timing') + pairTh('Events') + pairTh('Definition');
      html += '</tr></thead><tbody>';
      for (var ti = 0; ti < trgItems.length; ti++) {
        var trg = trgItems[ti];
        var tL = trg.left || {};
        var tR = trg.right || {};
        html += '<tr class="' + rowClassFor(trg.status) + '">';
        html += '<td>' + escapeHtml(trg.name) + '</td>';
        html += pairCell(tL.timing, tR.timing, !!trg.left && !!trg.right && tL.timing !== tR.timing);
        html += pairCell(tL.events, tR.events, !!trg.left && !!trg.right && tL.events !== tR.events);
        html += pairCell(tL.definition, tR.definition,
          !!trg.left && !!trg.right && (tL.definition || '') !== (tR.definition || ''));
        html += '</tr>';
      }
      html += '</tbody>' + closeBlock;
    }

    // --- Sequences ---
    var seqItems = filterBySchemaStatus(objectsDiff.sequences || []);
    if (seqItems.length > 0) {
      html += openBlock('Sequences', seqItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th>' + pairTh('Data type') + pairTh('Start') + pairTh('Increment');
      html += '</tr></thead><tbody>';
      for (var si = 0; si < seqItems.length; si++) {
        var seq = seqItems[si];
        var sL = seq.left || {};
        var sR = seq.right || {};
        html += '<tr class="' + rowClassFor(seq.status) + '">';
        html += '<td>' + escapeHtml(seq.name) + '</td>';
        html += pairCell(sL.dataType, sR.dataType,
          !!seq.left && !!seq.right && (sL.dataType || '') !== (sR.dataType || ''));
        html += pairCell(sL.startValue, sR.startValue,
          !!seq.left && !!seq.right && sL.startValue !== sR.startValue);
        html += pairCell(sL.increment, sR.increment,
          !!seq.left && !!seq.right && sL.increment !== sR.increment);
        html += '</tr>';
      }
      html += '</tbody>' + closeBlock;
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

    var statsFilters = activeFilters.stats;
    var numericItems = [];
    for (var idx = 0; idx < statsDiff.items.length; idx++) {
      var statItem = statsDiff.items[idx];
      if (!isNumericStat(statItem)) continue;
      var statIsSame = statItem.status === 'same' || statItem.status === 'missing';
      if (statIsSame && !statsFilters.same) continue;
      if (!statIsSame && !statsFilters.differs) continue;
      numericItems.push(statItem);
    }
    if (numericItems.length === 0) {
      container.style.display = 'none';
      if (window.__diffStatsChart) { try { window.__diffStatsChart.dispose(); } catch(e){} window.__diffStatsChart = null; }
      return;
    }
    container.style.display = '';

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

    // Reuse existing chart instance when possible — echarts.init() returns the
    // same instance for a container that already has one, so disposing AFTER
    // setOption(...) destroys the chart we just rendered. Init-if-needed +
    // setOption(option, true) is correct and avoids the flicker of re-init.
    if (!window.__diffStatsChart) {
      window.__diffStatsChart = window.echarts.init(container, null, { renderer: 'svg' });
    }
    var chart = window.__diffStatsChart;

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
    // notMerge: true — fully replace the option so shrinking the grid count
    // (e.g. after a filter) doesn't leave stale series / axes behind.
    chart.setOption(option, true);
    chart.resize();
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
    var nnStatsFilters = activeFilters.stats;
    for (var idx = 0; idx < statsDiff.items.length; idx++) {
      var item = statsDiff.items[idx];
      if (isNumericStat(item)) continue;
      var isSame = item.status === 'same' || item.status === 'missing';
      if (isSame && !nnStatsFilters.same) continue;
      if (!isSame && !nnStatsFilters.differs) continue;

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
          // Replace rather than merge — matched/leftOnly/rightOnly arrays
          // from a previous run must not bleed into the new result.
          for (var k in rowDiff) { if (Object.prototype.hasOwnProperty.call(rowDiff, k)) delete rowDiff[k]; }
          Object.assign(rowDiff, msg.rowDiff);
          buildRowHeaders();
          renderRowDiff();
          updateSummaryCounts(msg.rowDiff.summary);
          updateTruncatedBanner(!!msg.truncated);
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
        if (queryRunEl) { queryRunEl.disabled = false; setQueryStatus(''); clearQueryErrors(); }
        break;

      case 'diffQueryRunning':
        if (queryRunEl) queryRunEl.disabled = true;
        setQueryStatus('Running\u2026');
        clearQueryErrors();
        break;

      case 'diffQueryError':
        if (queryRunEl) queryRunEl.disabled = false;
        setQueryStatus('Error');
        if (queryLeftErrEl && msg.leftError) {
          queryLeftErrEl.textContent = msg.leftError;
          queryLeftErrEl.style.display = 'block';
        }
        if (queryRightErrEl && msg.rightError) {
          queryRightErrEl.textContent = msg.rightError;
          queryRightErrEl.style.display = 'block';
        }
        break;
    }
  });

  function updateSummaryCounts(summary) {
    if (!summary) return;
    var group = document.querySelector('.diff-summary-filters[data-for="rows"]');
    if (!group) return;
    var mapping = { unchanged: summary.unchanged, changed: summary.changed, added: summary.added, removed: summary.removed };
    group.querySelectorAll('.diff-badge-filter').forEach(function (badge) {
      var key = badge.dataset.filter;
      if (key in mapping) badge.textContent = mapping[key] + ' ' + key;
    });
  }

  function updateTruncatedBanner(truncated) {
    var banner = document.getElementById('diff-truncated-banner');
    if (!banner) return;
    banner.style.display = truncated ? '' : 'none';
  }

  // ---- Initial render ----
  buildRowHeaders();
  renderRowDiff();
  renderSchemaDiff();
  renderObjectsDiff();
  // Stats are rendered lazily on tab activation — see tab click handler above.
})();
