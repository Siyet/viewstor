/* Result grid webview script */
(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'setData':
        renderGrid(message.data);
        break;
    }
  });

  function renderGrid(result) {
    const container = document.getElementById('grid-container');
    if (!container) return;

    if (result.error) {
      container.innerHTML = `<div class="error">${escapeHtml(result.error)}</div>`;
      return;
    }

    const stats = document.getElementById('stats');
    if (stats) {
      stats.textContent = `${result.rowCount} rows · ${result.executionTimeMs}ms${result.truncated ? ' (truncated)' : ''}`;
    }

    let html = '<table><thead><tr>';
    html += '<th class="row-num">#</th>';
    for (const col of result.columns) {
      html += `<th data-column="${escapeHtml(col.name)}">${escapeHtml(col.name)}<span class="type-hint">${escapeHtml(col.dataType)}</span></th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      html += `<tr data-index="${i}"><td class="row-num">${i + 1}</td>`;
      for (const col of result.columns) {
        const val = row[col.name];
        if (val === null || val === undefined) {
          html += '<td class="null-value">NULL</td>';
        } else if (typeof val === 'object') {
          html += `<td>${escapeHtml(JSON.stringify(val))}</td>`;
        } else {
          html += `<td>${escapeHtml(String(val))}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;

    // Row selection
    container.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.index !== undefined) {
        document.querySelectorAll('tr.selected').forEach(el => el.classList.remove('selected'));
        tr.classList.add('selected');
      }
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
