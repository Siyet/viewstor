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

  var dbFields = document.getElementById('dbFields');
  var redisDbField = document.getElementById('redisDbField');
  var redisDb = document.getElementById('redisDb');

  function updateFieldVisibility() {
    var isRedis = dbType.value === 'redis';
    authFields.style.display = isRedis ? 'none' : 'block';
    dbFields.style.display = isRedis ? 'none' : 'block';
    redisDbField.classList.toggle('hidden', !isRedis);
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
  var dbInput = document.getElementById('dbInput');
  var chipsContainer = document.getElementById('chipsContainer');
  var dbListCache = [];
  var dbFetched = false;
  var selectedDbs = [];

  // Init chips from existing values
  function initChips() {
    selectedDbs = [];
    if (database.value.trim()) selectedDbs.push(database.value.trim());
    if (databases.value) {
      databases.value.split(',').filter(Boolean).forEach(function(db) {
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
    selectedDbs = selectedDbs.filter(function(d) { return d !== name; });
    syncHiddenFields();
    renderChips();
  }

  function renderChips() {
    // Remove existing chips (keep input)
    chipsContainer.querySelectorAll('.chip').forEach(function(el) { el.remove(); });
    selectedDbs.forEach(function(name, idx) {
      var chip = document.createElement('span');
      chip.className = 'chip' + (idx === 0 ? ' primary' : '');
      chip.innerHTML = name + ' <span class="chip-remove">&times;</span>';
      chip.querySelector('.chip-remove').addEventListener('click', function() { removeChip(name); });
      chipsContainer.insertBefore(chip, dbInput);
    });
  }

  // Dropdown
  function showDbDropdown() {
    var filter = dbInput.value.trim().toLowerCase();
    var items = dbListCache.filter(function(n) {
      return n.toLowerCase().includes(filter) && selectedDbs.indexOf(n) < 0;
    });
    if (items.length === 0) { dbDropdown.classList.add('hidden'); return; }
    dbDropdown.innerHTML = '';
    items.forEach(function(name) {
      var div = document.createElement('div');
      div.className = 'db-option';
      div.textContent = name;
      div.addEventListener('mousedown', function(e) {
        e.preventDefault();
        addChip(name);
        dbInput.value = '';
        dbDropdown.classList.add('hidden');
      });
      dbDropdown.appendChild(div);
    });
    dbDropdown.classList.remove('hidden');
  }

  dbInput.addEventListener('focus', function() {
    if (!dbFetched && host.value.trim()) {
      dbFetched = true;
      vscode.postMessage({ type: 'fetchDatabases', config: getFormData() });
    } else {
      showDbDropdown();
    }
  });
  dbInput.addEventListener('input', showDbDropdown);
  dbInput.addEventListener('blur', function() {
    setTimeout(function() { dbDropdown.classList.add('hidden'); }, 150);
  });
  var dropdownIdx = -1;

  function updateDropdownHighlight() {
    var options = dbDropdown.querySelectorAll('.db-option');
    options.forEach(function(o, i) {
      o.classList.toggle('active', i === dropdownIdx);
    });
    if (dropdownIdx >= 0 && options[dropdownIdx]) {
      options[dropdownIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  dbInput.addEventListener('keydown', function(e) {
    var options = dbDropdown.querySelectorAll('.db-option');
    var isOpen = !dbDropdown.classList.contains('hidden') && options.length > 0;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) { showDbDropdown(); return; }
      dropdownIdx = Math.min(dropdownIdx + 1, options.length - 1);
      updateDropdownHighlight();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (isOpen) {
        dropdownIdx = Math.max(dropdownIdx - 1, 0);
        updateDropdownHighlight();
      }
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
  chipsContainer.addEventListener('click', function() { dbInput.focus(); });

  initChips();

  // Show hint when project scope selected
  var scopeEl = document.getElementById('scope');
  var scopeHint = document.getElementById('scopeHint');
  function updateScopeHint() {
    scopeHint.classList.toggle('hidden', scopeEl.value !== 'project');
  }
  scopeEl.addEventListener('change', updateScopeHint);
  updateScopeHint();

  function getFormData() {
    return {
      id: connId.value || '',
      name: connName.value.trim(),
      type: dbType.value,
      host: host.value.trim(),
      port: port.value,
      username: username.value.trim(),
      password: password.value,
      database: dbType.value === 'redis' ? redisDb.value : database.value.trim(),
      databases: dbType.value === 'redis' ? '' : databases.value.trim(),
      ssl: ssl.checked ? 'true' : 'false',
      color: connColor.value.trim(),
      readonly: readonlyMode.checked ? 'true' : 'false',
      folderId: folderId.value || '',
      scope: document.getElementById('scope').value,
      safeMode: document.getElementById('safeMode').value,
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
          if (c.type === 'redis') { redisDb.value = c.database || '0'; }
          initChips();
          ssl.checked = !!c.ssl;
          connColor.value = c.color || '';
          connColorPicker.value = c.color || '#1e1e1e';
          readonlyMode.checked = !!c.readonly;
          folderId.value = c.folderId || '';
          document.getElementById('scope').value = c.scope || 'user';
          document.getElementById('safeMode').value = c.safeMode || '';
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
        break;
    }
  });
})();
