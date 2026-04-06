/* Chart panel webview script */
/* globals: echarts (loaded via <script> tag), acquireVsCodeApi */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  /** @type {Record<string, unknown>[]} */
  let currentRows = [];
  /** @type {Array<{name: string, dataType: string}>} */
  let currentColumns = [];
  /** @type {import('echarts').ECharts | null} */
  let chart = null;
  /** @type {Record<string, unknown>} */
  let currentOption = {};

  // ---- Multi data source state ----
  /** @type {Array<{id: string, label: string, yColumns: string[], mergeMode: string, joinColumn?: string}>} */
  let dataSources = [];
  /** @type {Array<{id: string, label: string, query: string, rowCount: number, columns: Array<{name: string, dataType: string}>}>} */
  let availablePinned = [];
  /** @type {{id: string, label: string, columns: Array<{name: string, dataType: string}>} | null} */
  let pendingDsConfig = null;

  const AXIS_CHARTS = new Set(["line", "bar", "scatter"]);
  const HEATMAP_CHART = new Set(["heatmap"]);
  const CATEGORY_CHARTS = new Set(["pie", "funnel", "treemap", "sunburst"]);
  const STAT_CHARTS = new Set(["boxplot", "candlestick"]);
  const RADAR_CHART = new Set(["radar"]);
  const GAUGE_CHART = new Set(["gauge"]);

  const GRAFANA_COMPATIBLE = new Set(["line", "bar", "scatter", "pie", "gauge", "heatmap"]);

  const AGG_FUNCTIONS = ["none", "sum", "avg", "min", "max", "count"];

  // ---- DOM references ----
  const chartTypeSelect = document.getElementById("chartType");
  const configSidebar = document.getElementById("configSidebar");
  const chartContainer = document.getElementById("chart");
  const exportGrafanaBtn = document.getElementById("exportGrafanaBtn");
  const areaFillCheck = document.getElementById("areaFill");
  const legendCheck = document.getElementById("showLegend");
  const titleInput = document.getElementById("chartTitle");
  const popupOverlay = document.getElementById("popupOverlay");
  const addDataSourceBtn = document.getElementById("addDataSourceBtn");
  const pinnedPickerOverlay = document.getElementById("pinnedPickerOverlay");
  const dsConfigOverlay = document.getElementById("dsConfigOverlay");

  // ---- Init ----
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "setData":
        currentColumns = msg.columns || [];
        currentRows = msg.rows || [];
        initChart();
        buildSidebar();
        updateChart();
        break;
      case "setOption":
        currentOption = msg.option;
        if (chart) {
          chart.clear();
          chart.setOption(msg.option);
        }
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

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    if (chart) chart.resize();
  });
  if (chartContainer) resizeObserver.observe(chartContainer);

  // ---- Chart type change ----
  if (chartTypeSelect) {
    chartTypeSelect.addEventListener("change", () => {
      buildSidebar();
      updateChart();
      updateGrafanaButton();
    });
  }

  // ---- Area fill / legend / title ----
  if (areaFillCheck) areaFillCheck.addEventListener("change", () => updateChart());
  if (legendCheck) legendCheck.addEventListener("change", () => updateChart());
  if (titleInput) titleInput.addEventListener("input", debounce(() => updateChart(), 300));

  // ---- Grafana export ----
  if (exportGrafanaBtn) {
    exportGrafanaBtn.addEventListener("click", () => {
      const config = buildConfig();
      vscode.postMessage({ type: "exportGrafana", config });
    });
  }

  // ---- Add Data Source button ----
  if (addDataSourceBtn) {
    addDataSourceBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "requestPinnedQueries" });
    });
  }

  // ---- Init ECharts instance ----
  function initChart() {
    if (chart) chart.dispose();
    if (!chartContainer) return;
    // @ts-ignore
    chart = echarts.init(chartContainer, null, { renderer: "canvas" });
  }

  // ---- Build sidebar based on chart type ----
  function buildSidebar() {
    if (!configSidebar) return;
    const chartType = getChartType();

    const numericCols = currentColumns.filter((col) => isNumericType(col.dataType));
    const allCols = currentColumns;

    let html = "";

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
    html += buildSelect("aggFunction", "Function", AGG_FUNCTIONS);

    // Data sources section
    html += buildDataSourcesSection();

    configSidebar.innerHTML = html;

    // Bind change events for config fields
    configSidebar.querySelectorAll("select, input").forEach((el) => {
      if (!el.closest(".ds-item")) {
        el.addEventListener("change", () => updateChart());
      }
    });

    // Bind remove buttons for data sources
    configSidebar.querySelectorAll(".ds-remove-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        const dsId = event.target.dataset.dsId;
        dataSources = dataSources.filter((ds) => ds.id !== dsId);
        buildSidebar();
        updateChart();
      });
    });
  }

  // ---- Data sources section in sidebar ----
  function buildDataSourcesSection() {
    if (dataSources.length === 0) return "";

    let html = "<h3>Data Sources</h3>";
    for (const ds of dataSources) {
      html += '<div class="ds-item">';
      html += '<div class="ds-header">';
      html += '<span class="ds-label" title="' + escapeHtml(ds.label) + '">' + escapeHtml(truncate(ds.label, 30)) + "</span>";
      html += '<button class="ds-remove-btn" data-ds-id="' + escapeHtml(ds.id) + '" title="Remove">&times;</button>';
      html += "</div>";
      html += '<div class="ds-detail">';
      html += "<span>" + escapeHtml(ds.mergeMode) + (ds.joinColumn ? " on " + escapeHtml(ds.joinColumn) : "") + "</span>";
      html += "<span>" + ds.yColumns.map(escapeHtml).join(", ") + "</span>";
      html += "</div>";
      html += "</div>";
    }
    return html;
  }

  function buildAxisConfig(allCols, numericCols) {
    let html = "<h3>Axis Mapping</h3>";
    html += buildSelect("xColumn", "X Axis", allCols.map((col) => col.name));
    html += buildMultiSelect("yColumns", "Y Axis", numericCols.map((col) => col.name));
    html += buildSelect("groupByColumn", "Group By", ["(none)", ...allCols.map((col) => col.name)]);
    return html;
  }

  function buildCategoryConfig(allCols, numericCols) {
    let html = "<h3>Category Mapping</h3>";
    html += buildSelect("nameColumn", "Name Column", allCols.map((col) => col.name));
    html += buildSelect("valueColumn", "Value Column", numericCols.map((col) => col.name));
    return html;
  }

  function buildStatConfig(allCols, numericCols) {
    let html = "<h3>Stat Mapping</h3>";
    html += buildSelect("valueColumn", "Value Column", numericCols.map((col) => col.name));
    html += buildSelect("groupByColumn", "Group By", ["(none)", ...allCols.map((col) => col.name)]);
    return html;
  }

  function buildRadarConfig(allCols, numericCols) {
    let html = "<h3>Radar Mapping</h3>";
    html += buildMultiSelect("indicatorColumns", "Indicator Columns", numericCols.map((col) => col.name));
    html += buildSelect("groupByColumn", "Group By", ["(none)", ...allCols.map((col) => col.name)]);
    return html;
  }

  function buildGaugeConfig(numericCols) {
    let html = "<h3>Gauge Mapping</h3>";
    html += buildSelect("valueColumn", "Value Column", numericCols.map((col) => col.name));
    html += '<div class="field"><label>Min</label><input type="number" id="gaugeMin" value="0"></div>';
    html += '<div class="field"><label>Max</label><input type="number" id="gaugeMax" value="100"></div>';
    return html;
  }

  // ---- Build config from UI ----
  function buildConfig() {
    const chartType = getChartType();
    const config = {
      chartType,
      aggregation: { function: getSelectValue("aggFunction") || "none" },
      areaFill: areaFillCheck ? areaFillCheck.checked : false,
      showLegend: legendCheck ? legendCheck.checked : true,
      title: titleInput ? titleInput.value : "",
      dataSources: dataSources.length > 0 ? dataSources : undefined,
    };

    if (AXIS_CHARTS.has(chartType) || HEATMAP_CHART.has(chartType)) {
      const groupBy = getSelectValue("groupByColumn");
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
      const groupBy = getSelectValue("groupByColumn");
      config.stat = {
        valueColumn: getSelectValue("valueColumn") || "",
        groupByColumn: groupBy === "(none)" ? undefined : groupBy,
      };
    } else if (RADAR_CHART.has(chartType)) {
      const groupBy = getSelectValue("groupByColumn");
      config.radar = {
        indicatorColumns: getMultiSelectValues("indicatorColumns"),
        groupByColumn: groupBy === "(none)" ? undefined : groupBy,
      };
    } else if (GAUGE_CHART.has(chartType)) {
      const minInput = document.getElementById("gaugeMin");
      const maxInput = document.getElementById("gaugeMax");
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

    const config = buildConfig();
    vscode.postMessage({ type: "buildOption", config, columns: currentColumns, rows: currentRows });
  }

  // ---- Pinned query picker ----
  function showPinnedPicker() {
    if (!pinnedPickerOverlay) return;
    const list = document.getElementById("pinnedQueryList");
    const empty = document.getElementById("pinnedEmpty");

    // Filter out already-added sources
    const addedIds = new Set(dataSources.map((ds) => ds.id));
    const available = availablePinned.filter((entry) => !addedIds.has(entry.id));

    if (available.length === 0) {
      if (list) list.innerHTML = "";
      if (empty) empty.style.display = "block";
    } else {
      if (empty) empty.style.display = "none";
      if (list) {
        list.innerHTML = available
          .map((entry) => {
            const cols = entry.columns.map((col) => col.name).join(", ");
            return '<div class="pinned-item" data-entry-id="' + escapeHtml(entry.id) + '">'
              + '<div class="pinned-item-label">' + escapeHtml(entry.label) + "</div>"
              + '<div class="pinned-item-detail">' + entry.rowCount + " rows &middot; " + escapeHtml(truncate(cols, 60)) + "</div>"
              + "</div>";
          })
          .join("");

        list.querySelectorAll(".pinned-item").forEach((item) => {
          item.addEventListener("click", () => {
            const entryId = item.dataset.entryId;
            const entry = availablePinned.find((e) => e.id === entryId);
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

  function closePinnedPicker() {
    if (pinnedPickerOverlay) pinnedPickerOverlay.classList.remove("visible");
  }

  const closePinnedPickerBtn = document.getElementById("closePinnedPicker");
  if (closePinnedPickerBtn) closePinnedPickerBtn.addEventListener("click", closePinnedPicker);
  if (pinnedPickerOverlay) pinnedPickerOverlay.addEventListener("click", (event) => {
    if (event.target === pinnedPickerOverlay) closePinnedPicker();
  });

  // ---- Data source config popup ----
  function showDsConfigPopup() {
    if (!dsConfigOverlay || !pendingDsConfig) return;
    const body = document.getElementById("dsConfigBody");
    if (!body) return;

    const numericCols = pendingDsConfig.columns.filter((col) => isNumericType(col.dataType));
    const allCols = pendingDsConfig.columns;
    const primaryCols = currentColumns;

    let html = '<div class="field"><label>Label</label>';
    html += '<input type="text" id="dsLabel" value="' + escapeHtml(truncate(pendingDsConfig.label, 40)) + '"></div>';

    html += '<div class="field"><label>Merge Mode</label>';
    html += '<select id="dsMergeMode">';
    html += '<option value="separate">Separate series</option>';
    html += '<option value="join">Join by column</option>';
    html += "</select></div>";

    html += '<div id="dsJoinConfig" style="display:none">';
    html += '<div class="field"><label>Join: primary column</label>';
    html += '<select id="dsJoinPrimaryCol">';
    for (const col of primaryCols) {
      html += '<option value="' + escapeHtml(col.name) + '">' + escapeHtml(col.name) + "</option>";
    }
    html += "</select></div>";
    html += '<div class="field"><label>Join: source column</label>';
    html += '<select id="dsJoinSourceCol">';
    for (const col of allCols) {
      html += '<option value="' + escapeHtml(col.name) + '">' + escapeHtml(col.name) + "</option>";
    }
    html += "</select></div>";
    html += "</div>";

    html += '<div class="field"><label>Y Columns</label>';
    html += '<div class="multi-select" id="dsYColumns">';
    for (const col of numericCols) {
      html += '<label><input type="checkbox" value="' + escapeHtml(col.name) + '" checked>' + escapeHtml(col.name) + "</label>";
    }
    html += "</div></div>";

    body.innerHTML = html;

    // Toggle join config visibility
    const mergeSelect = document.getElementById("dsMergeMode");
    const joinConfig = document.getElementById("dsJoinConfig");
    if (mergeSelect && joinConfig) {
      mergeSelect.addEventListener("change", () => {
        joinConfig.style.display = mergeSelect.value === "join" ? "block" : "none";
      });
    }

    dsConfigOverlay.classList.add("visible");
  }

  function closeDsConfig() {
    if (dsConfigOverlay) dsConfigOverlay.classList.remove("visible");
    pendingDsConfig = null;
  }

  const closeDsConfigBtn = document.getElementById("closeDsConfig");
  if (closeDsConfigBtn) closeDsConfigBtn.addEventListener("click", closeDsConfig);
  const dsConfigCancelBtn = document.getElementById("dsConfigCancel");
  if (dsConfigCancelBtn) dsConfigCancelBtn.addEventListener("click", closeDsConfig);
  if (dsConfigOverlay) dsConfigOverlay.addEventListener("click", (event) => {
    if (event.target === dsConfigOverlay) closeDsConfig();
  });

  const dsConfigConfirmBtn = document.getElementById("dsConfigConfirm");
  if (dsConfigConfirmBtn) {
    dsConfigConfirmBtn.addEventListener("click", () => {
      if (!pendingDsConfig) return;

      const label = (document.getElementById("dsLabel") || {}).value || pendingDsConfig.label;
      const mergeMode = getSelectValue("dsMergeMode") || "separate";
      const yColumns = getMultiSelectValues("dsYColumns");

      if (yColumns.length === 0) return;

      const newDs = {
        id: pendingDsConfig.id,
        label,
        yColumns,
        mergeMode,
      };

      if (mergeMode === "join") {
        newDs.joinColumn = getSelectValue("dsJoinSourceCol") || undefined;
      }

      dataSources.push(newDs);
      closeDsConfig();
      buildSidebar();
      updateChart();
    });
  }

  // ---- Grafana button state ----
  function updateGrafanaButton() {
    if (!exportGrafanaBtn) return;
    const chartType = getChartType();
    exportGrafanaBtn.disabled = !GRAFANA_COMPATIBLE.has(chartType);
    exportGrafanaBtn.title = GRAFANA_COMPATIBLE.has(chartType)
      ? "Export to Grafana"
      : "This chart type has no Grafana equivalent";
  }

  // ---- Grafana popup ----
  function showGrafanaPopup(json) {
    if (!popupOverlay) return;
    const pre = popupOverlay.querySelector(".popup-body pre");
    if (pre) pre.textContent = JSON.stringify(JSON.parse(json), null, 2);
    popupOverlay.classList.add("visible");
  }

  // Close popup
  const closePopupBtn = document.getElementById("closePopup");
  if (closePopupBtn) closePopupBtn.addEventListener("click", closePopup);
  if (popupOverlay) popupOverlay.addEventListener("click", (event) => {
    if (event.target === popupOverlay) closePopup();
  });

  function closePopup() {
    if (popupOverlay) popupOverlay.classList.remove("visible");
  }

  // Copy JSON
  const copyJsonBtn = document.getElementById("copyJsonBtn");
  if (copyJsonBtn) {
    copyJsonBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "copyGrafanaJson" });
      closePopup();
    });
  }

  // Save JSON
  const saveJsonBtn = document.getElementById("saveJsonBtn");
  if (saveJsonBtn) {
    saveJsonBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "saveGrafanaJson" });
      closePopup();
    });
  }

  // Push to Grafana
  const pushGrafanaBtn = document.getElementById("pushGrafanaBtn");
  if (pushGrafanaBtn) {
    pushGrafanaBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "pushToGrafana" });
      closePopup();
    });
  }

  // ---- Helpers ----
  function getChartType() {
    return chartTypeSelect ? chartTypeSelect.value : "line";
  }

  function getSelectValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : "";
  }

  function getMultiSelectValues(id) {
    const container = document.getElementById(id);
    if (!container) return [];
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map((cb) => cb.value);
  }

  function buildSelect(id, label, options) {
    let html = '<div class="field">';
    html += '<label for="' + id + '">' + escapeHtml(label) + "</label>";
    html += '<select id="' + id + '">';
    for (const opt of options) {
      html += '<option value="' + escapeHtml(opt) + '">' + escapeHtml(opt) + "</option>";
    }
    html += "</select></div>";
    return html;
  }

  function buildMultiSelect(id, label, options) {
    let html = '<div class="field">';
    html += "<label>" + escapeHtml(label) + "</label>";
    html += '<div class="multi-select" id="' + id + '">';
    for (let idx = 0; idx < options.length; idx++) {
      const opt = options[idx];
      const checked = idx === 0 ? " checked" : "";
      html += '<label><input type="checkbox" value="' + escapeHtml(opt) + '"' + checked + ">" + escapeHtml(opt) + "</label>";
    }
    html += "</div></div>";
    return html;
  }

  function isNumericType(dataType) {
    const lower = dataType.toLowerCase();
    return /^(int|integer|bigint|smallint|tinyint|float|double|real|numeric|decimal|number|serial|bigserial|money|uint|int\d|uint\d|float\d)/.test(lower);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen - 1) + "\u2026" : str;
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }
})();
