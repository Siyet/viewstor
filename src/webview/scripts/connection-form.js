/* eslint-disable */
(function () {
  const vscode = acquireVsCodeApi();

  const defaultPorts = { postgresql: 5432, redis: 6379, clickhouse: 8123, sqlite: 0 };

  // VS Code custom elements expose `value` / `checked` properties just like
  // native form controls and emit `change` / `input` events. Wrappers below
  // hide minor quirks (initial property hydration, etc.).
  const dbType = $('dbType');
  const connName = $('connName');
  const host = $('host');
  const port = $('port');
  const username = $('username');
  const password = $('password');
  const database = $('database');
  const ssl = $('ssl');
  const connId = $('connId');
  const folderId = $('folderId');
  const authFields = $('authFields');
  const hostPortRow = $('hostPortRow');
  const sslGroup = $('sslGroup');
  const proxyGroup = $('proxyGroup');
  const testResult = $('testResult');
  const connColor = $('connColor');
  const connColorPicker = $('connColorPicker');
  const readonlyMode = $('readonlyMode');
  const advancedSection = $('advancedSection');

  const btnSave = $('btnSave');
  const btnTest = $('btnTest');
  const btnCancel = $('btnCancel');

  const dbFields = $('dbFields');
  const redisDbField = $('redisDbField');
  const redisDb = $('redisDb');

  const proxyType = $('proxyType');
  const sshFields = $('sshFields');
  const proxyFields = $('proxyFields');

  const sqliteFileField = $('sqliteFileField');
  const sqliteFile = $('sqliteFile');

  function $(id) { return document.getElementById(id); }

  const colorPicker = window.ViewstorColorPicker.attach({
    textEl: connColor,
    pickerEl: connColorPicker,
    swatchEl: $('colorSwatchFill'),
    clearBtn: $('btnClearColor'),
    randomBtn: $('btnRandomColor'),
    paletteEl: $('colorPalette'),
  });

  function updateFieldVisibility() {
    const isRedis = dbType.value === 'redis';
    const isSqlite = dbType.value === 'sqlite';
    const isNetworkDb = !isRedis && !isSqlite;
    authFields.style.display = isNetworkDb ? 'block' : 'none';
    dbFields.style.display = isNetworkDb ? 'block' : 'none';
    if (hostPortRow) hostPortRow.style.display = isSqlite ? 'none' : '';
    redisDbField.classList.toggle('hidden', !isRedis);
    sqliteFileField.classList.toggle('hidden', !isSqlite);
    if (sslGroup) sslGroup.style.display = isSqlite ? 'none' : '';
    if (proxyGroup) proxyGroup.style.display = isSqlite ? 'none' : '';
    const hiddenSchemasGroup = $('hiddenSchemasGroup');
    if (hiddenSchemasGroup) hiddenSchemasGroup.style.display = isSqlite ? 'none' : '';
    updateProxyVisibility();
  }

  function updateProxyVisibility() {
    const pt = proxyType.value;
    sshFields.classList.toggle('hidden', pt !== 'ssh');
    proxyFields.classList.toggle('hidden', pt !== 'socks5' && pt !== 'http');
  }
  proxyType.addEventListener('change', updateProxyVisibility);

  let portManuallyChanged = false;
  dbType.addEventListener('change', function () {
    updateFieldVisibility();
    if (!portManuallyChanged) {
      port.value = String(defaultPorts[dbType.value] ?? '');
    }
    testResult.className = 'test-result hidden';
  });

  port.addEventListener('input', function () { portManuallyChanged = true; });

  updateFieldVisibility();

  // Databases chips
  const databases = $('databases');
  const dbDropdown = $('dbDropdown');
  const dbInput = $('dbInput');
  const chipsContainer = $('chipsContainer');
  let dbListCache = [];
  let dbFetched = false;
  let selectedDbs = [];

  function initChips() {
    selectedDbs = [];
    if (database.value.trim()) selectedDbs.push(database.value.trim());
    if (databases.value) {
      databases.value.split(',').filter(Boolean).forEach(function (db) {
        if (selectedDbs.indexOf(db) < 0) selectedDbs.push(db);
      });
    }
    renderChips();
  }

  function syncHiddenFields() {
    database.value = selectedDbs[0] || '';
    databases.value = selectedDbs.slice(1).join(',');
  }

  function addChip(name) {
    name = name.trim();
    if (!name || selectedDbs.indexOf(name) >= 0) return;
    selectedDbs.push(name);
    syncHiddenFields();
    renderChips();
  }

  function removeChip(name) {
    selectedDbs = selectedDbs.filter(function (d) { return d !== name; });
    syncHiddenFields();
    renderChips();
  }

  function renderChips() {
    chipsContainer.querySelectorAll('.chip').forEach(function (el) { el.remove(); });
    selectedDbs.forEach(function (name, idx) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (idx === 0 ? ' primary' : '');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      const x = document.createElement('span');
      x.className = 'chip-remove';
      x.textContent = '\u00d7';
      x.addEventListener('click', function () { removeChip(name); });
      chip.appendChild(nameSpan);
      chip.appendChild(document.createTextNode(' '));
      chip.appendChild(x);
      chipsContainer.insertBefore(chip, dbInput);
    });
  }

  function showDbDropdown() {
    const filter = dbInput.value.trim().toLowerCase();
    const items = dbListCache.filter(function (n) {
      return n.toLowerCase().includes(filter) && selectedDbs.indexOf(n) < 0;
    });
    if (items.length === 0) { dbDropdown.classList.add('hidden'); return; }
    dbDropdown.innerHTML = '';
    items.forEach(function (name) {
      const div = document.createElement('div');
      div.className = 'db-option';
      div.textContent = name;
      div.addEventListener('mousedown', function (e) {
        e.preventDefault();
        addChip(name);
        dbInput.value = '';
        dbDropdown.classList.add('hidden');
      });
      dbDropdown.appendChild(div);
    });
    dbDropdown.classList.remove('hidden');
  }

  dbInput.addEventListener('focus', function () {
    if (!dbFetched && host.value.trim()) {
      dbFetched = true;
      vscode.postMessage({ type: 'fetchDatabases', config: getFormData() });
    } else {
      showDbDropdown();
    }
  });
  dbInput.addEventListener('input', showDbDropdown);
  dbInput.addEventListener('blur', function () {
    setTimeout(function () { dbDropdown.classList.add('hidden'); }, 150);
  });

  let dropdownIdx = -1;
  function updateDropdownHighlight() {
    const options = dbDropdown.querySelectorAll('.db-option');
    options.forEach(function (o, i) { o.classList.toggle('active', i === dropdownIdx); });
    if (dropdownIdx >= 0 && options[dropdownIdx]) {
      options[dropdownIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  dbInput.addEventListener('keydown', function (e) {
    const options = dbDropdown.querySelectorAll('.db-option');
    const isOpen = !dbDropdown.classList.contains('hidden') && options.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) { showDbDropdown(); return; }
      dropdownIdx = Math.min(dropdownIdx + 1, options.length - 1);
      updateDropdownHighlight();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (isOpen) { dropdownIdx = Math.max(dropdownIdx - 1, 0); updateDropdownHighlight(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && dropdownIdx >= 0 && options[dropdownIdx]) {
        addChip(options[dropdownIdx].textContent);
        dbInput.value = '';
        dbDropdown.classList.add('hidden');
        dropdownIdx = -1;
      } else if (dbInput.value.trim()) {
        addChip(dbInput.value);
        dbInput.value = '';
        dbDropdown.classList.add('hidden');
        dropdownIdx = -1;
      }
      return;
    }
    if (e.key === 'Escape' && isOpen) {
      dbDropdown.classList.add('hidden');
      dropdownIdx = -1;
      return;
    }
    if (e.key === 'Backspace' && !dbInput.value && selectedDbs.length > 0) {
      removeChip(selectedDbs[selectedDbs.length - 1]);
    }
    dropdownIdx = -1;
  });
  chipsContainer.addEventListener('click', function () { dbInput.focus(); });

  initChips();

  // Scope hint
  const scopeEl = $('scope');
  const scopeHint = $('scopeHint');
  function updateScopeHint() { scopeHint.classList.toggle('hidden', scopeEl.value !== 'project'); }
  scopeEl.addEventListener('change', updateScopeHint);
  updateScopeHint();

  function valueOf(el) { return (el && el.value != null) ? String(el.value) : ''; }

  function getFormData() {
    const isRedis = dbType.value === 'redis';
    const isSqlite = dbType.value === 'sqlite';
    return {
      id: connId.value || '',
      name: valueOf(connName).trim(),
      type: dbType.value,
      host: valueOf(host).trim(),
      port: valueOf(port),
      username: valueOf(username).trim(),
      password: valueOf(password),
      database: isRedis ? valueOf(redisDb) : isSqlite ? valueOf(sqliteFile).trim() : database.value.trim(),
      databases: (isRedis || isSqlite) ? '' : databases.value.trim(),
      ssl: ssl.checked ? 'true' : 'false',
      color: colorPicker.getValue(),
      readonly: readonlyMode.checked ? 'true' : 'false',
      folderId: folderId.value || '',
      scope: scopeEl.value,
      safeMode: $('safeMode').value,
      proxyType: proxyType.value,
      sshHost: valueOf($('sshHost')).trim(),
      sshPort: valueOf($('sshPort')),
      sshUsername: valueOf($('sshUsername')).trim(),
      sshPassword: valueOf($('sshPassword')),
      sshPrivateKey: valueOf($('sshPrivateKey')).trim(),
      proxyHost: valueOf($('proxyHost')).trim(),
      proxyPort: valueOf($('proxyPort')),
      proxyUsername: valueOf($('proxyUsername')).trim(),
      proxyPassword: valueOf($('proxyPassword')),
      hiddenSchemas: valueOf($('hiddenSchemas')).trim(),
      agentAnonymization: $('agentAnonymization').value,
      agentAnonymizationStrategy: $('agentAnonymizationStrategy').value,
    };
  }

  function showError(field, message) {
    const err = document.createElement('div');
    err.className = 'error-text';
    err.textContent = message;
    const target = field.closest('.form-group') || field.parentNode;
    target.appendChild(err);
  }

  function validate() {
    let valid = true;
    const isSqlite = dbType.value === 'sqlite';
    document.querySelectorAll('.error-text').forEach(function (el) { el.remove(); });

    if (!valueOf(connName).trim()) { showError(connName, 'Connection name is required'); valid = false; }
    if (isSqlite) {
      if (!valueOf(sqliteFile).trim()) { showError(sqliteFile, 'Database file path is required'); valid = false; }
    } else {
      if (!valueOf(host).trim()) { showError(host, 'Host is required'); valid = false; }
      const portNum = Number(valueOf(port));
      if (!valueOf(port) || isNaN(portNum) || portNum <= 0) { showError(port, 'Port must be a positive number'); valid = false; }
    }
    return valid;
  }

  btnSave.addEventListener('click', function () {
    if (!validate()) return;
    vscode.postMessage({ type: 'save', config: getFormData() });
  });

  btnTest.addEventListener('click', function () {
    if (!validate()) return;
    btnTest.disabled = true;
    testResult.textContent = 'Testing connection...';
    testResult.className = 'test-result testing';
    vscode.postMessage({ type: 'testConnection', config: getFormData() });
  });

  btnCancel.addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    switch (message.type) {
      case 'testResult':
        btnTest.disabled = false;
        testResult.textContent = message.message || '';
        if (message.status === 'success') testResult.className = 'test-result success';
        else if (message.status === 'failure') testResult.className = 'test-result failure';
        else testResult.className = 'test-result testing';
        break;

      case 'setConfig':
        if (message.config) {
          const c = message.config;
          connId.value = c.id || '';
          dbType.value = c.type || 'postgresql';
          connName.value = c.name || '';
          host.value = c.host || 'localhost';
          port.value = String(c.port || defaultPorts[c.type || 'postgresql']);
          username.value = c.username || '';
          password.value = c.password || '';
          database.value = c.database || '';
          databases.value = (c.databases || []).join(',');
          if (c.type === 'redis') redisDb.value = c.database || '0';
          if (c.type === 'sqlite') sqliteFile.value = c.database || '';
          initChips();
          ssl.checked = !!c.ssl;
          colorPicker.setValue(c.color || '');
          readonlyMode.checked = !!c.readonly;
          folderId.value = c.folderId || '';
          scopeEl.value = c.scope || 'user';
          $('safeMode').value = c.safeMode || '';
          $('agentAnonymization').value = c.agentAnonymization || '';
          $('agentAnonymizationStrategy').value = c.agentAnonymizationStrategy || '';
          $('hiddenSchemas').value = c.hiddenSchemas ? Object.values(c.hiddenSchemas).flat().join(', ') : '';
          proxyType.value = c.proxy?.type || 'none';
          if (c.proxy) {
            $('sshHost').value = c.proxy.sshHost || '';
            $('sshPort').value = String(c.proxy.sshPort || 22);
            $('sshUsername').value = c.proxy.sshUsername || '';
            $('sshPassword').value = c.proxy.sshPassword || '';
            $('sshPrivateKey').value = c.proxy.sshPrivateKey || '';
            $('proxyHost').value = c.proxy.proxyHost || '';
            $('proxyPort').value = String(c.proxy.proxyPort || 1080);
            $('proxyUsername').value = c.proxy.proxyUsername || '';
            $('proxyPassword').value = c.proxy.proxyPassword || '';
          }
          updateFieldVisibility();
        } else {
          const defaults = message.defaults || {};
          if (defaults.folderId) folderId.value = defaults.folderId;
          if (defaults.readonly) readonlyMode.checked = true;
        }
        break;

      case 'databaseList':
        dbListCache = message.databases || [];
        showDbDropdown();
        break;
    }
  });
})();
