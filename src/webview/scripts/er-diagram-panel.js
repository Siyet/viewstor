/* global echarts, acquireVsCodeApi, ViewstorErLayout */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const chartEl = document.getElementById('chart');
  const emptyEl = document.getElementById('emptyState');
  const statusEl = document.getElementById('status');
  const tableListEl = document.getElementById('tableList');
  const filterInput = document.getElementById('filterInput');
  const fitBtn = document.getElementById('fitBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const allBtn = document.getElementById('allBtn');
  const coreBtn = document.getElementById('coreBtn');
  const connectedBtn = document.getElementById('connectedBtn');
  const noneBtn = document.getElementById('noneBtn');

  const CARD_WIDTH = 326;
  const MAX_CARD_COLUMNS = 24;
  const LARGE_SCHEMA_TABLES = 120;
  const CORE_TABLES = 42;
  const DETAIL_TABLES = 6;
  const COMPACT_TABLES = 80;
  const MICRO_LABEL_ZOOM = 2.2;

  let chart;
  let data = { tables: [], foreignKeys: [] };
  let selected = new Set();
  let currentZoom = 1;
  let displayMode = 'detail';
  let showingSuggestedCore = false;
  let visibleTableCount = 0;
  let visibleRelationCount = 0;

  function theme(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function tableId(schema, table) {
    return schema ? `${schema}.${table}` : table;
  }

  function edgeEndpoints(foreignKey) {
    return [
      tableId(foreignKey.sourceSchema, foreignKey.sourceTable),
      tableId(foreignKey.targetSchema, foreignKey.targetTable),
    ];
  }

  function safeRichText(value) {
    return String(value || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\{/g, '﹛')
      .replace(/\}/g, '﹜')
      .replace(/\|/g, '¦');
  }

  function truncateText(value, maxLength) {
    const text = String(value || '');
    return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 1))}…`;
  }

  function columnLine(column) {
    const pk = column.primaryKey ? '{pk|PK}' : '{pk|  }';
    const required = column.notNullable && !column.primaryKey ? '*' : '';
    return `${pk}{column|${safeRichText(column.name)}${required}}{type|${safeRichText(column.dataType)}}`;
  }

  function relationCounts(foreignKeys) {
    const result = new Map(data.tables.map(table => [table.id, 0]));
    for (const foreignKey of foreignKeys) {
      const [source, target] = edgeEndpoints(foreignKey);
      result.set(source, (result.get(source) || 0) + 1);
      result.set(target, (result.get(target) || 0) + 1);
    }
    return result;
  }

  function modeForTableCount(tableCount) {
    if (tableCount <= DETAIL_TABLES) return 'detail';
    if (tableCount <= COMPACT_TABLES) return 'compact';
    return 'micro';
  }

  function cardFor(table, degree, mode) {
    const title = table.schema ? `${table.schema}.${table.name}` : table.name;
    if (mode === 'micro') {
      const size = Math.min(34, 18 + Math.sqrt(degree) * 2.2);
      return {
        id: table.id,
        name: table.id,
        width: size,
        height: size,
        symbol: 'roundRect',
        symbolSize: [size, size],
        draggable: true,
        detailLabelText: '',
        overviewLabelText: `{microTitle|${safeRichText(truncateText(title, 48))}}`,
        columnCount: table.columns.length,
        itemStyle: {
          color: theme('--vscode-badge-background', '#287b9b'),
          borderColor: theme('--vscode-focusBorder', '#3794ff'),
          borderWidth: 1,
        },
      };
    }

    if (mode === 'compact') {
      const width = 214;
      const height = 58;
      return {
        id: table.id,
        name: table.id,
        width,
        height,
        symbol: 'roundRect',
        symbolSize: [width, height],
        draggable: true,
        detailLabelText: '',
        overviewLabelText: `{compactTitle|${safeRichText(truncateText(title, 31))}}\n{compactSummary|${table.columns.length} columns · ${degree} relationships}`,
        columnCount: table.columns.length,
        itemStyle: {
          color: theme('--vscode-editorWidget-background', theme('--vscode-editor-background', '#1e1e1e')),
          borderColor: theme('--vscode-focusBorder', '#3794ff'),
          borderWidth: 1,
          shadowBlur: 3,
          shadowColor: 'rgba(0, 0, 0, .18)',
        },
      };
    }

    const shownColumns = table.columns.slice(0, MAX_CARD_COLUMNS);
    const hiddenColumns = Math.max(0, table.columns.length - shownColumns.length);
    const detailLines = [`{title|${safeRichText(truncateText(title, 40))}}`, ...shownColumns.map(columnLine)];
    if (hiddenColumns > 0) detailLines.push(`{more|+${hiddenColumns} more columns}`);
    const contentRows = shownColumns.length + (hiddenColumns > 0 ? 1 : 0);
    const height = Math.max(68, 44 + contentRows * 18);
    return {
      id: table.id,
      name: table.id,
      width: CARD_WIDTH,
      height,
      symbol: 'roundRect',
      symbolSize: [CARD_WIDTH, height],
      draggable: true,
      detailLabelText: detailLines.join('\n'),
      overviewLabelText: `{title|${safeRichText(title)}}\n{summary|${table.columns.length} columns · ${degree} relationships}`,
      columnCount: table.columns.length,
      itemStyle: {
        color: theme('--vscode-editorWidget-background', theme('--vscode-editor-background', '#1e1e1e')),
        borderColor: theme('--vscode-focusBorder', '#3794ff'),
        borderWidth: 1,
        shadowBlur: 5,
        shadowColor: 'rgba(0, 0, 0, .22)',
      },
    };
  }

  function linkFor(foreignKey) {
    const [source, target] = edgeEndpoints(foreignKey);
    const mapping = foreignKey.sourceColumns.map((column, index) =>
      `${column} → ${foreignKey.targetColumns[index] || '?'}`).join(', ');
    return {
      source,
      target,
      name: foreignKey.name,
      mapping,
      onDelete: foreignKey.onDelete,
      onUpdate: foreignKey.onUpdate,
    };
  }

  function anchorNode(id, x, y) {
    return {
      id,
      name: id,
      x,
      y,
      width: 0,
      height: 0,
      symbolSize: 0,
      silent: true,
      tooltip: { show: false },
      label: { show: false },
      itemStyle: { opacity: 0 },
    };
  }

  function labelOptions(mode) {
    const foreground = theme('--vscode-foreground', '#cccccc');
    const dimmed = theme('--vscode-descriptionForeground', '#999999');
    const microLabelsVisible = mode === 'micro' && currentZoom >= MICRO_LABEL_ZOOM;
    return {
      show: mode !== 'micro' || microLabelsVisible,
      position: mode === 'micro' ? 'right' : 'inside',
      align: mode === 'micro' ? 'left' : 'center',
      verticalAlign: 'middle',
      padding: [7, 12],
      formatter: params => mode === 'detail' ? params.data.detailLabelText : params.data.overviewLabelText,
      rich: {
        title: {
          color: foreground,
          fontWeight: 600,
          fontSize: 12,
          lineHeight: 24,
          width: CARD_WIDTH - 30,
          overflow: 'truncate',
          ellipsis: '…',
        },
        compactTitle: {
          color: foreground,
          fontWeight: 600,
          fontSize: 11,
          lineHeight: 20,
          width: 188,
          overflow: 'truncate',
          ellipsis: '…',
        },
        compactSummary: { color: dimmed, fontSize: 9, lineHeight: 16, width: 188 },
        microTitle: {
          color: foreground,
          fontWeight: 600,
          fontSize: 10,
          lineHeight: 16,
          padding: [2, 5],
          backgroundColor: theme('--vscode-editorWidget-background', '#1e1e1e'),
          borderColor: theme('--vscode-editorWidget-border', '#454545'),
          borderWidth: 1,
          borderRadius: 2,
        },
        pk: {
          color: theme('--vscode-terminal-ansiYellow', '#d7ba7d'),
          fontWeight: 700,
          fontSize: 9,
          lineHeight: 18,
          width: 24,
        },
        column: {
          color: foreground,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 10,
          lineHeight: 18,
          width: 164,
          overflow: 'truncate',
          ellipsis: '…',
        },
        type: {
          color: dimmed,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 9,
          lineHeight: 18,
          width: 102,
          overflow: 'truncate',
          ellipsis: '…',
        },
        more: { color: dimmed, fontStyle: 'italic', fontSize: 10, lineHeight: 18, padding: [0, 0, 0, 24] },
      },
    };
  }

  function ensureChart() {
    if (chart || typeof echarts === 'undefined') return;
    chart = echarts.init(chartEl);
    chart.on('graphRoam', event => {
      if (typeof event.zoom !== 'number') return;
      currentZoom = Math.max(0.1, Math.min(20, currentZoom * event.zoom));
      updateSemanticDisplay();
    });
  }

  function updateSemanticDisplay(force) {
    if (!chart || visibleTableCount === 0) return;
    if (displayMode !== 'micro' && !force) return;
    chart.setOption({
      series: [{
        id: 'erGraph',
        label: labelOptions(displayMode),
        edgeSymbol: ['none', displayMode === 'detail' ? 'arrow' : 'none'],
        edgeSymbolSize: [0, displayMode === 'detail' ? 8 : 0],
        lineStyle: {
          color: theme('--vscode-charts-blue', '#3794ff'),
          opacity: displayMode === 'detail' ? 0.55 : (currentZoom >= MICRO_LABEL_ZOOM ? 0.32 : 0.14),
          width: displayMode === 'detail' ? 1.4 : 1,
          curveness: 0.06,
        },
      }],
    });
    setStatus();
  }

  function renderChart() {
    if (typeof echarts === 'undefined' || typeof ViewstorErLayout === 'undefined') {
      setEmpty('ER diagram scripts failed to load.');
      return;
    }
    ensureChart();

    const tables = data.tables.filter(table => selected.has(table.id));
    const visibleIds = new Set(tables.map(table => table.id));
    const foreignKeys = data.foreignKeys.filter(foreignKey => {
      const [source, target] = edgeEndpoints(foreignKey);
      return visibleIds.has(source) && visibleIds.has(target);
    });

    visibleTableCount = tables.length;
    visibleRelationCount = foreignKeys.length;
    currentZoom = 1;

    if (tables.length === 0) {
      chart.clear();
      setEmpty(data.tables.length === 0 ? 'No tables found in this scope.' : 'Select tables in the sidebar.');
      displayMode = 'detail';
      setStatus();
      return;
    }
    emptyEl.classList.add('hidden');

    const counts = relationCounts(data.foreignKeys);
    displayMode = modeForTableCount(tables.length);
    const cards = tables.map(table => cardFor(table, counts.get(table.id) || 0, displayMode));
    const links = foreignKeys.map(linkFor);
    const aspectRatio = Math.max(0.75, chartEl.clientWidth / Math.max(1, chartEl.clientHeight));
    const gaps = displayMode === 'detail'
      ? { gapX: 130, gapY: 180 }
      : displayMode === 'compact'
        ? { gapX: 78, gapY: 42 }
        : { gapX: 46, gapY: 38 };
    const layoutResult = ViewstorErLayout.layout(cards, links, { aspectRatio, ...gaps });
    const positioned = layoutResult.nodes;
    const bounds = layoutResult.bounds;
    positioned.push(
      anchorNode('__er_anchor_tl', bounds.x, bounds.y),
      anchorNode('__er_anchor_tr', bounds.x + bounds.width, bounds.y),
      anchorNode('__er_anchor_bl', bounds.x, bounds.y + bounds.height),
      anchorNode('__er_anchor_br', bounds.x + bounds.width, bounds.y + bounds.height),
    );
    const foreground = theme('--vscode-foreground', '#cccccc');

    chart.setOption({
      animation: false,
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: theme('--vscode-editorHoverWidget-background', '#252526'),
        borderColor: theme('--vscode-editorHoverWidget-border', '#454545'),
        textStyle: { color: foreground, fontFamily: theme('--vscode-font-family', 'sans-serif'), fontSize: 11 },
        formatter(params) {
          if (params.dataType === 'edge') {
            const bits = [`<strong>${escapeHtml(params.data.name)}</strong>`, escapeHtml(params.data.mapping)];
            if (params.data.onDelete) bits.push(`ON DELETE ${escapeHtml(params.data.onDelete)}`);
            if (params.data.onUpdate) bits.push(`ON UPDATE ${escapeHtml(params.data.onUpdate)}`);
            return bits.join('<br>');
          }
          return `<strong>${escapeHtml(params.data.id)}</strong><br>${params.data.columnCount} columns`;
        },
      },
      series: [{
        id: 'erGraph',
        type: 'graph',
        layout: 'none',
        roam: true,
        draggable: true,
        cursor: 'grab',
        data: positioned,
        links,
        zoom: 1,
        edgeSymbol: ['none', displayMode === 'detail' ? 'arrow' : 'none'],
        edgeSymbolSize: [0, displayMode === 'detail' ? 8 : 0],
        lineStyle: {
          color: theme('--vscode-charts-blue', '#3794ff'),
          opacity: displayMode === 'detail' ? 0.55 : 0.14,
          width: displayMode === 'detail' ? 1.4 : 1,
          curveness: 0.06,
        },
        label: labelOptions(displayMode),
        emphasis: {
          focus: 'adjacency',
          scale: 1.03,
          lineStyle: { width: 3, opacity: 1 },
        },
      }],
    }, true);
    setStatus();
  }

  function setStatus() {
    const support = data.foreignKeysUnsupported ? ' · relationships unsupported by driver' : '';
    const mode = visibleTableCount > 0 ? ` · ${displayMode}` : '';
    const suggested = showingSuggestedCore ? ' · showing suggested core' : '';
    statusEl.textContent = `${visibleTableCount}/${data.tables.length} tables · ${visibleRelationCount} relationships${mode}${suggested}${support}`;
  }

  function setEmpty(message) {
    emptyEl.textContent = message;
    emptyEl.classList.remove('hidden');
  }

  function focusTable(id) {
    const cards = data.tables.map(table => ({ id: table.id }));
    const links = data.foreignKeys.map(foreignKey => {
      const [source, target] = edgeEndpoints(foreignKey);
      return { source, target };
    });
    const adjacency = ViewstorErLayout.buildAdjacency(cards, links);
    const neighbours = [...(adjacency.get(id) || [])]
      .sort((left, right) => adjacency.get(right).size - adjacency.get(left).size || left.localeCompare(right))
      .slice(0, DETAIL_TABLES - 1);
    selected = new Set([id, ...neighbours]);
    showingSuggestedCore = false;
    renderTableList();
    renderChart();
  }

  function renderTableList() {
    const query = String(filterInput.value || '').toLowerCase();
    tableListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const table of data.tables) {
      if (query && !table.id.toLowerCase().includes(query)) continue;
      const label = document.createElement('label');
      label.className = 'table-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(table.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(table.id);
        else selected.delete(table.id);
        showingSuggestedCore = false;
        renderChart();
      });
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'table-name';
      name.textContent = table.id;
      name.title = `Focus ${table.id} and directly related tables`;
      name.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        focusTable(table.id);
      });
      const count = document.createElement('span');
      count.className = 'column-count';
      count.textContent = String(table.columns.length);
      label.append(checkbox, name, count);
      fragment.appendChild(label);
    }
    tableListEl.appendChild(fragment);
  }

  function selectTables(mode) {
    showingSuggestedCore = mode === 'core';
    if (mode === 'all') {
      selected = new Set(data.tables.map(table => table.id));
    } else if (mode === 'core') {
      const cards = data.tables.map(table => ({ id: table.id }));
      const links = data.foreignKeys.map(foreignKey => {
        const [source, target] = edgeEndpoints(foreignKey);
        return { source, target };
      });
      selected = new Set(ViewstorErLayout.coreTableIds(cards, links, CORE_TABLES));
    } else if (mode === 'connected') {
      selected = new Set(data.foreignKeys.flatMap(edgeEndpoints));
    } else {
      selected.clear();
    }
    renderTableList();
    renderChart();
  }

  function selectFilteredTables() {
    const query = String(filterInput.value || '').trim().toLowerCase();
    if (!query) return;
    selected = new Set(data.tables
      .filter(table => table.id.toLowerCase().includes(query))
      .slice(0, DETAIL_TABLES)
      .map(table => table.id));
    showingSuggestedCore = false;
    renderTableList();
    renderChart();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  filterInput.addEventListener('input', renderTableList);
  filterInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') selectFilteredTables();
  });
  allBtn.addEventListener('click', () => selectTables('all'));
  coreBtn.addEventListener('click', () => selectTables('core'));
  connectedBtn.addEventListener('click', () => selectTables('connected'));
  noneBtn.addEventListener('click', () => selectTables('none'));
  fitBtn.addEventListener('click', renderChart);
  refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('resize', () => chart && chart.resize());
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'loading') {
      setEmpty('Loading schema…');
      refreshBtn.disabled = true;
    } else if (message.type === 'error') {
      setEmpty(`Unable to load diagram: ${message.message}`);
      statusEl.textContent = '';
      refreshBtn.disabled = false;
    } else if (message.type === 'setData') {
      data = message.data || { tables: [], foreignKeys: [] };
      if (data.tables.length > LARGE_SCHEMA_TABLES) {
        selectTables('core');
      } else {
        selected = new Set(data.tables.map(table => table.id));
        showingSuggestedCore = false;
        renderTableList();
        renderChart();
      }
      refreshBtn.disabled = false;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
