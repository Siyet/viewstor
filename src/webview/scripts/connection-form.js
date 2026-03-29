(function () {
  const vscode = acquireVsCodeApi();

  const defaultPorts = { postgresql: 5432, redis: 6379, clickhouse: 8123 };

  const dbType = document.getElementById('dbType');
  const connName = document.getElementById('connName');
  const host = document.getElementById('host');
  const port = document.getElementById('port');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const database = document.getElementById('database');
  const ssl = document.getElementById('ssl');
  const connId = document.getElementById('connId');
  const folderId = document.getElementById('folderId');
  const authFields = document.getElementById('authFields');
  const testResult = document.getElementById('testResult');
  const connColor = document.getElementById('connColor');
  const connColorPicker = document.getElementById('connColorPicker');
  const btnClearColor = document.getElementById('btnClearColor');
  const readonlyMode = document.getElementById('readonlyMode');

  const btnSave = document.getElementById('btnSave');
  const btnTest = document.getElementById('btnTest');
  const btnCancel = document.getElementById('btnCancel');

  // Toggle auth fields based on DB type
  function updateFieldVisibility() {
    var isRedis = dbType.value === 'redis';
    authFields.style.display = isRedis ? 'none' : 'block';
  }

  // Update default port when type changes
  var portManuallyChanged = false;
  dbType.addEventListener('change', function () {
    updateFieldVisibility();
    if (!portManuallyChanged) {
      port.value = defaultPorts[dbType.value];
    }
    testResult.className = 'test-result hidden';
  });

  port.addEventListener('input', function () {
    portManuallyChanged = true;
  });

  // Color sync
  connColorPicker.addEventListener('input', function () {
    connColor.value = connColorPicker.value;
  });

  connColor.addEventListener('input', function () {
    if (/^#[0-9a-fA-F]{6}$/.test(connColor.value)) {
      connColorPicker.value = connColor.value;
    }
  });

  btnClearColor.addEventListener('click', function () {
    connColor.value = '';
    connColorPicker.value = '#1e1e1e';
  });

  // Randomize color
  var btnRandomColor = document.getElementById('btnRandomColor');
  btnRandomColor.addEventListener('click', function () {
    var h = Math.floor(Math.random() * 360);
    var s = 60 + Math.floor(Math.random() * 30);
    var l = 45 + Math.floor(Math.random() * 20);
    var hex = hslToHex(h, s, l);
    connColor.value = hex;
    connColorPicker.value = hex;
  });

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var a = s * Math.min(l, 1 - l);
    function f(n) {
      var k = (n + h / 30) % 12;
      var color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color).toString(16).padStart(2, '0');
    }
    return '#' + f(0) + f(8) + f(4);
  }

  // Color palette
  var palette = document.getElementById('colorPalette');
  var themeColors = [
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
    var swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.title = tc.label;
    swatch.style.background = tc.css;
    swatch.addEventListener('click', function () {
      connColor.value = tc.css;
      // Can't set native color picker to CSS var, just leave it
    });
    palette.appendChild(swatch);
  });

  updateFieldVisibility();

  var databases = document.getElementById('databases');
  var dbDropdown = document.getElementById('dbDropdown');
  var dbTags = document.getElementById('dbTags');
  var dbListCache = [];
  var dbFetched = false;

  function getSelectedDbs() {
    return databases.value ? databases.value.split(',').filter(Boolean) : [];
  }
  function setSelectedDbs(dbs) {
    databases.value = dbs.join(',');
  }

  // Custom dropdown for Database field
  function showDbDropdown() {
    var filter = database.value.trim().toLowerCase();
    var items = dbListCache.filter(function(n) { return n.toLowerCase().includes(filter); });
    if (items.length === 0) { dbDropdown.classList.add('hidden'); return; }
    dbDropdown.innerHTML = '';
    items.forEach(function(name) {
      var div = document.createElement('div');
      div.className = 'db-option';
      div.textContent = name;
      div.addEventListener('mousedown', function(e) {
        e.preventDefault();
        database.value = name;
        dbDropdown.classList.add('hidden');
        renderDbTags();
      });
      dbDropdown.appendChild(div);
    });
    dbDropdown.classList.remove('hidden');
  }

  database.addEventListener('focus', function() {
    if (!dbFetched && host.value.trim()) {
      dbFetched = true;
      vscode.postMessage({ type: 'fetchDatabases', config: getFormData() });
    } else {
      showDbDropdown();
    }
  });
  database.addEventListener('input', showDbDropdown);
  database.addEventListener('blur', function() {
    setTimeout(function() { dbDropdown.classList.add('hidden'); renderDbTags(); }, 150);
  });

  // Tags for additional databases
  function renderDbTags() {
    dbTags.innerHTML = '';
    if (dbListCache.length === 0) return;
    var selected = getSelectedDbs();
    var mainDb = database.value.trim();
    dbListCache.forEach(function(name) {
      if (name === mainDb) return;
      var tag = document.createElement('button');
      tag.type = 'button';
      tag.textContent = name;
      tag.style.cssText = 'padding:2px 8px;font-size:12px;border-radius:3px;cursor:pointer;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));';
      if (selected.indexOf(name) >= 0) {
        tag.style.background = 'var(--vscode-button-background)';
        tag.style.color = 'var(--vscode-button-foreground)';
      } else {
        tag.style.background = 'var(--vscode-input-background)';
        tag.style.color = 'var(--vscode-input-foreground)';
      }
      tag.addEventListener('click', function() {
        var sel = getSelectedDbs();
        var idx = sel.indexOf(name);
        if (idx >= 0) sel.splice(idx, 1);
        else sel.push(name);
        setSelectedDbs(sel);
        renderDbTags();
      });
      dbTags.appendChild(tag);
    });
  }

  function getFormData() {
    return {
      id: connId.value || '',
      name: connName.value.trim(),
      type: dbType.value,
      host: host.value.trim(),
      port: port.value,
      username: username.value.trim(),
      password: password.value,
      database: database.value.trim(),
      databases: databases.value.trim(),
      ssl: ssl.checked ? 'true' : 'false',
      color: connColor.value.trim(),
      readonly: readonlyMode.checked ? 'true' : 'false',
      folderId: folderId.value || '',
    };
  }

  function validate() {
    var valid = true;
    document.querySelectorAll('.error-text').forEach(function (el) { el.remove(); });

    if (!connName.value.trim()) {
      showError(connName, 'Connection name is required');
      valid = false;
    }
    if (!host.value.trim()) {
      showError(host, 'Host is required');
      valid = false;
    }
    if (!port.value || isNaN(Number(port.value)) || Number(port.value) <= 0) {
      showError(port, 'Port must be a positive number');
      valid = false;
    }
    return valid;
  }

  function showError(input, message) {
    var err = document.createElement('div');
    err.className = 'error-text';
    err.textContent = message;
    input.parentNode.appendChild(err);
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
    var message = event.data;
    switch (message.type) {
      case 'testResult':
        btnTest.disabled = false;
        testResult.textContent = message.message || '';
        if (message.status === 'success') {
          testResult.className = 'test-result success';
        } else if (message.status === 'failure') {
          testResult.className = 'test-result failure';
        } else {
          testResult.className = 'test-result testing';
        }
        break;

      case 'setConfig':
        if (message.config) {
          var c = message.config;
          connId.value = c.id || '';
          dbType.value = c.type || 'postgresql';
          connName.value = c.name || '';
          host.value = c.host || 'localhost';
          port.value = c.port || defaultPorts[c.type || 'postgresql'];
          username.value = c.username || '';
          password.value = c.password || '';
          database.value = c.database || '';
          databases.value = (c.databases || []).join(',');
          ssl.checked = !!c.ssl;
          connColor.value = c.color || '';
          connColorPicker.value = c.color || '#1e1e1e';
          readonlyMode.checked = !!c.readonly;
          folderId.value = c.folderId || '';
          updateFieldVisibility();
        } else {
          // New connection — apply folder defaults
          var defaults = message.defaults || {};
          if (defaults.folderId) folderId.value = defaults.folderId;
          if (defaults.readonly) readonlyMode.checked = true;
        }
        break;

      case 'databaseList':
        dbListCache = message.databases || [];
        showDbDropdown();
        renderDbTags();
        break;
    }
  });
})();
