/* Chart panel webview script */
/* globals: echarts (loaded via <script> tag), acquireVsCodeApi */
(function () {
  // @ts-ignore
  var vscode = acquireVsCodeApi();

  var currentRows = [];
  var currentColumns = [];
  var chart = null;
  var syncEnabled = true;
  var isTimeXAxis = false;
  var tableName = "";
  var schemaName = "";
  var databaseType = "";
  var connectionId = "";

  // ---- Multi data source state ----
  var dataSources = [];
  var availablePinned = [];
  var pendingDsConfig = null;

  // ---- Localized tooltips (passed from extension host via data attribute) ----
  var TT = {};
  try { TT = JSON.parse(document.body.getAttribute("data-tooltips") || "{}"); } catch (e) { /* ignore */ }

  function tip(key) {
    var text = TT[key];
    if (!text) return "";
    return ' <span class="help-icon" title="' + escapeHtml(text) + '">?</span>';
  }

  var AXIS_CHARTS = new Set(["line", "bar", "scatter"]);
  var HEATMAP_CHART = new Set(["heatmap"]);
  var CATEGORY_CHARTS = new Set(["pie", "funnel", "treemap", "sunburst"]);
  var STAT_CHARTS = new Set(["boxplot", "candlestick"]);
  var RADAR_CHART = new Set(["radar"]);
  var GAUGE_CHART = new Set(["gauge"]);
  var GRAFANA_COMPATIBLE = new Set(["line", "bar", "scatter", "pie", "gauge", "heatmap"]);
  var AGG_FUNCTIONS = ["none", "sum", "avg", "min", "max", "count"];
  var TIME_TYPES = new Set([
    "timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone",
    "date", "datetime", "datetime64", "DateTime", "DateTime64",
  ]);
  var TIME_BUCKET_PRESETS = ["(none)", "second", "minute", "hour", "day", "month", "year", "custom"];

  // ---- DOM references ----
  var chartTypeSelect = document.getElementById("chartType");
  var configSidebar = document.getElementById("configSidebar");
  var chartContainer = document.getElementById("chart");
  var exportGrafanaBtn = document.getElementById("exportGrafanaBtn");
  var areaFillCheck = document.getElementById("areaFill");
  var legendCheck = document.getElementById("showLegend");
  var titleInput = document.getElementById("chartTitle");
  var popupOverlay = document.getElementById("popupOverlay");
  var addDataSourceBtn = document.getElementById("addDataSourceBtn");
  var pinnedPickerOverlay = document.getElementById("pinnedPickerOverlay");
  var dsConfigOverlay = document.getElementById("dsConfigOverlay");
  var syncToggle = document.getElementById("syncToggle");
  var refreshBtn = document.getElementById("refreshBtn");
  var fullDataToggle = document.getElementById("fullDataToggle");
  var chartStatus = document.getElementById("chartStatus");

  // ---- Message handler ----
  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "setData":
        currentColumns = msg.columns || [];
        currentRows = msg.rows || [];
        syncEnabled = msg.syncEnabled !== false;
        tableName = msg.tableName || "";
        schemaName = msg.schema || "";
        databaseType = msg.databaseType || "";
        connectionId = msg.connectionId || "";
        if (syncToggle) syncToggle.checked = syncEnabled;
        updateSyncUI();
        initChart();
        buildSidebar();
        updateChart();
        break;
      case "syncData":
        if (!syncEnabled) break;
        currentColumns = msg.columns || [];
        currentRows = msg.rows || [];
        rebuildSidebarPreservingConfig();
        updateChart();
        showStatus("Synced: " + currentRows.length + " rows");
        break;
      case "setOption":
        if (chart) { chart.clear(); chart.setOption(msg.option); }
        break;
      case "chartQueryResult":
        currentColumns = msg.columns || [];
        currentRows = msg.rows || [];
        showStatus(msg.rowCount + " rows \u00b7 " + msg.executionTimeMs + "ms" + (msg.sql ? " \u00b7 " + truncate(msg.sql, 60) : ""));
        // Rebuild sidebar with new columns but preserve user-selected config
        // (chart type, aggregation function, time bucket, axes)
        rebuildSidebarPreservingConfig();
        updateChart();
        break;
      case "chartQueryError":
        showStatus("Error: " + msg.error, true);
        break;
      case "pinnedQueries":
        availablePinned = msg.entries || [];
        showPinnedPicker();
        break;
      case "dataSourceColumns":
        if (pendingDsConfig && pendingDsConfig.id === msg.entryId) {
          pendingDsConfig.columns = msg.columns;
          showDsConfigPopup();
        }
        break;
      case "showGrafanaJson":
        showGrafanaPopup(msg.json);
        break;
    }
  });

  // ---- Resize ----
  var resizeObserver = new ResizeObserver(function () { if (chart) chart.resize(); });
  if (chartContainer) resizeObserver.observe(chartContainer);

  // ---- Chart type change ----
  if (chartTypeSelect) chartTypeSelect.addEventListener("change", function () { buildSidebar(); updateChart(); updateGrafanaButton(); });

  // ---- Toolbar controls ----
  if (areaFillCheck) areaFillCheck.addEventListener("change", function () { updateChart(); });
  if (legendCheck) legendCheck.addEventListener("change", function () { updateChart(); });
  if (titleInput) titleInput.addEventListener("input", debounce(function () { updateChart(); }, 300));

  if (exportGrafanaBtn) exportGrafanaBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "exportGrafana", config: buildConfig() });
  });

  if (addDataSourceBtn) addDataSourceBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "requestPinnedQueries" });
  });

  // ---- Sync toggle ----
  if (syncToggle) syncToggle.addEventListener("change", function () {
    syncEnabled = syncToggle.checked;
    vscode.postMessage({ type: "toggleSync", enabled: syncEnabled });
    updateSyncUI();
  });

  if (refreshBtn) refreshBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "refreshChart" });
  });

  // ---- Full data toggle ----
  if (fullDataToggle) fullDataToggle.addEventListener("change", function () {
    if (fullDataToggle.checked) {
      var config = buildConfig();
      vscode.postMessage({ type: "executeChartQuery", queryType: "fullData", config: config });
      showStatus("Loading full data...");
    } else {
      vscode.postMessage({ type: "refreshChart" });
    }
  });

  function updateSyncUI() {
    if (refreshBtn) refreshBtn.classList.toggle("hidden", syncEnabled);
  }

  function showStatus(text, isError) {
    if (!chartStatus) return;
    chartStatus.textContent = text;
    chartStatus.classList.toggle("error", !!isError);
    chartStatus.classList.add("visible");
    if (!isError) setTimeout(function () { chartStatus.classList.remove("visible"); }, 5000);
  }

  // ---- Init ECharts ----
  function initChart() {
    if (chart) chart.dispose();
    if (!chartContainer) return;
    // @ts-ignore
    chart = echarts.init(chartContainer, null, { renderer: "canvas" });
  }

  var suppressChangeEvents = false;

  /** After server-side aggregation, auto-select X = first time/category col, Y = all numeric cols */
  function autoSelectAxesFromResult() {
    if (currentColumns.length === 0) return;
    suppressChangeEvents = true;

    var timeCols = currentColumns.filter(function (c) { return isTimeType(c.dataType); });
    var numCols = currentColumns.filter(function (c) { return isNumericType(c.dataType); });
    var nonNumCols = currentColumns.filter(function (c) { return !isNumericType(c.dataType); });

    // X axis: prefer time column, fallback to first non-numeric
    var xCol = timeCols.length > 0 ? timeCols[0].name : (nonNumCols.length > 0 ? nonNumCols[0].name : currentColumns[0].name);
    setSelectValue("xColumn", xCol);

    // Y axis: select all numeric columns
    if (numCols.length > 0) {
      setMultiSelectValues("yColumns", numCols.map(function (c) { return c.name; }));
    }

    updateTimeBucketVisibility();
    suppressChangeEvents = false;
  }

  /** Rebuild sidebar but restore previously selected values */
  function rebuildSidebarPreservingConfig() {
    var saved = buildConfig();
    buildSidebar();
    // Suppress change events while restoring values — prevents duplicate queries
    suppressChangeEvents = true;
    if (saved.axis) {
      setSelectValue("xColumn", saved.axis.xColumn);
      setMultiSelectValues("yColumns", saved.axis.yColumns);
      // If Y columns couldn't be restored (renamed after aggregation, e.g. "value" → "count"),
      // auto-select numeric columns as Y axis (inline, not via autoSelectAxesFromResult to avoid
      // resetting suppressChangeEvents)
      if (getMultiSelectValues("yColumns").length === 0) {
        var numCols = currentColumns.filter(function (c) { return isNumericType(c.dataType); });
        if (numCols.length > 0) {
          setMultiSelectValues("yColumns", numCols.map(function (c) { return c.name; }));
        }
      }
      if (saved.axis.groupByColumn) setSelectValue("groupByColumn", saved.axis.groupByColumn);
    }
    if (saved.category) {
      setSelectValue("nameColumn", saved.category.nameColumn);
      setSelectValue("valueColumn", saved.category.valueColumn);
    }
    if (saved.stat) {
      setSelectValue("valueColumn", saved.stat.valueColumn);
      if (saved.stat.groupByColumn) setSelectValue("groupByColumn", saved.stat.groupByColumn);
    }
    if (saved.gauge) setSelectValue("valueColumn", saved.gauge.valueColumn);
    setSelectValue("aggFunction", saved.aggregation.function);
    if (saved.aggregation.timeBucketPreset) setSelectValue("timeBucketPreset", saved.aggregation.timeBucketPreset);
    var customInput = document.getElementById("customBucket");
    if (customInput && saved.aggregation.timeBucket) customInput.value = saved.aggregation.timeBucket;
    updateTimeBucketVisibility();
    suppressChangeEvents = false;
  }

  function setSelectValue(id, value) {
    var el = document.getElementById(id);
    if (el && value) el.value = value;
  }

  function setMultiSelectValues(id, values) {
    var container = document.getElementById(id);
    if (!container || !values) return;
    container.querySelectorAll('vscode-checkbox').forEach(function(cb) {
      cb.checked = values.indexOf(cb.value) >= 0;
    });
  }

  // ---- Build sidebar ----
  function buildSidebar() {
    if (!configSidebar) return;
    var chartType = getChartType();
    var numericCols = currentColumns.filter(function (col) { return isNumericType(col.dataType); });
    var allCols = currentColumns;

    var html = "";

    if (AXIS_CHARTS.has(chartType) || HEATMAP_CHART.has(chartType)) {
      html += buildAxisConfig(allCols, numericCols);
    } else if (CATEGORY_CHARTS.has(chartType)) {
      html += buildCategoryConfig(allCols, numericCols);
    } else if (STAT_CHARTS.has(chartType)) {
      html += buildStatConfig(allCols, numericCols);
    } else if (RADAR_CHART.has(chartType)) {
      html += buildRadarConfig(allCols, numericCols);
    } else if (GAUGE_CHART.has(chartType)) {
      html += buildGaugeConfig(numericCols);
    }

    // Aggregation
    html += "<h3>Aggregation</h3>";
    html += buildSelect("aggFunction", "Function" + tip("aggFunction"), AGG_FUNCTIONS);
    html += buildSelect("groupByColumn", "Group By" + tip("groupBy"), ["(none)"].concat(allCols.map(function (c) { return c.name; })));

    // Time bucketing (only when X column is a time type)
    html += '<div id="timeBucketSection" style="display:none">';
    html += buildSelect("timeBucketPreset", "Time Bucket" + tip("timeBucket"), TIME_BUCKET_PRESETS);
    html += '<div id="customBucketField" class="field" style="display:none"><label>Custom' + tip("customBucket") + '</label>';
    html += '<vscode-textfield id="customBucket" placeholder="1h" style="width:100%"></vscode-textfield></div>';
    html += "</div>";

    // Server-side execute button
    if (tableName) {
      html += '<div class="field" style="margin-top:8px"><vscode-button id="runAggBtn" class="sidebar-btn" title="' + escapeHtml(TT.runOnServer || "") + '">Run on Server</vscode-button></div>';
    }

    // Data sources
    html += buildDataSourcesSection();

    configSidebar.innerHTML = html;

    // Bind change events
    configSidebar.querySelectorAll("vscode-single-select, vscode-checkbox, vscode-textfield, input").forEach(function (el) {
      if (!el.closest(".ds-item")) {
        el.addEventListener("change", function () {
          if (suppressChangeEvents) return;
          updateTimeBucketVisibility();
          updateChart();
        });
      }
    });

    // "Run on Server" — only explicit click, not on every change
    // Full data toggle fires its own handler (toolbar), not sidebar

    // Bind remove buttons for data sources
    configSidebar.querySelectorAll(".ds-remove-btn").forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        var target = event.currentTarget || event.target.closest(".ds-remove-btn");
        var dsId = target ? target.dataset.dsId : undefined;
        dataSources = dataSources.filter(function (ds) { return ds.id !== dsId; });
        buildSidebar();
        updateChart();
      });
    });

    // Bind server-side execution button
    var runAggBtn = document.getElementById("runAggBtn");
    if (runAggBtn) runAggBtn.addEventListener("click", function () { executeServerSideQuery(); });

    // Check time bucket visibility after building
    updateTimeBucketVisibility();
  }

  function updateTimeBucketVisibility() {
    var xCol = getSelectValue("xColumn");
    var colInfo = currentColumns.find(function (c) { return c.name === xCol; });
    isTimeXAxis = colInfo ? isTimeType(colInfo.dataType) : false;

    // Also check: if ANY column in the dataset is a time type, show bucket section.
    // This handles cases where X column hasn't been selected yet, or dropdown defaults to non-time col.
    var hasAnyTimeCol = currentColumns.some(function (c) { return isTimeType(c.dataType); });

    var section = document.getElementById("timeBucketSection");
    if (section) section.style.display = (isTimeXAxis || hasAnyTimeCol) ? "block" : "none";

    var preset = getSelectValue("timeBucketPreset");
    var customField = document.getElementById("customBucketField");
    if (customField) customField.style.display = preset === "custom" ? "block" : "none";

    // Auto-enable Full Data when a time bucket or aggregation is selected
    if (!suppressChangeEvents && fullDataToggle && !fullDataToggle.checked) {
      var aggFn = getSelectValue("aggFunction");
      if ((preset && preset !== "(none)") || (aggFn && aggFn !== "none")) {
        fullDataToggle.checked = true;
        showStatus(TT.fullDataAuto || "Full Data enabled — aggregation needs all rows, not just the current page.");
      }
    }
  }

  function executeServerSideQuery() {
    var config = buildConfig();
    if (config.aggregation.function === "none" && !config.aggregation.timeBucketPreset) {
      showStatus("Select an aggregation function or time bucket first");
      return;
    }
    vscode.postMessage({ type: "executeChartQuery", queryType: "aggregation", config: config });
    showStatus("Running aggregation query...");
  }

  // ---- Build config sections ----
  function buildDataSourcesSection() {
    if (dataSources.length === 0) return "";
    var html = "<h3>Data Sources</h3>";
    for (var idx = 0; idx < dataSources.length; idx++) {
      var ds = dataSources[idx];
      html += '<div class="ds-item">';
      html += '<div class="ds-header">';
      html += '<span class="ds-label" title="' + escapeHtml(ds.label) + '">' + escapeHtml(truncate(ds.label, 30)) + "</span>";
      html += '<vscode-button class="ds-remove-btn" secondary data-ds-id="' + escapeHtml(ds.id) + '" title="Remove"><vscode-icon name="close"></vscode-icon></vscode-button>';
      html += "</div>";
      html += '<div class="ds-detail">';
      html += "<span>" + escapeHtml(ds.mergeMode) + (ds.joinColumn ? " on " + escapeHtml(ds.joinColumn) : "") + "</span>";
      html += "<span>" + ds.yColumns.map(escapeHtml).join(", ") + "</span>";
      html += "</div></div>";
    }
    return html;
  }

  function buildAxisConfig(allCols, numericCols) {
    var html = "<h3>Axis Mapping</h3>";
    html += buildSelect("xColumn", "X Axis" + tip("xAxis"), allCols.map(function (c) { return c.name; }));
    html += buildMultiSelect("yColumns", "Y Axis" + tip("yAxis"), numericCols.map(function (c) { return c.name; }));
    return html;
  }

  function buildCategoryConfig(allCols, numericCols) {
    var html = "<h3>Category Mapping</h3>";
    html += buildSelect("nameColumn", "Name Column" + tip("nameCol"), allCols.map(function (c) { return c.name; }));
    html += buildSelect("valueColumn", "Value Column" + tip("valueCol"), numericCols.map(function (c) { return c.name; }));
    return html;
  }

  function buildStatConfig(allCols, numericCols) {
    var html = "<h3>Stat Mapping</h3>";
    html += buildSelect("valueColumn", "Value Column" + tip("statValueCol"), numericCols.map(function (c) { return c.name; }));
    return html;
  }

  function buildRadarConfig(allCols, numericCols) {
    var html = "<h3>Radar Mapping</h3>";
    html += buildMultiSelect("indicatorColumns", "Indicator Columns" + tip("indicatorCols"), numericCols.map(function (c) { return c.name; }));
    return html;
  }

  function buildGaugeConfig(numericCols) {
    var html = "<h3>Gauge Mapping</h3>";
    html += buildSelect("valueColumn", "Value Column" + tip("gaugeValueCol"), numericCols.map(function (c) { return c.name; }));
    html += '<div class="field"><label>Min' + tip("gaugeMin") + '</label><vscode-textfield type="number" id="gaugeMin" value="0"></vscode-textfield></div>';
    html += '<div class="field"><label>Max' + tip("gaugeMax") + '</label><vscode-textfield type="number" id="gaugeMax" value="100"></vscode-textfield></div>';
    return html;
  }

  // ---- Build config from UI ----
  function buildConfig() {
    var chartType = getChartType();
    var aggPreset = getSelectValue("timeBucketPreset");
    var config = {
      chartType: chartType,
      aggregation: {
        function: getSelectValue("aggFunction") || "none",
        timeBucketPreset: (aggPreset && aggPreset !== "(none)") ? aggPreset : undefined,
        timeBucket: aggPreset === "custom" ? (document.getElementById("customBucket") || {}).value : undefined,
      },
      areaFill: areaFillCheck ? areaFillCheck.checked : false,
      showLegend: legendCheck ? legendCheck.checked : true,
      title: titleInput ? titleInput.value : "",
      dataSources: dataSources.length > 0 ? dataSources : undefined,
      syncEnabled: syncEnabled,
      fullData: fullDataToggle ? fullDataToggle.checked : false,
      tableName: tableName,
      schemaName: schemaName,
    };

    if (AXIS_CHARTS.has(chartType) || HEATMAP_CHART.has(chartType)) {
      var groupBy = getSelectValue("groupByColumn");
      config.axis = {
        xColumn: getSelectValue("xColumn") || "",
        yColumns: getMultiSelectValues("yColumns"),
        groupByColumn: groupBy === "(none)" ? undefined : groupBy,
      };
    } else if (CATEGORY_CHARTS.has(chartType)) {
      config.category = {
        nameColumn: getSelectValue("nameColumn") || "",
        valueColumn: getSelectValue("valueColumn") || "",
      };
    } else if (STAT_CHARTS.has(chartType)) {
      var groupBy2 = getSelectValue("groupByColumn");
      config.stat = {
        valueColumn: getSelectValue("valueColumn") || "",
        groupByColumn: groupBy2 === "(none)" ? undefined : groupBy2,
      };
    } else if (RADAR_CHART.has(chartType)) {
      var groupBy3 = getSelectValue("groupByColumn");
      config.radar = {
        indicatorColumns: getMultiSelectValues("indicatorColumns"),
        groupByColumn: groupBy3 === "(none)" ? undefined : groupBy3,
      };
    } else if (GAUGE_CHART.has(chartType)) {
      var minInput = document.getElementById("gaugeMin");
      var maxInput = document.getElementById("gaugeMax");
      config.gauge = {
        valueColumn: getSelectValue("valueColumn") || "",
        minValue: minInput ? Number(minInput.value) : 0,
        maxValue: maxInput ? Number(maxInput.value) : 100,
      };
    }

    return config;
  }

  // ---- Update chart ----
  function updateChart() {
    if (!chart || currentRows.length === 0) return;
    var config = buildConfig();
    vscode.postMessage({ type: "buildOption", config: config, columns: currentColumns, rows: currentRows });
  }

  // ---- Grafana button state ----
  function updateGrafanaButton() {
    if (!exportGrafanaBtn) return;
    var chartType = getChartType();
    exportGrafanaBtn.disabled = !GRAFANA_COMPATIBLE.has(chartType);
    exportGrafanaBtn.title = GRAFANA_COMPATIBLE.has(chartType) ? "Export to Grafana" : "This chart type has no Grafana equivalent";
  }

  // ---- Pinned query picker ----
  function showPinnedPicker() {
    if (!pinnedPickerOverlay) return;
    var list = document.getElementById("pinnedQueryList");
    var empty = document.getElementById("pinnedEmpty");
    var addedIds = new Set(dataSources.map(function (ds) { return ds.id; }));
    var available = availablePinned.filter(function (entry) { return !addedIds.has(entry.id); });
    if (available.length === 0) {
      if (list) list.innerHTML = "";
      if (empty) empty.style.display = "block";
    } else {
      if (empty) empty.style.display = "none";
      if (list) {
        list.innerHTML = available.map(function (entry) {
          var cols = entry.columns.map(function (c) { return c.name; }).join(", ");
          return '<div class="pinned-item" data-entry-id="' + escapeHtml(entry.id) + '">'
            + '<div class="pinned-item-label">' + escapeHtml(entry.label) + "</div>"
            + '<div class="pinned-item-detail">' + entry.rowCount + " rows \u00b7 " + escapeHtml(truncate(cols, 60)) + "</div></div>";
        }).join("");
        list.querySelectorAll(".pinned-item").forEach(function (item) {
          item.addEventListener("click", function () {
            var entryId = item.dataset.entryId;
            var entry = availablePinned.find(function (e) { return e.id === entryId; });
            if (entry) {
              pendingDsConfig = { id: entry.id, label: entry.label, columns: entry.columns };
              closePinnedPicker();
              showDsConfigPopup();
            }
          });
        });
      }
    }
    pinnedPickerOverlay.classList.add("visible");
  }

  function closePinnedPicker() { if (pinnedPickerOverlay) pinnedPickerOverlay.classList.remove("visible"); }
  var closePinnedPickerBtn = document.getElementById("closePinnedPicker");
  if (closePinnedPickerBtn) closePinnedPickerBtn.addEventListener("click", closePinnedPicker);
  if (pinnedPickerOverlay) pinnedPickerOverlay.addEventListener("click", function (e) { if (e.target === pinnedPickerOverlay) closePinnedPicker(); });

  // ---- Data source config popup ----
  function showDsConfigPopup() {
    if (!dsConfigOverlay || !pendingDsConfig) return;
    var body = document.getElementById("dsConfigBody");
    if (!body) return;
    var numericCols = pendingDsConfig.columns.filter(function (c) { return isNumericType(c.dataType); });
    var allCols = pendingDsConfig.columns;
    var primaryCols = currentColumns;
    var html = '<div class="field"><label>Label</label><vscode-textfield id="dsLabel" value="' + escapeHtml(truncate(pendingDsConfig.label, 40)) + '"></vscode-textfield></div>';
    html += '<div class="field"><label>Merge Mode</label><vscode-single-select id="dsMergeMode"><vscode-option value="separate" selected>Separate series</vscode-option><vscode-option value="join">Join by column</vscode-option></vscode-single-select></div>';
    html += '<div id="dsJoinConfig" style="display:none">';
    html += '<div class="field"><label>Join: primary column</label><vscode-single-select id="dsJoinPrimaryCol">';
    primaryCols.forEach(function (c) { html += '<vscode-option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + "</vscode-option>"; });
    html += "</vscode-single-select></div>";
    html += '<div class="field"><label>Join: source column</label><vscode-single-select id="dsJoinSourceCol">';
    allCols.forEach(function (c) { html += '<vscode-option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + "</vscode-option>"; });
    html += "</vscode-single-select></div></div>";
    html += '<div class="field"><label>Y Columns</label><div class="multi-select" id="dsYColumns">';
    numericCols.forEach(function (c) { html += '<vscode-checkbox value="' + escapeHtml(c.name) + '" checked>' + escapeHtml(c.name) + "</vscode-checkbox>"; });
    html += "</div></div>";
    body.innerHTML = html;
    var mergeSelect = document.getElementById("dsMergeMode");
    var joinConfig = document.getElementById("dsJoinConfig");
    if (mergeSelect && joinConfig) mergeSelect.addEventListener("change", function () { joinConfig.style.display = mergeSelect.value === "join" ? "block" : "none"; });
    dsConfigOverlay.classList.add("visible");
  }

  function closeDsConfig() { if (dsConfigOverlay) dsConfigOverlay.classList.remove("visible"); pendingDsConfig = null; }
  var closeDsConfigBtn = document.getElementById("closeDsConfig");
  if (closeDsConfigBtn) closeDsConfigBtn.addEventListener("click", closeDsConfig);
  var dsConfigCancelBtn = document.getElementById("dsConfigCancel");
  if (dsConfigCancelBtn) dsConfigCancelBtn.addEventListener("click", closeDsConfig);
  if (dsConfigOverlay) dsConfigOverlay.addEventListener("click", function (e) { if (e.target === dsConfigOverlay) closeDsConfig(); });

  var dsConfigConfirmBtn = document.getElementById("dsConfigConfirm");
  if (dsConfigConfirmBtn) dsConfigConfirmBtn.addEventListener("click", function () {
    if (!pendingDsConfig) return;
    var dsLabelEl = document.getElementById("dsLabel");
    var label = (dsLabelEl ? dsLabelEl.value : "") || pendingDsConfig.label;
    var mergeMode = getSelectValue("dsMergeMode") || "separate";
    var yColumns = getMultiSelectValues("dsYColumns");
    if (yColumns.length === 0) return;
    var newDs = { id: pendingDsConfig.id, label: label, yColumns: yColumns, mergeMode: mergeMode };
    if (mergeMode === "join") newDs.joinColumn = getSelectValue("dsJoinSourceCol") || undefined;
    dataSources.push(newDs);
    closeDsConfig();
    buildSidebar();
    updateChart();
  });

  // ---- Grafana popup ----
  function showGrafanaPopup(json) {
    if (!popupOverlay) return;
    var pre = popupOverlay.querySelector(".popup-body pre");
    if (pre) pre.textContent = JSON.stringify(JSON.parse(json), null, 2);
    popupOverlay.classList.add("visible");
  }
  function closePopup() { if (popupOverlay) popupOverlay.classList.remove("visible"); }
  var closePopupBtn = document.getElementById("closePopup");
  if (closePopupBtn) closePopupBtn.addEventListener("click", closePopup);
  if (popupOverlay) popupOverlay.addEventListener("click", function (e) { if (e.target === popupOverlay) closePopup(); });
  var copyJsonBtn = document.getElementById("copyJsonBtn");
  if (copyJsonBtn) copyJsonBtn.addEventListener("click", function () { vscode.postMessage({ type: "copyGrafanaJson" }); closePopup(); });
  var saveJsonBtn = document.getElementById("saveJsonBtn");
  if (saveJsonBtn) saveJsonBtn.addEventListener("click", function () { vscode.postMessage({ type: "saveGrafanaJson" }); closePopup(); });
  var pushGrafanaBtn = document.getElementById("pushGrafanaBtn");
  if (pushGrafanaBtn) pushGrafanaBtn.addEventListener("click", function () { vscode.postMessage({ type: "pushToGrafana" }); closePopup(); });

  // ---- Helpers ----
  function getChartType() { return chartTypeSelect ? chartTypeSelect.value : "line"; }
  function getSelectValue(id) { var el = document.getElementById(id); return el ? el.value : ""; }
  function getMultiSelectValues(id) {
    var container = document.getElementById(id);
    if (!container) return [];
    return Array.from(container.querySelectorAll('vscode-checkbox')).filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
  }
  function buildSelect(id, label, options) {
    // label may contain HTML from tip() — do NOT escape it
    var html = '<div class="field"><label for="' + id + '">' + label + "</label>";
    html += '<vscode-single-select id="' + id + '">';
    options.forEach(function (opt) { html += '<vscode-option value="' + escapeHtml(opt) + '">' + escapeHtml(opt) + "</vscode-option>"; });
    return html + "</vscode-single-select></div>";
  }
  function buildMultiSelect(id, label, options) {
    var html = '<div class="field"><label>' + label + '</label><div class="multi-select" id="' + id + '">';
    options.forEach(function (opt, idx) {
      html += '<vscode-checkbox value="' + escapeHtml(opt) + '"' + (idx === 0 ? " checked" : "") + ">" + escapeHtml(opt) + "</vscode-checkbox>";
    });
    return html + "</div></div>";
  }
  function isNumericType(dataType) {
    return /^(int|integer|bigint|smallint|tinyint|float|double|real|numeric|decimal|number|serial|bigserial|money|uint|int\d|uint\d|float\d)/i.test(dataType);
  }
  function isTimeType(dataType) {
    var lower = dataType.toLowerCase();
    for (var tt of TIME_TYPES) { if (lower.startsWith(tt.toLowerCase())) return true; }
    return false;
  }
  function escapeHtml(str) { var d = document.createElement("div"); d.textContent = str; return d.innerHTML; }
  function truncate(str, maxLen) { return str.length > maxLen ? str.substring(0, maxLen - 1) + "\u2026" : str; }
  function debounce(fn, ms) { var timer; return function () { var args = arguments; clearTimeout(timer); timer = setTimeout(function () { fn.apply(null, args); }, ms); }; }
})();
