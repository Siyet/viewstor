/* global echarts, acquireVsCodeApi, ViewstorErLayout */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const chartEl = document.getElementById('chart');
  const emptyEl = document.getElementById('emptyState');
  const statusEl = document.getElementById('status');
  const fitBtn = document.getElementById('fitBtn');
  const refreshBtn = document.getElementById('refreshBtn');

  const OVERVIEW_WIDTH = 196;
  const OVERVIEW_HEIGHT = 44;
  const DETAIL_WIDTH = 326;
  const MAX_CARD_COLUMNS = 24;
  const MIN_DETAIL_ZOOM = 2.2;
  const MAX_ZOOM = 24;

  let chart;
  let data = { tables: [], foreignKeys: [] };
  let positionedNodes = [];
  let links = [];
  let currentZoom = 1;
  let overviewZoom = 1;
  let detailZoom = MIN_DETAIL_ZOOM;
  let showingDetails = false;
  let panPointer;

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

  function cardFor(entity) {
    const title = entity.schema ? `${entity.schema}.${entity.name}` : entity.name;
    const shownColumns = entity.columns.slice(0, MAX_CARD_COLUMNS);
    const hiddenColumns = Math.max(0, entity.columns.length - shownColumns.length);
    const detailLines = [`{title|${safeRichText(truncateText(title, 40))}}`, ...shownColumns.map(columnLine)];
    if (hiddenColumns > 0) detailLines.push(`{more|+${hiddenColumns} more columns}`);
    const contentRows = shownColumns.length + (hiddenColumns > 0 ? 1 : 0);
    const detailHeight = Math.max(68, 44 + contentRows * 18);
    const isView = entity.kind === 'view';

    return {
      id: entity.id,
      name: entity.id,
      kind: entity.kind || 'table',
      width: DETAIL_WIDTH,
      height: detailHeight,
      detailHeight,
      symbol: 'roundRect',
      overviewLabelText: `{overviewTitle|${safeRichText(truncateText(title, 30))}}`,
      detailLabelText: detailLines.join('\n'),
      columnCount: entity.columns.length,
      itemStyle: {
        color: theme('--vscode-editorWidget-background', theme('--vscode-editor-background', '#1e1e1e')),
        borderColor: isView
          ? theme('--vscode-charts-purple', '#b180d7')
          : theme('--vscode-focusBorder', '#3794ff'),
        borderType: isView ? 'dashed' : 'solid',
        borderWidth: isView ? 1.5 : 1,
        shadowBlur: 4,
        shadowColor: 'rgba(0, 0, 0, .2)',
      },
    };
  }

  function linkFor(foreignKey) {
    const [source, target] = edgeEndpoints(foreignKey);
    const sourceColumns = Array.isArray(foreignKey.sourceColumns) ? foreignKey.sourceColumns : [];
    const targetColumns = Array.isArray(foreignKey.targetColumns) ? foreignKey.targetColumns : [];
    const mapping = sourceColumns.map((column, index) =>
      `${column} → ${targetColumns[index] || '?'}`).join(', ');
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
      anchor: true,
      silent: true,
      tooltip: { show: false },
      label: { show: false },
      itemStyle: { opacity: 0 },
    };
  }

  function displayNode(node) {
    if (node.anchor) return node;
    return {
      ...node,
      symbolSize: showingDetails
        ? [DETAIL_WIDTH, node.detailHeight]
        : [OVERVIEW_WIDTH, OVERVIEW_HEIGHT],
    };
  }

  function labelOptions() {
    const foreground = theme('--vscode-foreground', '#cccccc');
    const dimmed = theme('--vscode-descriptionForeground', '#999999');
    return {
      show: true,
      position: 'inside',
      align: 'center',
      verticalAlign: 'middle',
      padding: showingDetails ? [7, 12] : [4, 10],
      formatter: params => showingDetails ? params.data.detailLabelText : params.data.overviewLabelText,
      rich: {
        overviewTitle: {
          width: OVERVIEW_WIDTH - 24,
          overflow: 'truncate',
          ellipsis: '…',
          color: foreground,
          fontWeight: 600,
          fontSize: 11,
          lineHeight: 22,
        },
        title: {
          width: DETAIL_WIDTH - 30,
          overflow: 'truncate',
          ellipsis: '…',
          color: foreground,
          fontWeight: 600,
          fontSize: 12,
          lineHeight: 24,
        },
        pk: {
          width: 24,
          color: theme('--vscode-terminal-ansiYellow', '#d7ba7d'),
          fontWeight: 700,
          fontSize: 9,
          lineHeight: 18,
        },
        column: {
          width: 164,
          overflow: 'truncate',
          ellipsis: '…',
          color: foreground,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 10,
          lineHeight: 18,
        },
        type: {
          width: 102,
          overflow: 'truncate',
          ellipsis: '…',
          color: dimmed,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 9,
          lineHeight: 18,
        },
        more: {
          padding: [0, 0, 0, 24],
          color: dimmed,
          fontStyle: 'italic',
          fontSize: 10,
          lineHeight: 18,
        },
      },
    };
  }

  function semanticSeriesPatch() {
    return {
      id: 'erGraph',
      data: positionedNodes.map(displayNode),
      label: labelOptions(),
      edgeSymbol: ['none', showingDetails ? 'arrow' : 'none'],
      edgeSymbolSize: [0, showingDetails ? 8 : 0],
      lineStyle: {
        color: theme('--vscode-charts-blue', '#3794ff'),
        opacity: showingDetails ? 0.5 : 0.18,
        width: showingDetails ? 1.4 : 1,
        curveness: 0.06,
      },
    };
  }

  function updateSemanticDisplay(force) {
    if (!chart || positionedNodes.length === 0) return;
    const nextShowingDetails = currentZoom >= detailZoom;
    if (!force && nextShowingDetails === showingDetails) {
      setStatus();
      return;
    }
    showingDetails = nextShowingDetails;
    chart.setOption({ series: [semanticSeriesPatch()] });
    setStatus();
  }

  function startPan(event) {
    // ECharts handles primary-button pan. Its roam controller deliberately
    // ignores the middle button, so bridge that button to graphRoam here.
    if (event.button !== 1) return;
    panPointer = {
      x: event.clientX,
      y: event.clientY,
    };
    chartEl.classList.add('panning');
    event.preventDefault();
  }

  function movePan(event) {
    if (!panPointer || !chart) return;
    const dx = event.clientX - panPointer.x;
    const dy = event.clientY - panPointer.y;
    panPointer.x = event.clientX;
    panPointer.y = event.clientY;
    if (dx || dy) {
      chart.dispatchAction({ type: 'graphRoam', seriesId: 'erGraph', dx, dy });
    }
    event.preventDefault();
  }

  function stopPan(event) {
    if (!panPointer) return;
    panPointer = undefined;
    chartEl.classList.remove('panning');
    event.preventDefault();
  }

  function installPanHandlers() {
    chartEl.addEventListener('mousedown', startPan, true);
    window.addEventListener('mousemove', movePan, true);
    window.addEventListener('mouseup', stopPan, true);
    window.addEventListener('blur', () => {
      panPointer = undefined;
      chartEl.classList.remove('panning');
    });
    chartEl.addEventListener('auxclick', event => {
      if (event.button === 1) event.preventDefault();
    });
  }

  function ensureChart() {
    if (chart || typeof echarts === 'undefined') return;
    chart = echarts.init(chartEl);
    chart.on('graphRoam', event => {
      if (typeof event.zoom === 'number') {
        currentZoom = Math.max(overviewZoom, Math.min(MAX_ZOOM, currentZoom * event.zoom));
        updateSemanticDisplay();
      }
    });
    installPanHandlers();
  }

  function calculateZoomLevels(bounds) {
    const levels = ViewstorErLayout.zoomLevels(bounds, {
      width: chartEl.clientWidth,
      height: chartEl.clientHeight,
    }, {
      overviewWidth: OVERVIEW_WIDTH,
      detailWidth: DETAIL_WIDTH,
    });
    overviewZoom = levels.overview;
    detailZoom = levels.detail;
  }

  function renderChart() {
    if (typeof echarts === 'undefined' || typeof ViewstorErLayout === 'undefined') {
      setEmpty('ER diagram scripts failed to load.');
      return;
    }
    ensureChart();

    if (data.tables.length === 0) {
      chart.clear();
      positionedNodes = [];
      setEmpty('No tables or views found in this scope.');
      setStatus();
      return;
    }
    emptyEl.classList.add('hidden');

    const entityIds = new Set(data.tables.map(entity => entity.id));
    const visibleForeignKeys = data.foreignKeys.filter(foreignKey => {
      const [source, target] = edgeEndpoints(foreignKey);
      return entityIds.has(source) && entityIds.has(target);
    });
    const cards = data.tables.map(cardFor);
    links = visibleForeignKeys.map(linkFor);
    const aspectRatio = Math.max(0.75, chartEl.clientWidth / Math.max(1, chartEl.clientHeight));
    const layoutResult = ViewstorErLayout.layout(cards, links, {
      aspectRatio,
      gapX: 110,
      gapY: 100,
    });
    const bounds = layoutResult.bounds;
    positionedNodes = layoutResult.nodes;
    positionedNodes.push(
      anchorNode('__er_anchor_tl', bounds.x, bounds.y),
      anchorNode('__er_anchor_tr', bounds.x + bounds.width, bounds.y),
      anchorNode('__er_anchor_bl', bounds.x, bounds.y + bounds.height),
      anchorNode('__er_anchor_br', bounds.x + bounds.width, bounds.y + bounds.height),
    );
    calculateZoomLevels(bounds);
    currentZoom = overviewZoom;
    showingDetails = false;
    const foreground = theme('--vscode-foreground', '#cccccc');

    chart.setOption({
      animation: false,
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: theme('--vscode-editorHoverWidget-background', '#252526'),
        borderColor: theme('--vscode-editorHoverWidget-border', '#454545'),
        textStyle: {
          color: foreground,
          fontFamily: theme('--vscode-font-family', 'sans-serif'),
          fontSize: 11,
        },
        formatter(params) {
          if (params.dataType === 'edge') {
            const bits = [`<strong>${escapeHtml(params.data.name)}</strong>`];
            if (params.data.mapping) bits.push(escapeHtml(params.data.mapping));
            if (params.data.onDelete) bits.push(`ON DELETE ${escapeHtml(params.data.onDelete)}`);
            if (params.data.onUpdate) bits.push(`ON UPDATE ${escapeHtml(params.data.onUpdate)}`);
            return bits.join('<br>');
          }
          const kind = params.data.kind === 'view' ? 'View' : 'Table';
          return `<strong>${escapeHtml(params.data.id)}</strong><br>${kind} · ${params.data.columnCount} columns`;
        },
      },
      series: [{
        ...semanticSeriesPatch(),
        type: 'graph',
        layout: 'none',
        roam: true,
        draggable: false,
        cursor: 'grab',
        links,
        zoom: overviewZoom,
        scaleLimit: { min: overviewZoom, max: MAX_ZOOM },
        nodeScaleRatio: 0,
        emphasis: {
          focus: 'adjacency',
          scale: 1.02,
          lineStyle: { width: 3, opacity: 1 },
        },
      }],
    }, true);
    setStatus();
  }

  function setStatus() {
    const support = data.foreignKeysUnsupported ? ' · relationships unsupported by driver' : '';
    const zoom = positionedNodes.length > 0 ? ` · ${currentZoom.toFixed(1)}×` : '';
    const density = positionedNodes.length > 0 ? ` · ${showingDetails ? 'columns' : 'names'}` : '';
    statusEl.textContent = `${data.tables.length} tables/views · ${links.length} relationships${zoom}${density}${support}`;
  }

  function setEmpty(message) {
    emptyEl.textContent = message;
    emptyEl.classList.remove('hidden');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

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
      renderChart();
      refreshBtn.disabled = false;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
