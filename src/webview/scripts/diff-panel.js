/* eslint-disable */
// Diff panel webview script. Runs inside a VS Code webview with
// @vscode-elements/elements loaded for custom elements.
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

  // Default: hide unchanged rows (UX #84 § 3.1). The "N unchanged rows"
  // teaser row at the top of the row diff acts as the toggle.
  const activeFilters = {
    rows: { unchanged: false, changed: true, added: true, removed: true },
    schema: { differs: true, same: false },
    stats: { differs: true, same: false },
  };

  let activeTab = 'rows';
  const tabKeys = ['rows', 'schema', 'stats'];
  const tabsEl = document.getElementById('diffTabs');

  function setActiveTab(tabKey) {
    activeTab = tabKey;
    if (tabKey === 'stats') {
      if (!window.__diffStatsRendered) {
        renderStatsDiff();
        window.__diffStatsRendered = true;
      } else if (window.__diffStatsChart) {
        window.__diffStatsChart.resize();
      }
    }
  }

  if (tabsEl) {
    tabsEl.addEventListener('vsc-tabs-select', function (evt) {
      const idx = evt.detail && typeof evt.detail.selectedIndex === 'number' ? evt.detail.selectedIndex : 0;
      const key = tabKeys[idx] || 'rows';
      setActiveTab(key);
    });
  }

  // ---- Filter chip behavior (plain click = solo, shift+click = toggle) ----
  // Mirror of toggleFilter() in src/diff/diffEngine.ts — keep them in sync.
  function applyToggle(state, key, shift) {
    if (!(key in state)) return state;
    if (shift) {
      const next = Object.assign({}, state);
      next[key] = !next[key];
      let hasAny = false;
      for (const k in next) if (next[k]) { hasAny = true; break; }
      return hasAny ? next : state;
    }
    const result = {};
    for (const k2 in state) result[k2] = (k2 === key);
    return result;
  }

  function syncChipStates(tabKey) {
    const group = document.querySelector('.diff-summary-filters[data-for="' + tabKey + '"]');
    if (!group) return;
    const state = activeFilters[tabKey];
    group.querySelectorAll('.diff-chip').forEach(function (chip) {
      const on = !!state[chip.dataset.filter];
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  document.querySelectorAll('.diff-chip').forEach(function (chip) {
    chip.addEventListener('click', function (evt) {
      const tabKey = chip.parentElement.dataset.for;
      const filterKey = chip.dataset.filter;
      const state = activeFilters[tabKey];
      if (!state) return;
      const nextState = applyToggle(state, filterKey, !!evt.shiftKey);
      if (nextState === state) return;
      activeFilters[tabKey] = nextState;
      syncChipStates(tabKey);
      if (tabKey === 'rows') renderRowDiff();
      else if (tabKey === 'schema') { renderSchemaDiff(); renderObjectsDiff(); }
      else if (tabKey === 'stats' && window.__diffStatsRendered) renderStatsDiff();
    });
  });

  // ---- Export + swap buttons ----
  const exportCsvBtn = document.getElementById('exportCsv');
  const exportJsonBtn = document.getElementById('exportJson');
  const swapBtn = document.getElementById('swapSides');
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => vscode.postMessage({ type: 'exportDiff', format: 'csv' }));
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => vscode.postMessage({ type: 'exportDiff', format: 'json' }));
  if (swapBtn) swapBtn.addEventListener('click', () => vscode.postMessage({ type: 'swapSides' }));

  // ---- Custom query editor ----
  const queryLeftEl = document.getElementById('diffQueryLeft');
  const queryRightEl = document.getElementById('diffQueryRight');
  const queryLeftHlEl = document.getElementById('diffQueryLeftHighlight');
  const queryRightHlEl = document.getElementById('diffQueryRightHighlight');
  const querySyncEl = document.getElementById('diffQuerySync');
  const querySyncIndicator = document.getElementById('diffSyncIndicator');
  const queryPanesEl = document.getElementById('diffQueryPanes');
  const queryRunEl = document.getElementById('diffRunQuery');
  const queryStatusEl = document.getElementById('diffQueryStatus');
  const queryLeftErrEl = document.getElementById('diffQueryLeftError');
  const queryRightErrEl = document.getElementById('diffQueryRightError');
  const queryEditorEl = document.getElementById('diffQueryEditor');

  // SQL token keywords — kept in sync with src/views/resultPanel.ts highlightSql.
  const SQL_KW = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|AS|ON|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DISTINCT|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|UNION|ALL|ASC|DESC|WITH|DEFAULT|CASCADE|PRIMARY|KEY|REFERENCES|FOREIGN|CONSTRAINT|RETURNING|EXPLAIN|ANALYZE|COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|TRUE|FALSE|BOOLEAN|INTEGER|TEXT|VARCHAR|NUMERIC|SERIAL|BIGSERIAL|TIMESTAMP|TIMESTAMPTZ|DATE|TIME|INTERVAL|JSONB?|UUID|ARRAY|BIGINT|SMALLINT|REAL|DOUBLE|PRECISION|CHAR|DECIMAL|FLOAT)\b/i;
  function escSql(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function highlightSql(text) {
    const out = [];
    let rest = text;
    while (rest.length > 0) {
      let m;
      if ((m = rest.match(/^'(?:[^'\\]|\\.)*'|^'(?:[^']|'')*'/))) { out.push('<span class="tk-str">' + escSql(m[0]) + '</span>'); rest = rest.substring(m[0].length); continue; }
      if ((m = rest.match(/^"[^"]*"/))) { out.push('<span class="tk-id">' + escSql(m[0]) + '</span>'); rest = rest.substring(m[0].length); continue; }
      if ((m = rest.match(/^--[^\n]*/))) { out.push('<span class="tk-cmt">' + escSql(m[0]) + '</span>'); rest = rest.substring(m[0].length); continue; }
      if ((m = rest.match(/^-?\d+(?:\.\d+)?(?![a-zA-Z_])/))) { out.push('<span class="tk-num">' + escSql(m[0]) + '</span>'); rest = rest.substring(m[0].length); continue; }
      if ((m = rest.match(/^[a-zA-Z_][a-zA-Z0-9_]*/))) {
        const w = m[0];
        out.push(SQL_KW.test(w) ? '<span class="tk-kw">' + escSql(w) + '</span>' : '<span class="tk-id">' + escSql(w) + '</span>');
        rest = rest.substring(w.length);
        continue;
      }
      if ((m = rest.match(/^[<>=!]+|^[;,()*.]/))) { out.push('<span class="tk-op">' + escSql(m[0]) + '</span>'); rest = rest.substring(m[0].length); continue; }
      out.push(escSql(rest[0]));
      rest = rest.substring(1);
    }
    return out.join('');
  }

  function autoSize(textarea) {
    if (!textarea) return;
    if (textarea.offsetParent === null) return;
    textarea.style.height = 'auto';
    const h = textarea.scrollHeight;
    if (h > 0) textarea.style.height = h + 'px';
  }

  function updateHighlight(textarea, highlight) {
    if (!textarea || !highlight) return;
    highlight.innerHTML = highlightSql(textarea.value) + '\n';
    autoSize(textarea);
  }

  function refreshAllHighlights() {
    updateHighlight(queryLeftEl, queryLeftHlEl);
    updateHighlight(queryRightEl, queryRightHlEl);
  }

  function isSyncOn() {
    return !!(querySyncEl && querySyncEl.checked);
  }

  function applySyncVisibility() {
    if (queryPanesEl) queryPanesEl.classList.toggle('synced', isSyncOn());
    if (querySyncIndicator) {
      if (isSyncOn()) querySyncIndicator.removeAttribute('hidden');
      else querySyncIndicator.setAttribute('hidden', '');
    }
  }

  // Recompute textarea heights when the collapsible expands (scrollHeight=0 while collapsed).
  if (queryEditorEl) {
    queryEditorEl.addEventListener('vsc-collapsible-toggle', refreshAllHighlights);
  }

  function setQueryStatus(text) {
    if (queryStatusEl) queryStatusEl.textContent = text || '';
  }

  function clearQueryErrors() {
    if (queryLeftErrEl) { queryLeftErrEl.textContent = ''; queryLeftErrEl.setAttribute('hidden', ''); }
    if (queryRightErrEl) { queryRightErrEl.textContent = ''; queryRightErrEl.setAttribute('hidden', ''); }
  }

  function showQueryError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.removeAttribute('hidden');
  }

  // Debounce host notifications to avoid postMessage per keystroke.
  let sendQueryStateTimer = null;
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

  function clearQueryErrorsOnEdit() {
    if (queryStatusEl && queryStatusEl.textContent) queryStatusEl.textContent = '';
    if (queryLeftErrEl && !queryLeftErrEl.hasAttribute('hidden')) {
      queryLeftErrEl.textContent = ''; queryLeftErrEl.setAttribute('hidden', '');
    }
    if (queryRightErrEl && !queryRightErrEl.hasAttribute('hidden')) {
      queryRightErrEl.textContent = ''; queryRightErrEl.setAttribute('hidden', '');
    }
  }

  if (queryLeftEl && queryRightEl && queryRunEl) {
    let mirroring = false;
    queryLeftEl.addEventListener('input', function () {
      if (isSyncOn() && !mirroring) {
        mirroring = true;
        queryRightEl.value = queryLeftEl.value;
        updateHighlight(queryRightEl, queryRightHlEl);
        mirroring = false;
      }
      updateHighlight(queryLeftEl, queryLeftHlEl);
      clearQueryErrorsOnEdit();
      sendQueryState();
    });
    queryRightEl.addEventListener('input', function () {
      if (isSyncOn() && !mirroring) {
        mirroring = true;
        queryLeftEl.value = queryRightEl.value;
        updateHighlight(queryLeftEl, queryLeftHlEl);
        mirroring = false;
      }
      updateHighlight(queryRightEl, queryRightHlEl);
      clearQueryErrorsOnEdit();
      sendQueryState();
    });
    queryLeftEl.addEventListener('scroll', function () {
      if (queryLeftHlEl) queryLeftHlEl.scrollLeft = queryLeftEl.scrollLeft;
    });
    queryRightEl.addEventListener('scroll', function () {
      if (queryRightHlEl) queryRightHlEl.scrollLeft = queryRightEl.scrollLeft;
    });
    if (querySyncEl) {
      querySyncEl.addEventListener('change', function () {
        if (isSyncOn()) {
          queryRightEl.value = queryLeftEl.value;
        }
        applySyncVisibility();
        refreshAllHighlights();
        sendQueryState();
      });
    }
    applySyncVisibility();
    refreshAllHighlights();

    queryRunEl.addEventListener('click', function () {
      clearQueryErrors();
      setQueryStatus('Running\u2026');
      queryRunEl.setAttribute('disabled', '');
      vscode.postMessage({
        type: 'runDiffQuery',
        leftQuery: queryLeftEl.value,
        rightQuery: queryRightEl.value,
        syncMode: isSyncOn(),
      });
    });

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

  // Replace "— / —" patterns with a single dim placeholder. Keep "A / —" / "— / B" as-is.
  const EM = '\u2014';
  function pairDisplay(leftVal, rightVal) {
    const l = (leftVal === undefined || leftVal === null || leftVal === '') ? EM : String(leftVal);
    const r = (rightVal === undefined || rightVal === null || rightVal === '') ? EM : String(rightVal);
    if (l === EM && r === EM) return '<span class="diff-cell-dim">\u2013</span>';
    return escapeHtml(l) + ' / ' + escapeHtml(r);
  }

  // ---- Render row diff ----
  function renderRowDiff() {
    const leftBody = document.getElementById('leftTableBody');
    const rightBody = document.getElementById('rightTableBody');
    if (!leftBody || !rightBody || !rowDiff) return;

    let leftHtml = '';
    let rightHtml = '';
    const columns = rowDiff.allColumns;
    const rowFilters = activeFilters.rows;
    const colspan = columns.length || 1;

    // UX #84 § 3.1: teaser row for unchanged rows when filter is off.
    const unchangedCount = rowDiff.summary.unchanged;
    if (!rowFilters.unchanged && unchangedCount > 0) {
      const teaser = '<tr class="diff-unchanged-teaser" data-action="show-unchanged" title="Show unchanged rows">'
        + '<td class="diff-unchanged-teaser-cell" colspan="' + colspan + '">'
        + '<span class="codicon codicon-chevron-right"></span> '
        + escapeHtml(String(unchangedCount)) + ' unchanged row' + (unchangedCount === 1 ? '' : 's')
        + '</td></tr>';
      leftHtml += teaser;
      rightHtml += teaser;
    }

    for (let matchIdx = 0; matchIdx < rowDiff.matched.length; matchIdx++) {
      const match = rowDiff.matched[matchIdx];
      const isUnchanged = match.changedColumns.length === 0;
      const rowCategory = isUnchanged ? 'unchanged' : 'changed';
      if (!rowFilters[rowCategory]) continue;

      const rowClass = isUnchanged ? 'diff-unchanged' : 'diff-changed';
      leftHtml += '<tr class="' + rowClass + '">';
      rightHtml += '<tr class="' + rowClass + '">';
      for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const col = columns[colIdx];
        const isCellChanged = match.changedColumns.indexOf(col) !== -1;
        const cellClass = isCellChanged ? 'diff-cell diff-cell-changed' : 'diff-cell';
        leftHtml += '<td class="' + cellClass + '">' + formatCell(match.left[col]) + '</td>';
        rightHtml += '<td class="' + cellClass + '">' + formatCell(match.right[col]) + '</td>';
      }
      leftHtml += '</tr>';
      rightHtml += '</tr>';
    }

    if (rowFilters.removed) {
      for (let removedIdx = 0; removedIdx < rowDiff.leftOnly.length; removedIdx++) {
        const removedRow = rowDiff.leftOnly[removedIdx];
        leftHtml += '<tr class="diff-removed">';
        rightHtml += '<tr class="diff-removed">';
        for (let removedColIdx = 0; removedColIdx < columns.length; removedColIdx++) {
          const removedCol = columns[removedColIdx];
          leftHtml += '<td class="diff-cell">' + formatCell(removedRow[removedCol]) + '</td>';
          rightHtml += '<td class="diff-cell diff-cell-empty"></td>';
        }
        leftHtml += '</tr>';
        rightHtml += '</tr>';
      }
    }

    if (rowFilters.added) {
      for (let addedIdx = 0; addedIdx < rowDiff.rightOnly.length; addedIdx++) {
        const addedRow = rowDiff.rightOnly[addedIdx];
        leftHtml += '<tr class="diff-added">';
        rightHtml += '<tr class="diff-added">';
        for (let addedColIdx = 0; addedColIdx < columns.length; addedColIdx++) {
          const addedCol = columns[addedColIdx];
          leftHtml += '<td class="diff-cell diff-cell-empty"></td>';
          rightHtml += '<td class="diff-cell">' + formatCell(addedRow[addedCol]) + '</td>';
        }
        leftHtml += '</tr>';
        rightHtml += '</tr>';
      }
    }

    leftBody.innerHTML = leftHtml;
    rightBody.innerHTML = rightHtml;

    // Wire up teaser click — turn on the unchanged filter.
    const teaser = leftBody.querySelector('.diff-unchanged-teaser');
    if (teaser) {
      const onClick = function () {
        activeFilters.rows.unchanged = true;
        syncChipStates('rows');
        renderRowDiff();
      };
      leftBody.querySelectorAll('.diff-unchanged-teaser').forEach(function (el) { el.addEventListener('click', onClick); });
      rightBody.querySelectorAll('.diff-unchanged-teaser').forEach(function (el) { el.addEventListener('click', onClick); });
    }

    if (!window.__diffScrollSyncWired) {
      window.__diffScrollSyncWired = true;
      syncScroll();
    }
  }

  function buildRowHeaders() {
    const leftHead = document.getElementById('leftTableHead');
    const rightHead = document.getElementById('rightTableHead');
    if (!leftHead || !rightHead || !rowDiff) return;

    const columns = rowDiff.allColumns;
    let headerHtml = '<tr>';
    for (let headerIdx = 0; headerIdx < columns.length; headerIdx++) {
      const col = columns[headerIdx];
      const keyClass = isKeyColumn(col) ? ' class="diff-key-col"' : '';
      headerHtml += '<th><span' + keyClass + '>' + escapeHtml(col) + '</span></th>';
    }
    headerHtml += '</tr>';
    leftHead.innerHTML = headerHtml;
    rightHead.innerHTML = headerHtml;
  }

  function syncScroll() {
    const leftPane = document.getElementById('leftPane');
    const rightPane = document.getElementById('rightPane');
    if (!leftPane || !rightPane) return;
    let syncing = false;
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

  // ---- Schema diff ----
  function renderSchemaDiff() {
    const schemaBody = document.getElementById('schemaTableBody');
    if (!schemaBody) return;
    if (!schemaDiff) return;

    let html = '';
    const schemaFilters = activeFilters.schema;
    const leftIndexByColumn = indexCoverageMap(objectsDiff, 'left');
    const rightIndexByColumn = indexCoverageMap(objectsDiff, 'right');

    function indexedByCell(columnName) {
      const leftIdx = (leftIndexByColumn[columnName] || []).join(', ');
      const rightIdx = (rightIndexByColumn[columnName] || []).join(', ');
      const differs = leftIdx !== rightIdx;
      return '<td' + (differs ? ' class="diff-cell-changed"' : '') + '>' + pairDisplay(leftIdx, rightIdx) + '</td>';
    }

    for (let commonIdx = 0; commonIdx < schemaDiff.commonColumns.length; commonIdx++) {
      const col = schemaDiff.commonColumns[commonIdx];
      const hasDiff = col.typeDiffers || col.nullableDiffers || col.pkDiffers || col.commentDiffers;
      if (hasDiff && !schemaFilters.differs) continue;
      if (!hasDiff && !schemaFilters.same) continue;

      html += '<tr>';
      html += '<td>' + escapeHtml(col.name) + '</td>';
      html += '<td' + (col.typeDiffers ? ' class="diff-cell-changed"' : '') + '>' + pairDisplay(col.leftType, col.rightType) + '</td>';
      html += '<td' + (col.nullableDiffers ? ' class="diff-cell-changed"' : '') + '>' + (col.leftNullable ? 'YES' : 'NO') + ' / ' + (col.rightNullable ? 'YES' : 'NO') + '</td>';
      html += '<td' + (col.pkDiffers ? ' class="diff-cell-changed"' : '') + '>' + (col.leftIsPK ? 'YES' : 'NO') + ' / ' + (col.rightIsPK ? 'YES' : 'NO') + '</td>';
      html += '<td' + (col.commentDiffers ? ' class="diff-cell-changed"' : '') + '>' + pairDisplay(col.leftComment, col.rightComment) + '</td>';
      html += indexedByCell(col.name);
      html += '</tr>';
    }

    if (schemaFilters.differs) {
      for (let leftIdx = 0; leftIdx < schemaDiff.leftOnlyColumns.length; leftIdx++) {
        const leftCol = schemaDiff.leftOnlyColumns[leftIdx];
        html += '<tr class="diff-removed">';
        html += '<td>' + escapeHtml(leftCol.name) + '</td>';
        html += '<td>' + pairDisplay(leftCol.dataType, '') + '</td>';
        html += '<td>' + (leftCol.nullable ? 'YES' : 'NO') + ' / ' + EM + '</td>';
        html += '<td>' + (leftCol.isPrimaryKey ? 'YES' : 'NO') + ' / ' + EM + '</td>';
        html += '<td>' + pairDisplay(leftCol.comment, '') + '</td>';
        html += indexedByCell(leftCol.name);
        html += '</tr>';
      }
      for (let rightIdx = 0; rightIdx < schemaDiff.rightOnlyColumns.length; rightIdx++) {
        const rightCol = schemaDiff.rightOnlyColumns[rightIdx];
        html += '<tr class="diff-added">';
        html += '<td>' + escapeHtml(rightCol.name) + '</td>';
        html += '<td>' + pairDisplay('', rightCol.dataType) + '</td>';
        html += '<td>' + EM + ' / ' + (rightCol.nullable ? 'YES' : 'NO') + '</td>';
        html += '<td>' + EM + ' / ' + (rightCol.isPrimaryKey ? 'YES' : 'NO') + '</td>';
        html += '<td>' + pairDisplay('', rightCol.comment) + '</td>';
        html += indexedByCell(rightCol.name);
        html += '</tr>';
      }
    }

    schemaBody.innerHTML = html;
  }

  function indexCoverageMap(objDiff, side) {
    const result = {};
    if (!objDiff || !objDiff.indexes) return result;
    for (let i = 0; i < objDiff.indexes.length; i++) {
      const item = objDiff.indexes[i];
      const info = item[side];
      if (!info || !info.columns) continue;
      for (let c = 0; c < info.columns.length; c++) {
        const colName = info.columns[c];
        if (!result[colName]) result[colName] = [];
        result[colName].push(item.name);
      }
    }
    return result;
  }

  // ---- Objects diff ----
  function renderObjectsDiff() {
    const container = document.getElementById('objectsDiffContainer');
    if (!container || !objectsDiff) return;

    const schemaFilters = activeFilters.schema;

    function filterBySchemaStatus(items) {
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const isSame = items[i].status === 'same';
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
      return '<td' + (differs ? ' class="diff-cell-changed"' : '') + '>' + pairDisplay(leftVal, rightVal) + '</td>';
    }

    function joinCols(arr) {
      return arr && arr.length > 0 ? arr.join(', ') : '';
    }

    function openBlock(title, count) {
      return '<div class="diff-schema-block">'
        + '<h3 class="diff-section-title">' + escapeHtml(title) + ' (' + count + ')</h3>'
        + '<div class="diff-schema-block-scroll">'
        + '<table class="diff-schema-table">';
    }
    const closeBlock = '</table></div></div>';

    let html = '';

    const indexItems = filterBySchemaStatus(objectsDiff.indexes || []);
    if (indexItems.length > 0) {
      html += openBlock('Indexes', indexItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th><th>Unique</th><th>Type</th><th>Columns</th><th>Included</th><th>Predicate</th>';
      html += '</tr></thead><tbody>';
      for (let ii = 0; ii < indexItems.length; ii++) {
        const idx = indexItems[ii];
        const iL = idx.left || {};
        const iR = idx.right || {};
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

    const conItems = filterBySchemaStatus(objectsDiff.constraints || []);
    if (conItems.length > 0) {
      html += openBlock('Constraints', conItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th><th>Type</th><th>Columns</th><th>References</th><th>On Delete</th><th>On Update</th><th>Check</th>';
      html += '</tr></thead><tbody>';
      for (let ci = 0; ci < conItems.length; ci++) {
        const con = conItems[ci];
        const cL = con.left || {};
        const cR = con.right || {};
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

    const trgItems = filterBySchemaStatus(objectsDiff.triggers || []);
    if (trgItems.length > 0) {
      html += openBlock('Triggers', trgItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th><th>Timing</th><th>Events</th><th>Definition</th>';
      html += '</tr></thead><tbody>';
      for (let ti = 0; ti < trgItems.length; ti++) {
        const trg = trgItems[ti];
        const tL = trg.left || {};
        const tR = trg.right || {};
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

    const seqItems = filterBySchemaStatus(objectsDiff.sequences || []);
    if (seqItems.length > 0) {
      html += openBlock('Sequences', seqItems.length);
      html += '<thead><tr>';
      html += '<th>Name</th><th>Data type</th><th>Start</th><th>Increment</th>';
      html += '</tr></thead><tbody>';
      for (let si = 0; si < seqItems.length; si++) {
        const seq = seqItems[si];
        const sL = seq.left || {};
        const sR = seq.right || {};
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

  // ---- Stats ----
  function formatStatValue(value, unit) {
    if (value === null || value === undefined) return '<span class="diff-cell-empty">\u2014</span>';
    if (unit === 'date') {
      const date = new Date(value);
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
    const abs = Math.abs(bytes);
    if (abs >= 1099511627776) return (bytes / 1099511627776).toFixed(2) + ' TB';
    if (abs >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (abs >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (abs >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
  }

  function renderStatsDiff() {
    if (!statsDiff) return;
    renderStatsChart();
    renderStatsNonNumeric();
  }

  function isNumericStat(item) {
    if (item.unit === 'date' || item.unit === 'text') return false;
    const hasNum = typeof item.leftValue === 'number' || typeof item.rightValue === 'number';
    return hasNum;
  }

  function isZeroStat(item) {
    const l = item.leftValue;
    const r = item.rightValue;
    const zeroLeft = l === null || l === undefined || l === 0;
    const zeroRight = r === null || r === undefined || r === 0;
    return zeroLeft && zeroRight;
  }

  function renderStatsChart() {
    const container = document.getElementById('statsChart');
    const zeroSummary = document.getElementById('statsZeroSummary');
    if (!container || !statsDiff) return;
    if (!window.echarts) {
      container.innerHTML = '<div class="diff-stats-empty">ECharts not loaded</div>';
      return;
    }

    const statsFilters = activeFilters.stats;
    const numericItems = [];
    const zeroItems = [];
    for (let idx = 0; idx < statsDiff.items.length; idx++) {
      const statItem = statsDiff.items[idx];
      if (!isNumericStat(statItem)) continue;
      const statIsSame = statItem.status === 'same' || statItem.status === 'missing';
      if (statIsSame && !statsFilters.same) continue;
      if (!statIsSame && !statsFilters.differs) continue;
      if (isZeroStat(statItem)) zeroItems.push(statItem);
      else numericItems.push(statItem);
    }

    // UX #84 § 3.6: collapse zero-value numeric stats into an inline summary.
    if (zeroSummary) {
      if (zeroItems.length > 0) {
        zeroSummary.innerHTML = '<span class="codicon codicon-info"></span> '
          + '<span class="diff-stats-zero-title">Zero on both sides:</span> '
          + zeroItems.map(function (s) { return escapeHtml(s.label); }).join(', ');
        zeroSummary.removeAttribute('hidden');
      } else {
        zeroSummary.setAttribute('hidden', '');
      }
    }

    if (numericItems.length === 0) {
      container.style.display = 'none';
      if (window.__diffStatsChart) { try { window.__diffStatsChart.dispose(); } catch(e){} window.__diffStatsChart = null; }
      return;
    }
    container.style.display = '';

    const fg = getCssVar('--vscode-foreground') || '#cccccc';
    const fgMuted = getCssVar('--vscode-descriptionForeground') || '#808080';
    const warnColor = getCssVar('--vscode-editorWarning-foreground') || '#cca700';
    const leftColor = getCssVar('--vscode-charts-blue') || '#3794ff';
    const rightColor = getCssVar('--vscode-charts-green') || '#89d185';

    const minCellWidth = 240;
    const containerWidth = container.clientWidth || container.parentElement.clientWidth || 800;
    const maxCols = Math.max(1, Math.floor(containerWidth / minCellWidth));
    const cols = Math.min(numericItems.length, maxCols);
    const rows = Math.ceil(numericItems.length / cols);
    const cellHeight = 170;
    const titleH = 22;
    const bottomPad = 18;
    const totalHeight = rows * cellHeight;
    container.style.height = (totalHeight + 8) + 'px';

    const titles = [], grids = [], xAxes = [], yAxes = [], serieses = [];
    const hPad = 1.5;
    const cellWidthPct = 100 / cols;

    for (let i = 0; i < numericItems.length; i++) {
      const item = numericItems[i];
      const col = i % cols;
      const row = Math.floor(i / cols);

      const leftNum = typeof item.leftValue === 'number' ? item.leftValue : null;
      const rightNum = typeof item.rightValue === 'number' ? item.rightValue : null;
      const maxAbs = Math.max(Math.abs(leftNum || 0), Math.abs(rightNum || 0));
      const yMax = maxAbs === 0 ? 1 : maxAbs * 1.25;

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
              const raw = params.dataIndex === 0 ? leftRaw : rightRaw;
              return raw === null ? '\u2014' : stripHtml(formatStatValue(raw, unit));
            };
          })(item.unit, leftNum, rightNum),
        },
      });
    }

    if (!window.__diffStatsChart) {
      window.__diffStatsChart = window.echarts.init(container, null, { renderer: 'svg' });
    }
    const chart = window.__diffStatsChart;

    const option = {
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
          const seriesIdx = params[0].seriesIndex;
          const item = numericItems[seriesIdx];
          if (!item) return '';
          let html = '<b>' + escapeHtml(item.label) + '</b><br/>';
          html += escapeHtml(leftLabel) + ': ' + formatStatValue(item.leftValue, item.unit) + '<br/>';
          html += escapeHtml(rightLabel) + ': ' + formatStatValue(item.rightValue, item.unit);
          return html;
        },
      },
    };
    chart.setOption(option, true);
    chart.resize();
    window.__diffStatsCols = cols;

    if (!window.__diffStatsObserver && typeof ResizeObserver !== 'undefined') {
      let resizeTimer = null;
      window.__diffStatsObserver = new ResizeObserver(function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          if (!window.__diffStatsRendered || !window.__diffStatsChart) return;
          const width = container.clientWidth;
          const newCols = Math.min(numericItems.length, Math.max(1, Math.floor(width / minCellWidth)));
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

  function stripHtml(str) {
    return String(str).replace(/<[^>]*>/g, '');
  }

  function getCssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function renderStatsNonNumeric() {
    const container = document.getElementById('statsNonNumeric');
    if (!container || !statsDiff) return;

    let rows = '';
    const nnStatsFilters = activeFilters.stats;
    for (let idx = 0; idx < statsDiff.items.length; idx++) {
      const item = statsDiff.items[idx];
      if (isNumericStat(item)) continue;
      const isSame = item.status === 'same' || item.status === 'missing';
      if (isSame && !nnStatsFilters.same) continue;
      if (!isSame && !nnStatsFilters.differs) continue;

      let rowClass = '';
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

    // UX #84 § 3.7: render "Other" as a card matching the chart card style.
    container.innerHTML =
      '<div class="diff-schema-block">' +
      '<h3 class="diff-section-title">Other</h3>' +
      '<div class="diff-schema-block-scroll">' +
      '<table class="diff-schema-table">' +
      '<thead><tr><th>Metric</th><th>' + escapeHtml(leftLabel) + '</th><th>' + escapeHtml(rightLabel) + '</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '</div></div>';
  }

  // ---- Host messages ----
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'updateDiff':
        if (msg.rowDiff) {
          for (const k in rowDiff) { if (Object.prototype.hasOwnProperty.call(rowDiff, k)) delete rowDiff[k]; }
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
          const leftHeader = document.getElementById('leftSourceLabel');
          const rightHeader = document.getElementById('rightSourceLabel');
          if (leftHeader && msg.leftLabel) leftHeader.textContent = msg.leftLabel;
          if (rightHeader && msg.rightLabel) rightHeader.textContent = msg.rightLabel;
        }
        if (queryRunEl) { queryRunEl.removeAttribute('disabled'); setQueryStatus(''); clearQueryErrors(); }
        break;

      case 'diffQueryRunning':
        if (queryRunEl) queryRunEl.setAttribute('disabled', '');
        setQueryStatus('Running\u2026');
        clearQueryErrors();
        break;

      case 'diffQueryError':
        if (queryRunEl) queryRunEl.removeAttribute('disabled');
        setQueryStatus('Error');
        if (msg.leftError) showQueryError(queryLeftErrEl, msg.leftError);
        if (msg.rightError) showQueryError(queryRightErrEl, msg.rightError);
        break;
    }
  });

  function updateSummaryCounts(summary) {
    if (!summary) return;
    const chipMap = {
      'chip-unchanged': summary.unchanged,
      'chip-changed': summary.changed,
      'chip-added': summary.added,
      'chip-removed': summary.removed,
    };
    for (const id in chipMap) {
      const el = document.getElementById(id);
      if (el) el.textContent = chipMap[id];
    }
    const total = summary.changed + summary.added + summary.removed;
    const tabBadge = document.getElementById('tabBadge-rows');
    if (tabBadge) {
      tabBadge.textContent = total;
      tabBadge.classList.remove('ok', 'warn');
      tabBadge.classList.add(total > 0 ? 'warn' : 'ok');
    }
  }

  function updateTruncatedBanner(truncated) {
    const banner = document.getElementById('diff-truncated-banner');
    if (!banner) return;
    if (truncated) banner.removeAttribute('hidden');
    else banner.setAttribute('hidden', '');
  }

  // ---- Initial render ----
  syncChipStates('rows');
  syncChipStates('schema');
  syncChipStates('stats');
  buildRowHeaders();
  renderRowDiff();
  renderSchemaDiff();
  renderObjectsDiff();
  // Stats are rendered lazily on tab activation — see setActiveTab() above.
})();
