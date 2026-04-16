/* eslint-disable */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const folderName = $('folderName');
  const folderColor = $('folderColor');
  const folderColorPicker = $('folderColorPicker');
  const colorSwatchFill = $('colorSwatchFill');
  const btnClearColor = $('btnClearColor');
  const btnRandomColor = $('btnRandomColor');
  const readonlyMode = $('readonlyMode');
  const scopeEl = $('scope');
  const agentAccessEl = $('agentAccess');

  function setColorSwatch(color) {
    colorSwatchFill.style.background = color || 'transparent';
  }

  folderColorPicker.addEventListener('input', function () {
    folderColor.value = folderColorPicker.value;
    setColorSwatch(folderColorPicker.value);
  });

  folderColor.addEventListener('input', function () {
    const v = folderColor.value;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      folderColorPicker.value = v;
      setColorSwatch(v);
    } else if (v.startsWith('var(')) {
      setColorSwatch(v);
    }
  });

  btnClearColor.addEventListener('click', function () {
    folderColor.value = '';
    folderColorPicker.value = '#1e1e1e';
    setColorSwatch('');
  });

  btnRandomColor.addEventListener('click', function () {
    const h = Math.floor(Math.random() * 360);
    const s = 60 + Math.floor(Math.random() * 30);
    const l = 45 + Math.floor(Math.random() * 20);
    const hex = hslToHex(h, s, l);
    folderColor.value = hex;
    folderColorPicker.value = hex;
    setColorSwatch(hex);
  });

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    function f(n) {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    }
    return '#' + f(0) + f(8) + f(4);
  }

  const palette = $('colorPalette');
  const themeColors = [
    { label: 'Red', css: 'var(--vscode-terminal-ansiRed)' },
    { label: 'Green', css: 'var(--vscode-terminal-ansiGreen)' },
    { label: 'Yellow', css: 'var(--vscode-terminal-ansiYellow)' },
    { label: 'Blue', css: 'var(--vscode-terminal-ansiBlue)' },
    { label: 'Magenta', css: 'var(--vscode-terminal-ansiMagenta)' },
    { label: 'Cyan', css: 'var(--vscode-terminal-ansiCyan)' },
    { label: 'Bright Red', css: 'var(--vscode-terminal-ansiBrightRed)' },
    { label: 'Bright Green', css: 'var(--vscode-terminal-ansiBrightGreen)' },
    { label: 'Bright Yellow', css: 'var(--vscode-terminal-ansiBrightYellow)' },
    { label: 'Bright Blue', css: 'var(--vscode-terminal-ansiBrightBlue)' },
    { label: 'Bright Magenta', css: 'var(--vscode-terminal-ansiBrightMagenta)' },
    { label: 'Bright Cyan', css: 'var(--vscode-terminal-ansiBrightCyan)' },
  ];
  themeColors.forEach(function (tc) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.title = tc.label;
    swatch.style.background = tc.css;
    swatch.addEventListener('click', function () {
      folderColor.value = tc.css;
      setColorSwatch(tc.css);
    });
    palette.appendChild(swatch);
  });

  setColorSwatch(folderColor.value || folderColorPicker.value);

  $('btnSave').addEventListener('click', function () {
    document.querySelectorAll('.error-text').forEach(function (el) { el.remove(); });
    if (!String(folderName.value || '').trim()) {
      const err = document.createElement('div');
      err.className = 'error-text';
      err.textContent = 'Folder name is required';
      (folderName.closest('.form-group') || folderName.parentNode).appendChild(err);
      return;
    }
    vscode.postMessage({
      type: 'save',
      data: {
        name: String(folderName.value).trim(),
        color: String(folderColor.value || '').trim(),
        readonly: readonlyMode.checked ? 'true' : 'false',
        scope: scopeEl.value,
        agentAccess: agentAccessEl.value || '',
      },
    });
  });

  $('btnCancel').addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message.type === 'setFolder' && message.folder) {
      const f = message.folder;
      folderName.value = f.name || '';
      folderColor.value = f.color || '';
      folderColorPicker.value = f.color && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : '#1e1e1e';
      setColorSwatch(f.color || '');
      readonlyMode.checked = !!f.readonly;
      agentAccessEl.value = f.agentAccess || '';
    }
  });
})();
