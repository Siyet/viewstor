/* global echarts, acquireVsCodeApi */
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
  const connectedBtn = document.getElementById('connectedBtn');
  const noneBtn = document.getElementById('noneBtn');

  let chart;
  let data = { tables: [], foreignKeys: [] };
  let selected = new Set();

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

  function columnLine(column) {
    const pk = column.primaryKey ? '{pk|PK}' : '{pk|  }';
    const required = column.notNullable && !column.primaryKey ? '*' : '';
    const type = column.dataType ? `  {type|${column.dataType}}` : '';
    return `${pk}  {column|${column.name}${required}}${type}`;
  }

  function nodeFor(table) {
    const title = table.schema ? `${table.schema}.${table.name}` : table.name;
    const longest = table.columns.reduce((max, column) =>
      Math.max(max, column.name.length + column.dataType.length + 7), title.length + 4);
    const width = Math.min(390, Math.max(190, longest * 7.1));
    const height = Math.max(62, 38 + table.columns.length * 18);
    return {
      id: table.id,
      name: table.id,
      symbol: 'roundRect',
      symbolSize: [width, height],
      draggable: true,
      labelText: [`{title|${title}}`, ...table.columns.map(columnLine)].join('\n'),
      itemStyle: {
        color: theme('--vscode-editorWidget-background', theme('--vscode-editor-background', '#1e1e1e')),
        borderColor: theme('--vscode-focusBorder', '#3794ff'),
        borderWidth: 1,
        shadowBlur: 7,
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
      lineStyle: {
        color: theme('--vscode-charts-blue', '#3794ff'),
        opacity: 0.75,
        width: 1.5,
        curveness: 0.08,
      },
    };
  }

  function renderChart() {
    if (typeof echarts === 'undefined') {
      setEmpty('ECharts failed to load.');
      return;
    }
    if (!chart) chart = echarts.init(chartEl);

    const tables = data.tables.filter(table => selected.has(table.id));
    const visibleIds = new Set(tables.map(table => table.id));
    const foreignKeys = data.foreignKeys.filter(foreignKey => {
      const [source, target] = edgeEndpoints(foreignKey);
      return visibleIds.has(source) && visibleIds.has(target);
    });

    if (tables.length === 0) {
      chart.clear();
      setEmpty(data.tables.length === 0 ? 'No tables found in this scope.' : 'Select tables in the sidebar.');
      setStatus(0, 0);
      return;
    }
    emptyEl.classList.add('hidden');

    const foreground = theme('--vscode-foreground', '#cccccc');
    const dimmed = theme('--vscode-descriptionForeground', '#999999');
    chart.setOption({
      animationDurationUpdate: 350,
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
          return escapeHtml(params.data.id);
        },
      },
      series: [{
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        cursor: 'grab',
        data: tables.map(nodeFor),
        links: foreignKeys.map(linkFor),
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 9],
        force: {
          repulsion: Math.min(1600, 420 + tables.length * 28),
          edgeLength: [170, 280],
          gravity: 0.08,
          friction: 0.62,
          layoutAnimation: tables.length <= 120,
        },
        label: {
          show: true,
          position: 'inside',
          align: 'left',
          verticalAlign: 'middle',
          formatter: params => params.data.labelText,
          rich: {
            title: { color: foreground, fontWeight: 600, fontSize: 12, lineHeight: 23 },
            pk: { color: theme('--vscode-terminal-ansiYellow', '#d7ba7d'), fontWeight: 700, fontSize: 9, width: 18 },
            column: { color: foreground, fontFamily: theme('--vscode-editor-font-family', 'monospace'), fontSize: 10, lineHeight: 18 },
            type: { color: dimmed, fontFamily: theme('--vscode-editor-font-family', 'monospace'), fontSize: 9 },
          },
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: 3, opacity: 1 },
        },
      }],
    }, true);
    setStatus(tables.length, foreignKeys.length);
  }

  function setStatus(tableCount, relationCount) {
    const support = data.foreignKeysUnsupported ? ' · relationships unsupported by driver' : '';
    statusEl.textContent = `${tableCount}/${data.tables.length} tables · ${relationCount} relationships${support}`;
  }

  function setEmpty(message) {
    emptyEl.textContent = message;
    emptyEl.classList.remove('hidden');
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
        renderChart();
      });
      const text = document.createElement('span');
      text.textContent = table.id;
      const count = document.createElement('span');
      count.className = 'column-count';
      count.textContent = String(table.columns.length);
      label.append(checkbox, text, count);
      fragment.appendChild(label);
    }
    tableListEl.appendChild(fragment);
  }

  function selectTables(mode) {
    if (mode === 'all') {
      selected = new Set(data.tables.map(table => table.id));
    } else if (mode === 'connected') {
      selected = new Set(data.foreignKeys.flatMap(edgeEndpoints));
    } else {
      selected.clear();
    }
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
  allBtn.addEventListener('click', () => selectTables('all'));
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
      selected = new Set(data.tables.map(table => table.id));
      renderTableList();
      renderChart();
      refreshBtn.disabled = false;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
