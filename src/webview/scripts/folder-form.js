/* eslint-disable */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const folderName = $('folderName');
  const folderColor = $('folderColor');
  const folderColorPicker = $('folderColorPicker');
  const readonlyMode = $('readonlyMode');
  const scopeEl = $('scope');

  const colorPicker = window.__viewstorColorPicker.init({
    colorInputId: 'folderColor',
    colorPickerId: 'folderColorPicker',
    swatchFillId: 'colorSwatchFill',
    clearBtnId: 'btnClearColor',
    randomBtnId: 'btnRandomColor',
    paletteId: 'colorPalette',
  });
  const setColorSwatch = colorPicker.setSwatch;

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
    }
  });
})();
