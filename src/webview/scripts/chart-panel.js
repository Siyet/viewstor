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

  // Server-mode state: while a "Show full DB data" run is active, the sidebar is locked
  // and a snapshot of the previous client-side state is held so a "Reset" click can
  // restore it. We can't simply re-derive the state from currentColumns because the
  // server result drops every column the user wasn't aggregating on (review feedback:
  // tapping the X Axis dropdown after Show full DB data showed only `created_at, count`).
  var serverModeActive = false;
  var serverModeSnapshot = null;

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
        // Drop result-panel sync while we're showing server-side data — it would clobber
        // the locked snapshot, and the user already opted into that view explicitly.
        if (!syncEnabled || serverModeActive) break;
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
        if (!serverModeActive) {
          // Result arrived after the user clicked Reset — drop it; the snapshot has already
          // restored client-side state and we don't want to overwrite it.
          break;
        }
        currentColumns = msg.columns || [];
        currentRows = msg.rows || [];
        showStatus(msg.rowCount + " rows \u00b7 " + msg.executionTimeMs + "ms" + (msg.sql ? " \u00b7 " + truncate(msg.sql, 60) : ""));
        // Sidebar is locked behind disabled controls — don't rebuild it from server-side
        // columns or the user's pre-click config (chart type, axes, aggregation) is gone.
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
    if (!el || !value) return;
    // Mark the matching vscode-option with `selected` attribute so the component picks it up
    // even if the custom element hasn't fully upgraded yet (property setter alone races with upgrade)
    var opts = el.querySelectorAll('vscode-option');
    var matched = false;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].getAttribute('value') === value) {
        opts[i].setAttribute('selected', '');
        matched = true;
      } else {
        opts[i].removeAttribute('selected');
      }
    }
    if (matched) {
      try { el.value = value; } catch (e) { /* upgrade may be pending — attribute already set */ }
    } else {
      // Config carries a value the dropdown doesn't expose — UI will fall back to the first
      // option, silently ignoring the user's saved choice. Surface it so this is debuggable.
      console.warn('chart-panel: no <vscode-option> with value=' + JSON.stringify(value) + ' under #' + id);
    }
  }

  function setMultiSelectValues(id, values) {
    var container = document.getElementById(id);
    if (!container || !values) return;
    // Set both `checked` attribute (survives upgrade) and property
    container.querySelectorAll('vscode-checkbox').forEach(function(cb) {
      var wanted = values.indexOf(cb.value) >= 0;
      if (wanted) cb.setAttribute('checked', '');
      else cb.removeAttribute('checked');
      try { cb.checked = wanted; } catch (e) { /* ignore */ }
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

    // Server-side execute button — also used to pull the full table (SELECT *) when no aggregation is set.
    // Clicking again while a query is running cancels the previous one on the host side.
    // Reset button is rendered next to it and only made visible while server mode is active.
    if (tableName) {
      html += '<div class="field" style="margin-top:8px">';
      html += '<vscode-button id="showFullDbDataBtn" class="sidebar-btn" title="' + escapeHtml(TT.showFullDbData || "") + '">Show full DB data</vscode-button>';
      html += '<vscode-button id="resetServerModeBtn" class="sidebar-btn" secondary style="display:none;margin-top:6px" title="Restore client-side rendering and unlock controls">Reset</vscode-button>';
      html += '</div>';
    }

    // Data sources
    html += buildDataSourcesSection();

    configSidebar.innerHTML = html;

    // Bind change events
    configSidebar.querySelectorAll("vscode-single-select, vscode-checkbox, vscode-textfield").forEach(function (el) {
      if (!el.closest(".ds-item")) {
        el.addEventListener("change", function () {
          if (suppressChangeEvents) return;
          updateTimeBucketVisibility();
          updateChart();
        });
      }
    });

    // "Show full DB data" — only explicit click, not on every change

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
    var showFullDbDataBtn = document.getElementById("showFullDbDataBtn");
    if (showFullDbDataBtn) showFullDbDataBtn.addEventListener("click", function () {
      enterServerMode();
      executeShowFullDbData();
    });
    var resetServerModeBtn = document.getElementById("resetServerModeBtn");
    if (resetServerModeBtn) resetServerModeBtn.addEventListener("click", function () { exitServerMode(); });

    // Re-apply server-mode UI lock if it was active before this rebuild.
    if (serverModeActive) applyServerModeUI(true);

    // Check time bucket visibility after building
    updateTimeBucketVisibility();
  }

  /**
   * Capture the current client-side state (data + every dropdown / toggle the user can
   * manipulate) so a Reset click can fully restore it. Then mark server mode active and
   * lock the sidebar behind disabled controls.
   */
  function enterServerMode() {
    if (serverModeActive) return;
    serverModeSnapshot = {
      columns: currentColumns.slice(),
      rows: currentRows.slice(),
      config: buildConfig(),
      title: titleInput ? titleInput.value : "",
      areaFill: areaFillCheck ? areaFillCheck.checked : false,
      showLegend: legendCheck ? legendCheck.checked : true,
      syncEnabled: syncEnabled,
      chartType: getChartType(),
    };
    serverModeActive = true;
    applyServerModeUI(true);
  }

  /**
   * Exit server mode and restore the snapshot taken in enterServerMode(). Any
   * chartQueryResult that arrives after this point is dropped (see message handler).
   */
  function exitServerMode() {
    if (!serverModeActive || !serverModeSnapshot) {
      // Nothing to restore — just unlock controls defensively and clear state.
      serverModeActive = false;
      serverModeSnapshot = null;
      applyServerModeUI(false);
      return;
    }
    var snap = serverModeSnapshot;
    currentColumns = snap.columns;
    currentRows = snap.rows;
    if (chartTypeSelect) chartTypeSelect.value = snap.chartType;
    if (titleInput) titleInput.value = snap.title;
    if (areaFillCheck) areaFillCheck.checked = snap.areaFill;
    if (legendCheck) legendCheck.checked = snap.showLegend;
    syncEnabled = snap.syncEnabled;
    if (syncToggle) syncToggle.checked = syncEnabled;
    updateSyncUI();

    serverModeActive = false;
    serverModeSnapshot = null;

    // Rebuild the sidebar from the restored columns and re-apply saved dropdown values.
    rebuildSidebarPreservingConfig();
    applyServerModeUI(false);
    showStatus("Reset to client-side data: " + currentRows.length + " rows");
    updateChart();
  }

  /**
   * Lock or unlock all interactive controls (sidebar selects, top-bar checkboxes, title
   * input, chart-type picker) and toggle the visibility of the Show full DB data / Reset
   * button pair.
   */
  function applyServerModeUI(locked) {
    var topBarIds = ["chartType", "syncToggle", "areaFill", "showLegend", "chartTitle"];
    topBarIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (locked) el.setAttribute("disabled", "");
      else el.removeAttribute("disabled");
    });
    if (configSidebar) {
      configSidebar.querySelectorAll("vscode-single-select, vscode-checkbox, vscode-textfield").forEach(function (el) {
        // Data-source items belong to the cross-source merge feature, not the locked
        // chart config — leave them clickable so the user can still inspect / remove them.
        if (el.closest(".ds-item")) return;
        if (locked) el.setAttribute("disabled", "");
        else el.removeAttribute("disabled");
      });
      // The "+ Source" button lives outside the sidebar but is still part of the configurable
      // surface; lock it too so users can't add a new source against frozen schema.
    }
    if (addDataSourceBtn) {
      if (locked) addDataSourceBtn.setAttribute("disabled", "");
      else addDataSourceBtn.removeAttribute("disabled");
    }
    var showBtn = document.getElementById("showFullDbDataBtn");
    var resetBtn = document.getElementById("resetServerModeBtn");
    if (showBtn) showBtn.style.display = locked ? "none" : "";
    if (resetBtn) resetBtn.style.display = locked ? "" : "none";
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
  }

  /**
   * Run the chart query against the database. Aggregation is used whenever the user picked an
   * aggregation function or a time bucket; otherwise we pull every row (SELECT *). Re-clicking
   * during an in-flight query tells the host to cancel the previous driver query before
   * dispatching the new one.
   */
  function executeShowFullDbData() {
    var config = buildConfig();
    var hasAgg = config.aggregation.function !== "none" || !!config.aggregation.timeBucketPreset;
    var queryType = hasAgg ? "aggregation" : "fullData";
    vscode.postMessage({ type: "executeChartQuery", queryType: queryType, config: config });
    showStatus(hasAgg ? "Running aggregation query..." : "Loading full DB data...");
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
      html += '<vscode-button class="ds-remove-btn" secondary icon="close" data-ds-id="' + escapeHtml(ds.id) + '" title="Remove" aria-label="Remove data source"></vscode-button>';
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
  function getSelectValue(id) {
    var el = document.getElementById(id);
    if (!el) return "";
    // Prefer property; fall back to selected-option attribute for pre-upgrade reads
    if (el.value) return el.value;
    var sel = el.querySelector('vscode-option[selected]');
    if (sel) return sel.getAttribute('value') || "";
    var first = el.querySelector('vscode-option');
    return first ? first.getAttribute('value') || "" : "";
  }
  function getMultiSelectValues(id) {
    var container = document.getElementById(id);
    if (!container) return [];
    return Array.from(container.querySelectorAll('vscode-checkbox'))
      .filter(function (cb) { return cb.checked || cb.hasAttribute('checked'); })
      .map(function (cb) { return cb.value || cb.getAttribute('value') || ''; });
  }
  function buildSelect(id, label, options) {
    // label may contain HTML from tip() — do NOT escape it
    // vscode-single-select auto-selects the first vscode-option; no `selected` attribute needed
    var html = '<div class="field"><label for="' + id + '">' + label + "</label>";
    html += '<vscode-single-select id="' + id + '">';
    options.forEach(function (opt) {
      html += '<vscode-option value="' + escapeHtml(opt) + '">' + escapeHtml(opt) + "</vscode-option>";
    });
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
