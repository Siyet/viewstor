/* global L, acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // Patch Leaflet's default icon paths to use webview-served assets.
  // Leaflet normally resolves them relative to the script URL, which doesn't
  // work under the vscode-webview: scheme.
  const iconPaths = JSON.parse(document.body.getAttribute('data-icons') || '{}');
  if (iconPaths.iconUrl) {
    const proto = L.Icon.Default.prototype;
    delete proto._getIconUrl;
    L.Icon.Default.mergeOptions(iconPaths);
  }

  const mapEl = document.getElementById('map');
  const statusEl = document.getElementById('statusInfo');
  const emptyEl = document.getElementById('emptyState');
  const coordSelect = document.getElementById('coordSelect');
  const labelSelect = document.getElementById('labelSelect');

  const map = L.map(mapEl, {
    worldCopyJump: true,
  }).setView([20, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  let currentLayer = null;

  function clearLayer() {
    if (currentLayer) {
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

  function renderPoints(msg) {
    clearLayer();
    const points = msg.points || [];

    rebuildSelects(msg);

    if (points.length === 0) {
      emptyEl.classList.remove('hidden');
      statusEl.textContent = msg.skipped > 0 ? `0 points · ${msg.skipped} skipped` : '0 points';
      return;
    }
    emptyEl.classList.add('hidden');

    const group = L.featureGroup();
    const latLngs = [];
    for (const pt of points) {
      const marker = L.marker([pt.lat, pt.lng]);
      if (msg.labelColumn) {
        const labelValue = pt.row[msg.labelColumn];
        if (labelValue !== null && labelValue !== undefined && labelValue !== '') {
          marker.bindTooltip(String(labelValue), { direction: 'top', offset: [0, -20] });
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
        // Fallback if bounds are invalid
        map.setView(latLngs[0], 6);
      }
    }

    const parts = [`${points.length} point${points.length === 1 ? '' : 's'}`];
    if (msg.truncated) parts.push(`truncated to ${msg.pointLimit} of ${msg.total}`);
    if (msg.skipped > 0) parts.push(`${msg.skipped} skipped`);
    statusEl.textContent = parts.join(' · ');
  }

  function rebuildSelects(msg) {
    const cols = msg.columns || [];

    // Coord mode select: one option per single-column candidate plus any
    // (lat, lng) pair candidate. Currently we just mirror whatever the host
    // chose; the user can swap between it and "pick pair" in future.
    coordSelect.innerHTML = '';
    if (msg.mode && msg.mode.kind === 'single') {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(msg.mode);
      opt.textContent = msg.mode.column;
      opt.selected = true;
      coordSelect.appendChild(opt);
    } else if (msg.mode && msg.mode.kind === 'pair') {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(msg.mode);
      opt.textContent = `${msg.mode.latColumn}, ${msg.mode.lngColumn}`;
      opt.selected = true;
      coordSelect.appendChild(opt);
    }
    // Also offer every other single column as an alternative
    for (const c of cols) {
      if (msg.mode && msg.mode.kind === 'single' && msg.mode.column === c) continue;
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ kind: 'single', column: c });
      opt.textContent = c;
      coordSelect.appendChild(opt);
    }

    // Label select
    labelSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    if (!msg.labelColumn) noneOpt.selected = true;
    labelSelect.appendChild(noneOpt);
    for (const c of cols) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === msg.labelColumn) opt.selected = true;
      labelSelect.appendChild(opt);
    }
  }

  coordSelect.addEventListener('change', () => {
    try {
      const mode = JSON.parse(coordSelect.value);
      vscode.postMessage({ type: 'changeMode', mode });
    } catch {
      // ignore
    }
  });

  labelSelect.addEventListener('change', () => {
    const col = labelSelect.value || null;
    vscode.postMessage({ type: 'changeLabel', column: col });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'setPoints') renderPoints(msg);
  });

  // Signal ready — in case host sent data before the DOM script finished loading
  vscode.postMessage({ type: 'ready' });
})();
