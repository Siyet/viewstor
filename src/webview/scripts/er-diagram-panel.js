/* global echarts, acquireVsCodeApi, ViewstorErLayout */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const chartEl = document.getElementById('chart');
  const hoverTooltipEl = document.getElementById('hoverTooltip');
  const emptyEl = document.getElementById('emptyState');
  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refreshBtn');
  const relationshipsBtn = document.getElementById('relationshipsBtn');

  const FIT_CARD_WIDTH = 196;
  const DETAIL_WIDTH = 326;
  const CARD_LAYOUT_SCALE = DETAIL_WIDTH / FIT_CARD_WIDTH;
  const MAX_ZOOM = 24;
  const MIN_ZOOM_SCALE = 0.12;
  const HOVER_TRANSITION_MS = 150;
  const ZOOM_HALF_LIFE_MS = 28;
  const ROLE_COLOR_ALPHA = 0.78;
  const ARROW_ZOOM_THRESHOLD = 3;
  const CARD_Z = 100;
  const CARD_FRAME_Z = 200;
  const CARD_TEXT_Z = 201;

  let chart;
  let data = { tables: [], foreignKeys: [] };
  let positionedNodes = [];
  let links = [];
  let currentZoom = 1;
  let initialZoom = 1;
  let farZoom = 0.5;
  let arrowsVisible = false;
  let zoomAnimation;
  let zoomAnimationFrame;
  let statusTimer;
  let panPointer;
  let relationshipsVisible = true;
  let isolatedTableId;
  let cardLayer;
  let regionLayer;
  let regionPresentationRecords = [];
  let regions = [];
  let cardRecords = new Map();
  let adjacency = new Map();
  let activeFocusKey;
  let cardOutTimer;
  let resizeTimer;
  let cardTextStyleCache = new Map();

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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function scaled(value, scale = 1) {
    return Math.round(value * scale * 10) / 10;
  }

  function mutedRoleColor(variable, fallback) {
    const color = theme(variable, fallback);
    return echarts && echarts.color && typeof echarts.color.modifyAlpha === 'function'
      ? echarts.color.modifyAlpha(color, ROLE_COLOR_ALPHA)
      : color;
  }

  function columnLine(column) {
    const required = column.notNullable && !column.primaryKey ? '*' : '';
    const role = columnVisualRole(column);
    const columnStyle = role === 'normal' ? 'column' : `${role}Column`;
    const typeStyle = role === 'normal' ? 'type' : `${role}Type`;
    const type = `${column.dataType}${columnMarkers(column)}`;
    return `{${columnStyle}|${safeRichText(column.name)}${required}}{${typeStyle}|${safeRichText(type)}}`;
  }

  function columnVisualRole(column) {
    if (column.primaryKey) return 'pk';
    if (column.foreignKey) return 'fk';
    if (Array.isArray(column.indexNames) && column.indexNames.length > 0) return 'indexed';
    return 'normal';
  }

  function columnMarkers(column) {
    const markers = [];
    if (column.primaryKey) markers.push('PK');
    if (column.foreignKey) markers.push('FK');
    if (Array.isArray(column.indexNames) && column.indexNames.length > 0) markers.push('IDX');
    return markers.length > 0 ? `, ${markers.join(', ')}` : '';
  }

  function cardFor(entity) {
    const title = entity.name;
    const shownColumns = entity.columns;
    const detailLines = [`{title|${safeRichText(truncateText(title, 40))}}`, ...shownColumns.map(columnLine)];
    const contentRows = shownColumns.length;
    const detailHeight = Math.max(68, 44 + contentRows * 18);
    const isView = entity.kind === 'view';

    return {
      id: entity.id,
      name: entity.id,
      schema: entity.schema,
      kind: entity.kind || 'table',
      width: DETAIL_WIDTH,
      height: detailHeight,
      detailHeight,
      detailContentHeight: 24 + contentRows * 18,
      columns: shownColumns,
      symbol: 'rect',
      detailLabelText: detailLines.join('\n'),
      columnCount: entity.columns.length,
      cardStyle: {
        fill: theme('--vscode-editorWidget-background', theme('--vscode-editor-background', '#1e1e1e')),
        stroke: isView
          ? theme('--vscode-charts-purple', '#b180d7')
          : theme('--vscode-focusBorder', '#3794ff'),
        lineDash: isView ? [6, 4] : undefined,
        lineWidth: isView ? 1.5 : 1,
      },
      // ECharts keeps transparent symbols solely as graph anchors and edge
      // endpoints. The visible card is one local Rect + Text group below.
      itemStyle: { opacity: 0, borderWidth: 0 },
      label: { show: false },
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

  function nodeSymbolSize(_value, params) {
    const node = params && params.data;
    if (!node || node.anchor) return 0;
    return [DETAIL_WIDTH / initialZoom, node.detailHeight / initialZoom];
  }

  function cardTextStyles() {
    if (cardTextStyleCache.has('details')) return cardTextStyleCache.get('details');
    const foreground = theme('--vscode-foreground', '#cccccc');
    const dimmed = theme('--vscode-descriptionForeground', '#999999');
    const primary = mutedRoleColor('--vscode-terminal-ansiYellow', '#b8a66c');
    const foreign = mutedRoleColor('--vscode-terminal-ansiMagenta', '#a979a7');
    const indexed = mutedRoleColor('--vscode-charts-blue', '#4f89bd');
    const textScale = 1;
    const result = {
      padding: [scaled(7, textScale), scaled(12, textScale)],
      rich: {
        title: {
          width: scaled(DETAIL_WIDTH - 30, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: foreground,
          fontWeight: 600,
          fontSize: scaled(12, textScale),
          lineHeight: scaled(24, textScale),
          align: 'center',
        },
        column: {
          width: scaled(174, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: foreground,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: scaled(10, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        pkColumn: {
          width: scaled(174, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: primary,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontWeight: 700,
          fontSize: scaled(10, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        type: {
          width: scaled(116, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: dimmed,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: scaled(9, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        pkType: {
          width: scaled(116, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: primary,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: scaled(9, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        fkColumn: {
          width: scaled(174, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: foreign,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontWeight: 700,
          fontSize: scaled(10, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        fkType: {
          width: scaled(116, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: foreign,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: scaled(9, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        indexedColumn: {
          width: scaled(174, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: indexed,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontWeight: 600,
          fontSize: scaled(10, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
        indexedType: {
          width: scaled(116, textScale),
          overflow: 'truncate',
          ellipsis: '…',
          fill: indexed,
          fontFamily: theme('--vscode-editor-font-family', 'monospace'),
          fontSize: scaled(9, textScale),
          lineHeight: scaled(18, textScale),
          align: 'left',
        },
      },
    };
    cardTextStyleCache.set('details', result);
    return result;
  }

  function cardTextStyle(node) {
    const metrics = cardTextStyles();
    return {
      text: node.detailLabelText,
      x: 0,
      y: 0,
      align: 'center',
      verticalAlign: 'middle',
      padding: metrics.padding,
      rich: metrics.rich,
      opacity: 1,
    };
  }

  function cardShape(node) {
    return {
      x: -DETAIL_WIDTH / 2,
      y: -node.detailHeight / 2,
      width: DETAIL_WIDTH,
      height: node.detailHeight,
      r: 0,
    };
  }

  function graphVisuals() {
    return {
      id: 'erGraph',
      symbolSize: nodeSymbolSize,
      label: { show: false },
      itemStyle: { opacity: 0, borderWidth: 0 },
      edgeSymbol: ['none', arrowsVisible ? 'arrow' : 'none'],
      edgeSymbolSize: [0, arrowsVisible ? 8 : 0],
      lineStyle: {
        color: theme('--vscode-charts-blue', '#3794ff'),
        opacity: 0.35,
        width: 1.4,
        curveness: 0.06,
      },
      emphasis: {
        focus: 'adjacency',
        scale: false,
        label: { show: false },
        itemStyle: { opacity: 0, borderWidth: 0 },
        lineStyle: { width: 3, opacity: 1 },
      },
      blur: {
        itemStyle: { opacity: 0 },
        label: { show: false },
        lineStyle: { opacity: 0.025 },
      },
    };
  }

  function removeCardLayer() {
    if (cardLayer && cardLayer.parent) cardLayer.parent.remove(cardLayer);
    if (regionLayer && regionLayer.parent) regionLayer.parent.remove(regionLayer);
    cardLayer = undefined;
    regionLayer = undefined;
    regionPresentationRecords = [];
    cardRecords = new Map();
    adjacency = new Map();
    activeFocusKey = undefined;
    if (cardOutTimer !== undefined) window.clearTimeout(cardOutTimer);
    cardOutTimer = undefined;
  }

  function buildAdjacency() {
    adjacency = new Map();
    for (const node of positionedNodes) {
      if (!node.anchor) adjacency.set(node.id, new Set([node.id]));
    }
    for (const link of links) {
      if (adjacency.has(link.source) && adjacency.has(link.target)) {
        adjacency.get(link.source).add(link.target);
        adjacency.get(link.target).add(link.source);
      }
    }
  }

  function installCardLayer() {
    removeCardLayer();
    if (!chart || !echarts.graphic) return;
    const series = chart.getModel().getSeriesByIndex(0);
    const graphView = series && chart.getViewOfSeriesModel(series);
    const seriesData = series && series.getData();
    if (!graphView || !graphView.group || !seriesData) return;

    cardLayer = new echarts.graphic.Group({ name: 'viewstor-er-cards' });
    buildAdjacency();
    // ECharts' view group also contains its initial fit transform. Cancel that
    // once at the reference zoom, then let every later camera transform flow
    // through the whole card group unchanged.
    const cardScaleX = 1 / Math.max(0.0001, Math.abs(graphView.group.scaleX || 1));
    const cardScaleY = 1 / Math.max(0.0001, Math.abs(graphView.group.scaleY || 1));
    installRegionLayer(graphView);

    for (let index = 0; index < seriesData.count(); index += 1) {
      const node = positionedNodes[index];
      if (!node || node.anchor) continue;
      const group = new echarts.graphic.Group({
        // Use the current layout coordinates directly. Reading animated native
        // symbols here could reuse their previous positions after isolation.
        x: node.x,
        y: node.y,
        scaleX: cardScaleX,
        scaleY: cardScaleY,
      });
      group.__viewstorCardId = node.id;

      const rect = new echarts.graphic.Rect({
        z: CARD_Z,
        z2: CARD_FRAME_Z,
        shape: cardShape(node),
        culling: true,
        style: {
          fill: node.cardStyle.fill,
          stroke: node.cardStyle.stroke,
          lineWidth: node.cardStyle.lineWidth,
          lineDash: node.cardStyle.lineDash,
          opacity: 1,
        },
        cursor: 'pointer',
      });
      const text = new echarts.graphic.Text({
        z: CARD_Z,
        z2: CARD_TEXT_Z,
        style: cardTextStyle(node),
        culling: true,
        cursor: 'pointer',
      });
      rect.__viewstorCardId = node.id;
      text.__viewstorCardId = node.id;
      group.add(rect);
      group.add(text);
      const record = { node, index, group, rect, text };
      cardRecords.set(node.id, record);
      group.on('mousemove', event => handleCardHover(record, event));
      group.on('mouseout', handleCardOut);
      group.on('dblclick', event => {
        event.cancelBubble = true;
        isolatedTableId = isolatedTableId === node.id ? undefined : node.id;
        renderChart();
      });
      cardLayer.add(group);
    }
    graphView.group.add(cardLayer);
  }

  function installRegionLayer(graphView) {
    if (!graphView || !graphView.group || regions.length === 0) return;
    regionLayer = new echarts.graphic.Group({ name: 'viewstor-er-regions', silent: true });
    const palette = [
      theme('--vscode-charts-blue', '#3794ff'),
      theme('--vscode-charts-purple', '#b180d7'),
      theme('--vscode-charts-green', '#89d185'),
      theme('--vscode-charts-orange', '#d18616'),
      theme('--vscode-charts-cyan', '#29b8db'),
    ];
    regions.forEach((region, index) => {
      const color = palette[index % palette.length];
      const group = new echarts.graphic.Group({ x: region.x, y: region.y, silent: true });
      group.add(new echarts.graphic.Rect({
        shape: { x: 0, y: 0, width: region.width, height: region.height, r: 0 },
        culling: true,
        silent: true,
        style: {
          fill: echarts.color.modifyAlpha(color, 0.045),
          stroke: echarts.color.modifyAlpha(color, 0.52),
          lineWidth: 1,
          lineDash: [8, 5],
        },
      }));
      const title = new echarts.graphic.Text({
        x: 18,
        y: 16,
        culling: true,
        silent: true,
        style: {
          text: region.name,
          fill: echarts.color.modifyAlpha(color, 0.9),
          fontSize: 12,
          fontWeight: 600,
          fontFamily: theme('--vscode-font-family', 'sans-serif'),
          align: 'left',
          verticalAlign: 'top',
        },
      });
      group.add(title);
      regionPresentationRecords.push({ rect: group.childAt(0), title });
      regionLayer.add(group);
    });
    const firstChild = graphView.group.childAt(0);
    if (firstChild) graphView.group.addBefore(regionLayer, firstChild);
    else graphView.group.add(regionLayer);
    updateRegionPresentation();
  }

  function updateRegionPresentation() {
    if (!chart || regionPresentationRecords.length === 0) return;
    const series = chart.getModel().getSeriesByIndex(0);
    const graphView = series && chart.getViewOfSeriesModel(series);
    if (!graphView || !graphView.group) return;
    const scaleX = Math.max(0.0001, Math.abs(graphView.group.scaleX || 1));
    const scaleY = Math.max(0.0001, Math.abs(graphView.group.scaleY || 1));
    for (const record of regionPresentationRecords) {
      record.rect.setStyle({ lineWidth: 1 / Math.max(scaleX, scaleY), lineDash: [8 / scaleX, 5 / scaleX] });
      record.title.attr({ x: 18 / scaleX, y: 16 / scaleY });
      record.title.setStyle({ fontSize: 12 / scaleY });
    }
  }

  function rebaseCardLayer() {
    if (!chart || !cardLayer || cardRecords.size === 0) return;
    const series = chart.getModel().getSeriesByIndex(0);
    const graphView = series && chart.getViewOfSeriesModel(series);
    if (!graphView || !graphView.group) return;
    const zoomRatio = currentZoom / initialZoom;
    const cardScaleX = zoomRatio / Math.max(0.0001, Math.abs(graphView.group.scaleX || 1));
    const cardScaleY = zoomRatio / Math.max(0.0001, Math.abs(graphView.group.scaleY || 1));
    for (const record of cardRecords.values()) {
      record.group.attr({ scaleX: cardScaleX, scaleY: cardScaleY });
    }
  }

  function animateCardOpacity(record, opacity) {
    record.rect.animateTo({ style: { opacity } }, {
      duration: HOVER_TRANSITION_MS,
      easing: 'cubicOut',
    });
    record.text.animateTo({ style: { opacity } }, {
      duration: HOVER_TRANSITION_MS,
      easing: 'cubicOut',
    });
  }

  function focusCards(ids, graphDataIndex) {
    const focusKey = `${graphDataIndex ?? 'edge'}\u0001${Array.from(ids).sort().join('\u0000')}`;
    if (focusKey === activeFocusKey) return;
    activeFocusKey = focusKey;
    for (const record of cardRecords.values()) {
      animateCardOpacity(record, ids.has(record.node.id) ? 1 : 0.18);
    }
    if (chart && graphDataIndex !== undefined) {
      chart.dispatchAction({ type: 'downplay', seriesId: 'erGraph' });
      chart.dispatchAction({ type: 'highlight', seriesId: 'erGraph', dataIndex: graphDataIndex });
    }
  }

  function resetCardFocus() {
    if (activeFocusKey === undefined) return;
    activeFocusKey = undefined;
    for (const record of cardRecords.values()) animateCardOpacity(record, 1);
    if (chart) chart.dispatchAction({ type: 'downplay', seriesId: 'erGraph' });
  }

  function handleCardHover(record, event) {
    if (panPointer) return;
    if (cardOutTimer !== undefined) window.clearTimeout(cardOutTimer);
    cardOutTimer = undefined;
    focusCards(adjacency.get(record.node.id) || new Set([record.node.id]), record.index);
    const local = record.group.transformCoordToLocal(event.offsetX, event.offsetY);
    const firstColumnTop = -record.node.detailContentHeight / 2 + 24;
    const columnIndex = Math.floor((local[1] - firstColumnTop) / 18);
    const column = record.node.columns[columnIndex];
    if (!column) {
      hideHoverTooltip();
      return;
    }
    const details = [];
    if (column.comment) details.push(column.comment);
    if (column.foreignKey) details.push('Foreign key');
    if (Array.isArray(column.indexNames) && column.indexNames.length > 0) {
      details.push(`Indexed by: ${column.indexNames.join(', ')}`);
    }
    if (details.length > 0) showHoverTooltip(column.name, details.join('\n'), event);
    else hideHoverTooltip();
  }

  function handleCardOut() {
    if (cardOutTimer !== undefined) window.clearTimeout(cardOutTimer);
    cardOutTimer = window.setTimeout(() => {
      cardOutTimer = undefined;
      handleChartOut();
    }, 0);
  }

  function startPan(event) {
    // ECharts' graph roam can miss primary-button drags that start beyond the
    // outermost node. Bridge blank-canvas LMB drags and every middle-button
    // drag to graphRoam, while leaving node/edge interaction to ECharts.
    const blankPrimaryDrag = event.button === 0 && canStartCanvasPan(event);
    if (!blankPrimaryDrag && event.button !== 1) return;
    panPointer = {
      x: event.clientX,
      y: event.clientY,
    };
    chartEl.classList.add('panning');
    hideHoverTooltip();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function canStartCanvasPan(event) {
    if (!chart) return false;
    const rect = chartEl.getBoundingClientRect();
    const hovered = chart.getZr().findHover(event.clientX - rect.left, event.clientY - rect.top);
    return !hovered || !isTableGraphicTarget(hovered.target);
  }

  function isTableGraphicTarget(target) {
    if (!target || !chart) return false;
    let current = target;
    while (current) {
      if (current.__viewstorCardId) return true;
      current = current.parent || current.__hostTarget;
    }
    const series = chart.getModel().getSeriesByIndex(0);
    const seriesData = series && series.getData();
    if (!seriesData) return false;
    for (let index = 0; index < seriesData.count(); index += 1) {
      const itemEl = seriesData.getItemGraphicEl(index);
      if (!itemEl) continue;
      let itemTarget = target;
      while (itemTarget) {
        if (itemTarget === itemEl) return true;
        itemTarget = itemTarget.parent || itemTarget.__hostTarget;
      }
      if (itemEl.getTextContent && itemEl.getTextContent() === target) return true;
    }
    return false;
  }

  function movePan(event) {
    if (!panPointer || !chart) return;
    const dx = event.clientX - panPointer.x;
    const dy = event.clientY - panPointer.y;
    panPointer.x = event.clientX;
    panPointer.y = event.clientY;
    if (dx || dy) {
      const series = chart.getModel().getSeriesByIndex(0);
      const graphView = series && chart.getViewOfSeriesModel(series);
      if (graphView && graphView._controller && typeof graphView._controller.trigger === 'function') {
        graphView._controller.trigger('pan', { dx, dy });
      } else if (graphView && graphView.group) {
        graphView.group.x += dx;
        graphView.group.y += dy;
        graphView.group.dirty();
        chart.dispatchAction({ type: 'graphRoam', seriesId: 'erGraph', dx, dy });
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function stopPan(event) {
    if (!panPointer) return;
    panPointer = undefined;
    chartEl.classList.remove('panning');
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function applyCanvasZoom(nextZoom, originX, originY) {
    const appliedScale = nextZoom / currentZoom;
    if (Math.abs(appliedScale - 1) < 0.0001) {
      return;
    }

    const series = chart.getModel().getSeriesByIndex(0);
    const graphView = series && chart.getViewOfSeriesModel(series);
    if (graphView && graphView._controller && typeof graphView._controller.trigger === 'function') {
      graphView._controller.trigger('zoom', {
        scale: appliedScale,
        originX,
        originY,
      });
      return;
    }
    const group = graphView && graphView.group;
    if (group) {
      group.x -= (originX - group.x) * (appliedScale - 1);
      group.y -= (originY - group.y) * (appliedScale - 1);
      group.scaleX *= appliedScale;
      group.scaleY *= appliedScale;
      group.dirty();
    }
    chart.dispatchAction({
      type: 'graphRoam',
      seriesId: 'erGraph',
      zoom: appliedScale,
      originX,
      originY,
    });
  }

  function animateCanvasZoom(timestamp) {
    if (!zoomAnimation || !chart) {
      zoomAnimationFrame = undefined;
      return;
    }
    const elapsed = Math.max(1, Math.min(64, timestamp - zoomAnimation.lastTimestamp));
    zoomAnimation.lastTimestamp = timestamp;
    const blend = 1 - Math.pow(0.5, elapsed / ZOOM_HALF_LIFE_MS);
    let nextZoom = currentZoom * Math.pow(zoomAnimation.to / currentZoom, blend);
    const settled = Math.abs(Math.log(zoomAnimation.to / nextZoom)) < 0.001;
    if (settled) nextZoom = zoomAnimation.to;
    applyCanvasZoom(nextZoom, zoomAnimation.originX, zoomAnimation.originY);
    if (!settled) {
      zoomAnimationFrame = window.requestAnimationFrame(animateCanvasZoom);
    } else {
      zoomAnimation = undefined;
      zoomAnimationFrame = undefined;
    }
  }

  function zoomCanvas(event) {
    if (!chart || positionedNodes.length === 0) return;
    const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    if (!delta) return;

    const rect = chartEl.getBoundingClientRect();
    const baseZoom = zoomAnimation ? zoomAnimation.to : currentZoom;
    const requestedScale = Math.exp(clamp(-delta * 0.002, -0.24, 0.24));
    const targetZoom = clamp(baseZoom * requestedScale, farZoom, MAX_ZOOM);
    if (zoomAnimation) {
      zoomAnimation.to = targetZoom;
      zoomAnimation.originX = event.clientX - rect.left;
      zoomAnimation.originY = event.clientY - rect.top;
    } else {
      zoomAnimation = {
        to: targetZoom,
        originX: event.clientX - rect.left,
        originY: event.clientY - rect.top,
        lastTimestamp: performance.now(),
      };
    }
    if (zoomAnimationFrame === undefined) {
      zoomAnimationFrame = window.requestAnimationFrame(animateCanvasZoom);
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function installPanHandlers() {
    chartEl.addEventListener('mousedown', startPan, true);
    chartEl.addEventListener('wheel', zoomCanvas, { capture: true, passive: false });
    window.addEventListener('mousemove', movePan, true);
    window.addEventListener('mouseup', stopPan, true);
    window.addEventListener('blur', () => {
      panPointer = undefined;
      zoomAnimation = undefined;
      if (zoomAnimationFrame !== undefined) window.cancelAnimationFrame(zoomAnimationFrame);
      zoomAnimationFrame = undefined;
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
        updateArrowVisibility();
        updateRegionPresentation();
        setStatus();
      }
    });
    chart.on('mousemove', handleChartHover);
    chart.on('mouseout', params => {
      if (params && params.dataType === 'edge') handleChartOut();
    });
    chart.on('globalout', handleChartOut);
    chart.on('dblclick', handleChartDoubleClick);
    chart.getZr().on('dblclick', handleCanvasDoubleClick);
    installPanHandlers();
  }

  function updateArrowVisibility() {
    const nextVisible = currentZoom >= ARROW_ZOOM_THRESHOLD;
    if (nextVisible === arrowsVisible) return;
    arrowsVisible = nextVisible;
    chart.setOption({
      series: [{
        id: 'erGraph',
        edgeSymbol: ['none', arrowsVisible ? 'arrow' : 'none'],
        edgeSymbolSize: [0, arrowsVisible ? 8 : 0],
      }],
    });
  }

  function handleCanvasDoubleClick(event) {
    if (!isolatedTableId || event.target) return;
    exitFocusedGraph();
  }

  function calculateZoomLevels(bounds) {
    initialZoom = ViewstorErLayout.fittedZoom(bounds, {
      width: chartEl.clientWidth,
      height: chartEl.clientHeight,
    }, {
      fitWidth: FIT_CARD_WIDTH,
      cardWidth: DETAIL_WIDTH,
    });
    farZoom = Math.max(0.5, initialZoom * MIN_ZOOM_SCALE);
  }

  function graphScope() {
    const allEntityIds = new Set(data.tables.map(entity => entity.id));
    const allForeignKeys = data.foreignKeys.filter(foreignKey => {
      const [source, target] = edgeEndpoints(foreignKey);
      return allEntityIds.has(source) && allEntityIds.has(target);
    });

    if (!isolatedTableId || !allEntityIds.has(isolatedTableId)) {
      isolatedTableId = undefined;
      return { tables: data.tables, foreignKeys: allForeignKeys };
    }

    const visibleIds = new Set([isolatedTableId]);
    for (const foreignKey of allForeignKeys) {
      const [source, target] = edgeEndpoints(foreignKey);
      if (source === isolatedTableId) visibleIds.add(target);
      if (target === isolatedTableId) visibleIds.add(source);
    }
    return {
      tables: data.tables.filter(entity => visibleIds.has(entity.id)),
      foreignKeys: allForeignKeys.filter(foreignKey => {
        const [source, target] = edgeEndpoints(foreignKey);
        return visibleIds.has(source) && visibleIds.has(target);
      }),
    };
  }

  function renderChart() {
    if (typeof echarts === 'undefined' || typeof ViewstorErLayout === 'undefined') {
      setEmpty('ER diagram scripts failed to load.');
      return;
    }
    ensureChart();

    if (data.tables.length === 0) {
      removeCardLayer();
      chart.clear();
      positionedNodes = [];
      regions = [];
      setEmpty('No tables or views found in this scope.');
      setStatus();
      return;
    }
    emptyEl.classList.add('hidden');

    hideHoverTooltip();
    cardTextStyleCache = new Map();
    const scope = graphScope();
    const cards = scope.tables.map(cardFor);
    // The initial fit uses a compact target footprint, while the cards are
    // always complete. Reserve enough layout space for those full cards.
    const layoutCards = cards.map(card => ({
      ...card,
      width: card.width * CARD_LAYOUT_SCALE,
      height: card.height * CARD_LAYOUT_SCALE,
    }));
    links = scope.foreignKeys.map(linkFor);
    const aspectRatio = Math.max(0.75, chartEl.clientWidth / Math.max(1, chartEl.clientHeight));
    const layoutResult = isolatedTableId
      ? ViewstorErLayout.focusLayout(layoutCards, isolatedTableId, { gap: 110 })
      : ViewstorErLayout.layout(layoutCards, links, {
        aspectRatio,
        gapX: 110,
        gapY: 100,
      });
    const bounds = layoutResult.bounds;
    positionedNodes = layoutResult.nodes;
    regions = isolatedTableId ? [] : (layoutResult.regions || []);
    positionedNodes.push(
      anchorNode('__er_anchor_tl', bounds.x, bounds.y),
      anchorNode('__er_anchor_tr', bounds.x + bounds.width, bounds.y),
      anchorNode('__er_anchor_bl', bounds.x, bounds.y + bounds.height),
      anchorNode('__er_anchor_br', bounds.x + bounds.width, bounds.y + bounds.height),
    );
    calculateZoomLevels(bounds);
    currentZoom = initialZoom;
    arrowsVisible = currentZoom >= ARROW_ZOOM_THRESHOLD;
    zoomAnimation = undefined;
    if (zoomAnimationFrame !== undefined) window.cancelAnimationFrame(zoomAnimationFrame);
    zoomAnimationFrame = undefined;

    chart.setOption({
      // Camera zoom is the only continuous scale. Visible cards are local
      // Rect + Text groups parented to the graph view, so every pixel inherits
      // one transform and frame/text can never drift apart.
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: 0,
      animationEasingUpdate: 'cubicOut',
      animationThreshold: 5000,
      stateAnimation: {
        duration: HOVER_TRANSITION_MS,
        easing: 'cubicOut',
      },
      tooltip: { show: false },
      series: [{
        ...graphVisuals(),
        type: 'graph',
        layout: 'none',
        data: positionedNodes,
        links: relationshipsVisible ? links : [],
        roam: true,
        draggable: false,
        cursor: 'default',
        zoom: initialZoom,
        scaleLimit: { min: farZoom, max: MAX_ZOOM },
        nodeScaleRatio: 1,
      }],
    }, true);
    installCardLayer();
    setStatus();
  }

  function handleChartHover(params) {
    if (!params || !params.data || !params.event || panPointer) {
      hideHoverTooltip();
      return;
    }

    if (params.dataType === 'edge') {
      const related = new Set([params.data.source, params.data.target]);
      focusCards(related);
      const lines = [];
      if (params.data.mapping) lines.push(params.data.mapping);
      if (params.data.onDelete) lines.push(`ON DELETE ${params.data.onDelete}`);
      if (params.data.onUpdate) lines.push(`ON UPDATE ${params.data.onUpdate}`);
      showHoverTooltip(params.data.name || 'Relationship', lines.join('\n'), params.event);
      return;
    }

    hideHoverTooltip();
  }

  function handleChartOut() {
    resetCardFocus();
    hideHoverTooltip();
  }

  function handleChartDoubleClick(params) {
    if (!params || params.dataType === 'edge' || !params.data || params.data.anchor) return;
    isolatedTableId = isolatedTableId === params.data.id ? undefined : params.data.id;
    renderChart();
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
    positionTooltip(event.offsetX, event.offsetY);
  }

  function positionTooltip(pointerX, pointerY) {
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
    if (hoverTooltipEl) {
      hoverTooltipEl.classList.add('hidden');
    }
  }

  function setStatus(immediate = false) {
    if (!immediate) {
      if (statusTimer === undefined) {
        statusTimer = window.setTimeout(() => {
          statusTimer = undefined;
          renderStatus();
        }, 80);
      }
      return;
    }
    if (statusTimer !== undefined) window.clearTimeout(statusTimer);
    statusTimer = undefined;
    renderStatus();
  }

  function renderStatus() {
    const support = data.foreignKeysUnsupported ? ' · relationships unsupported by driver' : '';
    const zoom = positionedNodes.length > 0 ? ` · ${currentZoom.toFixed(1)}×` : '';
    const density = positionedNodes.length > 0 ? ' · columns' : '';
    const visibleTables = Math.max(0, positionedNodes.length - 4);
    const tableCount = isolatedTableId ? `${visibleTables}/${data.tables.length}` : String(data.tables.length);
    const focus = isolatedTableId ? ` · focused: ${isolatedTableId}` : '';
    const hidden = relationshipsVisible ? '' : ' (hidden)';
    statusEl.textContent = `${tableCount} tables/views · ${links.length} relationships${hidden}${zoom}${density}${focus}${support}`;
  }

  function toggleRelationships() {
    relationshipsVisible = !relationshipsVisible;
    relationshipsBtn.textContent = relationshipsVisible ? 'Hide relationships' : 'Show relationships';
    relationshipsBtn.setAttribute('aria-pressed', String(relationshipsVisible));
    hideHoverTooltip();
    if (chart && positionedNodes.length > 0) {
      chart.setOption({ series: [{ id: 'erGraph', links: relationshipsVisible ? links : [] }] });
    }
    setStatus(true);
  }

  function exitFocusedGraph() {
    if (!isolatedTableId) return;
    isolatedTableId = undefined;
    renderChart();
  }

  function resizeChart() {
    if (!chart) return;
    chart.resize();
    rebaseCardLayer();
    updateRegionPresentation();
    if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = undefined;
      chart.resize();
      rebaseCardLayer();
      updateRegionPresentation();
    }, HOVER_TRANSITION_MS);
  }

  function setEmpty(message) {
    emptyEl.textContent = message;
    emptyEl.classList.remove('hidden');
  }

  refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  relationshipsBtn.addEventListener('click', toggleRelationships);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isolatedTableId) {
      event.preventDefault();
      exitFocusedGraph();
    }
  });
  window.addEventListener('resize', resizeChart);
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
