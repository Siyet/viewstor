/* eslint-disable */
/*
 * Database Statistics panel webview script.
 *
 * Receives `setStats` / `error` messages from the extension host and renders:
 *   - Overview tiles (databaseStats.overview)
 *   - Sortable top-tables table (databaseStats.topTables)
 *   - Connection-level metrics list (databaseStats.connectionLevel)
 *
 * Sorting is performed client-side; refresh is delegated to the host via
 * `{ type: 'refresh' }`.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const state = {
    stats: null,
    sortKey: 'size',
    sortDir: 'desc',
    databaseName: null,
    lastTimestamp: null,
  };

  const errorBanner = $('errorBanner');
  const overviewTiles = $('overviewTiles');
  const topTables = $('topTables');
  const topTablesBody = topTables.querySelector('tbody');
  const topTablesEmpty = $('topTablesEmpty');
  const connectionLevel = $('connectionLevel');
  const statsTimestamp = $('statsTimestamp');
  const btnRefresh = $('btnRefresh');

  btnRefresh.addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
    setRefreshing(true);
  });

  topTables.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      const key = th.getAttribute('data-sort');
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'name' ? 'asc' : 'desc';
      }
      renderTopTables();
    });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'setStats') {
      hideError();
      state.stats = message.stats;
      state.databaseName = message.databaseName || null;
      state.lastTimestamp = message.timestamp || new Date().toISOString();
      render();
      setRefreshing(false);
    } else if (message.type === 'error') {
      showError(message.message || 'Unknown error');
      setRefreshing(false);
    }
  });

  function setRefreshing(on) {
    if (!btnRefresh) return;
    try { btnRefresh.disabled = !!on; } catch (_) {}
  }

  function showError(message) {
    errorBanner.hidden = false;
    errorBanner.textContent = message;
  }

  function hideError() {
    errorBanner.hidden = true;
    errorBanner.textContent = '';
  }

  function render() {
    if (!state.stats || typeof state.stats !== 'object') {
      showError('No statistics available.');
      return;
    }
    renderTimestamp();
    renderOverview(state.stats.overview || []);
    renderTopTables();
    renderConnectionLevel(state.stats.connectionLevel || []);
  }

  function renderTimestamp() {
    if (!state.lastTimestamp) {
      statsTimestamp.textContent = '';
      return;
    }
    try {
      const date = new Date(state.lastTimestamp);
      statsTimestamp.textContent = 'Last updated ' + date.toLocaleTimeString();
    } catch (_) {
      statsTimestamp.textContent = '';
    }
  }

  function renderOverview(items) {
    overviewTiles.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No overview metrics reported.';
      overviewTiles.appendChild(empty);
      return;
    }
    items.forEach(function (stat) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = stat.label;
      const value = document.createElement('div');
      value.className = 'tile-value';
      value.textContent = formatStat(stat);
      tile.appendChild(label);
      tile.appendChild(value);
      overviewTiles.appendChild(tile);
    });
  }

  function renderTopTables() {
    const rows = (state.stats && state.stats.topTables) || [];
    topTablesBody.innerHTML = '';
    if (!rows.length) {
      topTablesEmpty.hidden = false;
      updateSortIndicators();
      return;
    }
    topTablesEmpty.hidden = true;

    const sorted = sortTopTables(rows, state.sortKey, state.sortDir);
    const maxSize = maxNumeric(sorted.map(function (r) { return r.sizeBytes; }));
    const maxIdx = maxNumeric(sorted.map(function (r) { return r.indexesSizeBytes; }));
    const maxRows = maxNumeric(sorted.map(function (r) { return r.rowCount; }));

    sorted.forEach(function (row) {
      const tr = document.createElement('tr');
      tr.appendChild(cellText(row.schema ? row.schema + '.' + row.name : row.name, 'name-cell'));
      tr.appendChild(cellBar(row.rowCount, maxRows, formatCount));
      tr.appendChild(cellBar(row.sizeBytes, maxSize, formatBytes));
      tr.appendChild(cellBar(row.indexesSizeBytes, maxIdx, formatBytes));
      tr.appendChild(cellText(formatPercent(row.deadTuplesPct), 'num', row.deadTuplesPct !== null && row.deadTuplesPct >= 20 ? 'warn' : ''));
      tr.appendChild(cellText(formatDate(row.lastVacuum)));
      topTablesBody.appendChild(tr);
    });

    updateSortIndicators();
  }

  function renderConnectionLevel(items) {
    connectionLevel.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'No connection-level metrics reported.';
      connectionLevel.appendChild(empty);
      return;
    }
    items.forEach(function (stat) {
      const li = document.createElement('li');
      li.className = 'metric-item';
      const label = document.createElement('span');
      label.className = 'metric-label';
      label.textContent = stat.label;
      const value = document.createElement('span');
      value.className = 'metric-value';
      value.textContent = formatStat(stat);
      li.appendChild(label);
      li.appendChild(value);
      connectionLevel.appendChild(li);
    });
  }

  function updateSortIndicators() {
    topTables.querySelectorAll('th[data-sort]').forEach(function (th) {
      const key = th.getAttribute('data-sort');
      th.classList.remove('sort-asc', 'sort-desc');
      if (key === state.sortKey) {
        th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });
  }

  function cellText(text, extraClass, flagClass) {
    const td = document.createElement('td');
    if (extraClass) td.className = extraClass;
    if (flagClass) td.classList.add(flagClass);
    td.textContent = text == null ? '—' : String(text);
    return td;
  }

  function cellBar(value, max, formatter) {
    const td = document.createElement('td');
    td.className = 'num bar-cell';
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    const pct = (typeof value === 'number' && max > 0) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'bar-value';
    label.textContent = value == null ? '—' : formatter(value);
    wrap.appendChild(bar);
    wrap.appendChild(label);
    td.appendChild(wrap);
    return td;
  }

  // ---- sort + format helpers (duplicated from databaseStatsFormat.ts for the webview bundle) ----

  function sortTopTables(rows, key, direction) {
    const selector = function (row) {
      switch (key) {
        case 'size': return row.sizeBytes;
        case 'rows': return row.rowCount;
        case 'indexes': return row.indexesSizeBytes;
        case 'dead': return row.deadTuplesPct;
        case 'name': return row.name;
        default: return null;
      }
    };
    return rows.slice().sort(function (a, b) {
      const av = selector(a);
      const bv = selector(b);
      if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return direction === 'asc' ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return direction === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
  }

  function maxNumeric(values) {
    let max = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (typeof v === 'number' && v > max) max = v;
    }
    return max;
  }

  function formatStat(stat) {
    if (stat.value === null || stat.value === undefined) return '—';
    switch (stat.unit) {
      case 'bytes': return formatBytes(Number(stat.value));
      case 'count': return formatCount(Number(stat.value));
      case 'percent': return formatPercent(Number(stat.value));
      case 'date': return formatDate(stat.value);
      default: return String(stat.value);
    }
  }

  function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes)) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    const decimals = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(decimals) + ' ' + units[i];
  }

  function formatCount(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
  }

  function formatPercent(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const decimals = n >= 10 ? 0 : 1;
    return n.toFixed(decimals) + '%';
  }

  function formatDate(value) {
    if (value == null || value === '') return '—';
    try {
      const d = new Date(value);
      if (isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    } catch (_) {
      return String(value);
    }
  }
})();
