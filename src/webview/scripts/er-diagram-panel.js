/* global echarts, acquireVsCodeApi, ViewstorErLayout */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const chartEl = document.getElementById('chart');
  const hoverTooltipEl = document.getElementById('hoverTooltip');
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
  const MIN_OVERVIEW_SCALE = 0.12;
  const LABEL_OVERVIEW_SCALE = 0.48;
  const HOVER_TRANSITION_MS = 150;

  let chart;
  let data = { tables: [], foreignKeys: [] };
  let positionedNodes = [];
  let links = [];
  let currentZoom = 1;
  let overviewZoom = 1;
  let farZoom = 0.5;
  let detailZoom = MIN_DETAIL_ZOOM;
  let showingDetails = false;
  let overviewScale = 1;
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
    const required = column.notNullable && !column.primaryKey ? '*' : '';
    const columnStyle = column.primaryKey ? 'pkColumn' : 'column';
    const typeStyle = column.primaryKey ? 'pkType' : 'type';
    const type = `${column.dataType}${column.primaryKey ? ', PK' : ''}`;
    return `{${columnStyle}|${safeRichText(column.name)}${required}}{${typeStyle}|${safeRichText(type)}}`;
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
      detailContentHeight: 24 + contentRows * 18,
      columns: shownColumns,
      symbol: 'rect',
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
        : [OVERVIEW_WIDTH * overviewScale, OVERVIEW_HEIGHT * overviewScale],
    };
  }

  function labelOptions() {
    const foreground = theme('--vscode-foreground', '#cccccc');
    const dimmed = theme('--vscode-descriptionForeground', '#999999');
    const primary = theme('--vscode-terminal-ansiYellow', '#d7ba7d');
    const overviewLabelsVisible = overviewScale >= LABEL_OVERVIEW_SCALE;
    return {
      show: showingDetails || overviewLabelsVisible,
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
          align: 'center',
        },
        title: {
          width: DETAIL_WIDTH - 30,
          overflow: 'truncate',
          ellipsis: '…',
          color: foreground,
          fontWeight: 600,
          fontSize: 12,
          lineHeight: 24,
          align: 'center',
        },
        column: {
          width: 174,
          overflow: 'truncate',
          ellipsis: '…',
          color: foreground,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 10,
          lineHeight: 18,
          align: 'left',
        },
        pkColumn: {
          width: 174,
          overflow: 'truncate',
          ellipsis: '…',
          color: primary,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontWeight: 700,
          fontSize: 10,
          lineHeight: 18,
          align: 'left',
        },
        type: {
          width: 116,
          overflow: 'truncate',
          ellipsis: '…',
          color: dimmed,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 9,
          lineHeight: 18,
          align: 'left',
        },
        pkType: {
          width: 116,
          overflow: 'truncate',
          ellipsis: '…',
          color: primary,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: 9,
          lineHeight: 18,
          align: 'left',
        },
        more: {
          color: dimmed,
          fontStyle: 'italic',
          fontSize: 10,
          lineHeight: 18,
          align: 'left',
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
        opacity: showingDetails ? 0.5 : 0.04 + overviewScale * 0.14,
        width: showingDetails ? 1.4 : 1,
        curveness: 0.06,
      },
      emphasis: {
        focus: 'adjacency',
        scale: 1.02,
        label: { show: showingDetails || overviewScale >= LABEL_OVERVIEW_SCALE },
        itemStyle: { opacity: 1, borderWidth: 2 },
        lineStyle: { width: 3, opacity: 1 },
      },
      blur: {
        itemStyle: { opacity: 0.18 },
        label: { opacity: 0.18 },
        lineStyle: { opacity: 0.025 },
      },
    };
  }

  function updateSemanticDisplay(force) {
    if (!chart || positionedNodes.length === 0) return;
    const nextShowingDetails = currentZoom >= detailZoom;
    const nextOverviewScale = nextShowingDetails
      ? 1
      : Math.max(MIN_OVERVIEW_SCALE, Math.min(1, currentZoom / overviewZoom));
    if (!force
      && nextShowingDetails === showingDetails
      && Math.abs(nextOverviewScale - overviewScale) < 0.025) {
      setStatus();
      return;
    }
    showingDetails = nextShowingDetails;
    overviewScale = nextOverviewScale;
    chart.setOption({ series: [semanticSeriesPatch()] });
    hideHoverTooltip();
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
    hideHoverTooltip();
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
      hideHoverTooltip();
      if (typeof event.zoom === 'number') {
        currentZoom = Math.max(farZoom, Math.min(MAX_ZOOM, currentZoom * event.zoom));
        updateSemanticDisplay();
      }
    });
    chart.on('mousemove', handleChartHover);
    chart.on('mouseout', hideHoverTooltip);
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
    farZoom = Math.max(0.5, overviewZoom * MIN_OVERVIEW_SCALE);
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
    overviewScale = 1;

    chart.setOption({
      // Keep layout/zoom updates immediate, but ease hover emphasis and blur states.
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 0,
      animationThreshold: 5000,
      stateAnimation: {
        duration: HOVER_TRANSITION_MS,
        easing: 'cubicOut',
      },
      tooltip: { show: false },
      series: [{
        ...semanticSeriesPatch(),
        type: 'graph',
        layout: 'none',
        roam: true,
        draggable: false,
        cursor: 'grab',
        links,
        zoom: overviewZoom,
        scaleLimit: { min: farZoom, max: MAX_ZOOM },
        nodeScaleRatio: 0,
      }],
    }, true);
    setStatus();
  }

  function handleChartHover(params) {
    if (!params || !params.data || !params.event || panPointer) {
      hideHoverTooltip();
      return;
    }

    if (params.dataType === 'edge') {
      const lines = [];
      if (params.data.mapping) lines.push(params.data.mapping);
      if (params.data.onDelete) lines.push(`ON DELETE ${params.data.onDelete}`);
      if (params.data.onUpdate) lines.push(`ON UPDATE ${params.data.onUpdate}`);
      showHoverTooltip(params.data.name || 'Relationship', lines.join('\n'), params.event);
      return;
    }

    if (!showingDetails || params.data.anchor || !Array.isArray(params.data.columns)) {
      hideHoverTooltip();
      return;
    }

    const seriesModel = chart.getModel().getSeriesByIndex(params.seriesIndex);
    const itemEl = seriesModel && seriesModel.getData().getItemGraphicEl(params.dataIndex);
    const center = itemEl && itemEl.transformCoordToGlobal(0, 0);
    if (!Array.isArray(center) || center.length < 2) {
      hideHoverTooltip();
      return;
    }

    const pointerY = params.event.offsetY;
    const firstColumnTop = center[1] - params.data.detailContentHeight / 2 + 24;
    const columnIndex = Math.floor((pointerY - firstColumnTop) / 18);
    const column = params.data.columns[columnIndex];
    if (!column || !column.comment) {
      hideHoverTooltip();
      return;
    }
    showHoverTooltip(column.name, column.comment, params.event);
  }

  function showHoverTooltip(title, body, event) {
    if (!hoverTooltipEl || !body) {
      hideHoverTooltip();
      return;
    }
    const titleEl = document.createElement('span');
    titleEl.className = 'hover-tooltip-title';
    titleEl.textContent = title;
    hoverTooltipEl.replaceChildren(titleEl, document.createTextNode(body));
    hoverTooltipEl.classList.remove('hidden');

    const pointerX = event.offsetX;
    const pointerY = event.offsetY;
    const width = hoverTooltipEl.offsetWidth;
    const height = hoverTooltipEl.offsetHeight;
    let left = pointerX + 14;
    let top = pointerY + 14;
    if (left + width > chartEl.clientWidth - 8) left = pointerX - width - 14;
    if (top + height > chartEl.clientHeight - 8) top = pointerY - height - 14;
    hoverTooltipEl.style.left = `${Math.max(8, left)}px`;
    hoverTooltipEl.style.top = `${Math.max(8, top)}px`;
  }

  function hideHoverTooltip() {
    if (hoverTooltipEl) hoverTooltipEl.classList.add('hidden');
  }

  function setStatus() {
    const support = data.foreignKeysUnsupported ? ' · relationships unsupported by driver' : '';
    const zoom = positionedNodes.length > 0 ? ` · ${currentZoom.toFixed(1)}×` : '';
    const densityMode = showingDetails
      ? 'columns'
      : overviewScale >= LABEL_OVERVIEW_SCALE ? 'names' : 'map';
    const density = positionedNodes.length > 0 ? ` · ${densityMode}` : '';
    statusEl.textContent = `${data.tables.length} tables/views · ${links.length} relationships${zoom}${density}${support}`;
  }

  function setEmpty(message) {
    emptyEl.textContent = message;
    emptyEl.classList.remove('hidden');
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
