/* global L, acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const mapEl = document.getElementById('map');
  const statusEl = document.getElementById('statusInfo');
  const emptyEl = document.getElementById('emptyState');
  const modeSelect = document.getElementById('modeSelect');
  const singleWrap = document.getElementById('singleWrap');
  const latWrap = document.getElementById('latWrap');
  const lngWrap = document.getElementById('lngWrap');
  const singleSelect = document.getElementById('singleSelect');
  const latSelect = document.getElementById('latSelect');
  const lngSelect = document.getElementById('lngSelect');
  const labelSelect = document.getElementById('labelSelect');

  let map = null;
  let currentLayer = null;
  // Local mirror of host state — the selects read/write this and post
  // intent back to the host which re-extracts points.
  let allColumns = [];

  function getAccent() {
    const style = getComputedStyle(document.body);
    return style.getPropertyValue('--vscode-charts-blue').trim() ||
      style.getPropertyValue('--vscode-focusBorder').trim() ||
      '#3794ff';
  }

  function initMap() {
    if (map || typeof L === 'undefined') return;
    map = L.map(mapEl, { worldCopyJump: true }).setView([20, 0], 2);
    // CARTO basemaps — respect OSM attribution but don't require a Referer header,
    // which vscode-webview:// origin can't provide (OSM's tile policy blocks it).
    const isDark = document.body.classList.contains('vscode-dark') ||
      document.body.classList.contains('vscode-high-contrast');
    const variant = isDark ? 'dark_all' : 'light_all';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}{r}.png`, {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  }

  function clearLayer() {
    if (currentLayer && map) {
      map.removeLayer(currentLayer);
      currentLayer = null;
    }
  }

  function escapeHtml(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderRowPopup(row, columns) {
    const rows = columns.map(col => {
      let v = row[col];
      if (v && typeof v === 'object') {
        try { v = JSON.stringify(v); } catch { v = String(v); }
      }
      const text = v === null || v === undefined ? '' : String(v);
      const truncated = text.length > 120 ? text.slice(0, 120) + '…' : text;
      return `<tr><th>${escapeHtml(col)}</th><td>${escapeHtml(truncated)}</td></tr>`;
    }).join('');
    return `<table class="map-popup">${rows}</table>`;
  }

  function setToolbarMode(kind) {
    singleWrap.hidden = kind !== 'single';
    latWrap.hidden = kind !== 'pair';
    lngWrap.hidden = kind !== 'pair';
  }

  function populateSelect(select, cols, selected, includeNone) {
    select.innerHTML = '';
    if (includeNone) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '(none)';
      if (!selected) noneOpt.selected = true;
      select.appendChild(noneOpt);
    }
    for (const c of cols) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === selected) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function renderSelects(msg) {
    allColumns = msg.columns || [];
    const mode = msg.mode;
    const kind = mode ? mode.kind : 'single';

    modeSelect.value = kind;
    setToolbarMode(kind);

    const singleSelected = mode && mode.kind === 'single' ? mode.column : allColumns[0] || '';
    const latSelected = mode && mode.kind === 'pair' ? mode.latColumn : allColumns[0] || '';
    const lngSelected = mode && mode.kind === 'pair' ? mode.lngColumn : allColumns[1] || allColumns[0] || '';

    populateSelect(singleSelect, allColumns, singleSelected, false);
    populateSelect(latSelect, allColumns, latSelected, false);
    populateSelect(lngSelect, allColumns, lngSelected, false);
    populateSelect(labelSelect, allColumns, msg.labelColumn || '', true);
  }

  function renderPoints(msg) {
    initMap();
    renderSelects(msg);
    clearLayer();
    const points = msg.points || [];

    if (!msg.mode) {
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = 'Pick coordinate columns in the toolbar.';
      statusEl.textContent = '';
      return;
    }

    if (points.length === 0) {
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = 'No valid coordinates in the selected columns.';
      statusEl.textContent = msg.skipped > 0 ? `0 points · ${msg.skipped} skipped` : '0 points';
      return;
    }
    emptyEl.classList.add('hidden');

    if (!map) return;

    const group = L.featureGroup();
    const latLngs = [];
    const accent = getAccent();
    const markerStyle = {
      radius: 6,
      color: '#ffffff',
      weight: 1,
      fillColor: accent,
      fillOpacity: 0.85,
    };
    // Show labels permanently when the set is small enough that they won't
    // overlap into a mess; otherwise fall back to hover tooltips.
    const permanentLabels = points.length <= 50;
    for (const pt of points) {
      const marker = L.circleMarker([pt.lat, pt.lng], markerStyle);
      if (msg.labelColumn) {
        const labelValue = pt.row[msg.labelColumn];
        if (labelValue !== null && labelValue !== undefined && labelValue !== '') {
          marker.bindTooltip(String(labelValue), {
            direction: 'top',
            offset: [0, -8],
            permanent: permanentLabels,
            className: permanentLabels ? 'map-label-permanent' : '',
          });
        }
      }
      marker.bindPopup(renderRowPopup(pt.row, msg.columns || []), { maxWidth: 320 });
      marker.addTo(group);
      latLngs.push([pt.lat, pt.lng]);
    }

    group.addTo(map);
    currentLayer = group;

    if (latLngs.length === 1) {
      map.setView(latLngs[0], 12);
    } else {
      try {
        map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: 14 });
      } catch {
        map.setView(latLngs[0], 6);
      }
    }

    const parts = [`${points.length} point${points.length === 1 ? '' : 's'}`];
    if (msg.truncated) parts.push(`truncated to ${msg.pointLimit} of ${msg.total}`);
    if (msg.skipped > 0) parts.push(`${msg.skipped} skipped`);
    statusEl.textContent = parts.join(' · ');
  }

  function postMode() {
    const kind = modeSelect.value;
    if (kind === 'single') {
      const column = singleSelect.value;
      if (!column) return;
      vscode.postMessage({ type: 'changeMode', mode: { kind: 'single', column } });
    } else {
      const latColumn = latSelect.value;
      const lngColumn = lngSelect.value;
      if (!latColumn || !lngColumn) return;
      vscode.postMessage({ type: 'changeMode', mode: { kind: 'pair', latColumn, lngColumn } });
    }
  }

  modeSelect.addEventListener('change', () => {
    setToolbarMode(modeSelect.value);
    postMode();
  });
  singleSelect.addEventListener('change', postMode);
  latSelect.addEventListener('change', postMode);
  lngSelect.addEventListener('change', postMode);

  labelSelect.addEventListener('change', () => {
    const col = labelSelect.value || null;
    vscode.postMessage({ type: 'changeLabel', column: col });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'setPoints') {
      try {
        renderPoints(msg);
      } catch (err) {
        statusEl.textContent = 'Render error: ' + (err && err.message ? err.message : String(err));
      }
    }
  });

  // Signal ready — host will post initial setPoints.
  vscode.postMessage({ type: 'ready' });
})();
