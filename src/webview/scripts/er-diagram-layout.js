/* global window, module */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    gapX: 96,
    gapY: 96,
    aspectRatio: 1.55,
  });

  function compareIds(left, right) {
    return String(left).localeCompare(String(right));
  }

  function buildAdjacency(nodes, links) {
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    for (const link of links) {
      if (!adjacency.has(link.source) || !adjacency.has(link.target)) continue;
      adjacency.get(link.source).add(link.target);
      adjacency.get(link.target).add(link.source);
    }
    return adjacency;
  }

  /**
   * Return a stable, relationship-aware order. Breadth-first traversal keeps
   * directly related tables close in the following serpentine grid, while
   * connected components remain contiguous.
   */
  function relationshipOrder(nodes, links) {
    const adjacency = buildAdjacency(nodes, links);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const remaining = new Set(nodeById.keys());
    const components = [];

    while (remaining.size > 0) {
      const componentSeed = [...remaining].sort((left, right) => {
        const degreeDelta = adjacency.get(right).size - adjacency.get(left).size;
        return degreeDelta || compareIds(left, right);
      })[0];
      const queue = [componentSeed];
      const component = [];
      remaining.delete(componentSeed);

      while (queue.length > 0) {
        const current = queue.shift();
        component.push(current);
        const neighbours = [...adjacency.get(current)]
          .filter(id => remaining.has(id))
          .sort((left, right) => {
            const degreeDelta = adjacency.get(right).size - adjacency.get(left).size;
            return degreeDelta || compareIds(left, right);
          });
        for (const neighbour of neighbours) {
          remaining.delete(neighbour);
          queue.push(neighbour);
        }
      }
      components.push(component);
    }

    components.sort((left, right) => right.length - left.length || compareIds(left[0], right[0]));
    return components.flat().map(id => nodeById.get(id));
  }

  /**
   * Lay variable-size table cards out without overlap. ECharts' force layout
   * repels node centres but does not account for rectangular symbol extents,
   * so large schemas collapse into one unreadable pile. A deterministic
   * serpentine shelf layout makes every card reachable and keeps related
   * tables reasonably close without an expensive graph-layout dependency.
   */
  function layout(nodes, links, options) {
    if (nodes.length === 0) {
      return { nodes: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, columns: 0 };
    }

    const config = { ...DEFAULTS, ...(options || {}) };
    const ordered = relationshipOrder(nodes, links);
    const averageWidth = ordered.reduce((sum, node) => sum + node.width, 0) / ordered.length;
    const averageHeight = ordered.reduce((sum, node) => sum + node.height, 0) / ordered.length;
    const estimatedColumns = Math.ceil(Math.sqrt(
      ordered.length * config.aspectRatio * averageHeight / averageWidth,
    ));
    const columns = Math.max(1, Math.min(ordered.length, estimatedColumns));
    const rows = [];

    for (let offset = 0; offset < ordered.length; offset += columns) {
      const row = ordered.slice(offset, offset + columns);
      if (rows.length % 2 === 1) row.reverse();
      rows.push(row);
    }

    const positioned = [];
    let top = 0;
    let contentWidth = 0;
    for (const row of rows) {
      const rowHeight = Math.max(...row.map(node => node.height));
      let left = 0;
      for (const node of row) {
        positioned.push({
          ...node,
          x: left + node.width / 2,
          y: top + rowHeight / 2,
        });
        left += node.width + config.gapX;
      }
      contentWidth = Math.max(contentWidth, Math.max(0, left - config.gapX));
      top += rowHeight + config.gapY;
    }
    const contentHeight = Math.max(0, top - config.gapY);

    // Centre the graph around the origin so ECharts' initial fit is symmetric.
    for (const node of positioned) {
      node.x -= contentWidth / 2;
      node.y -= contentHeight / 2;
    }

    return {
      nodes: positioned,
      bounds: {
        x: -contentWidth / 2,
        y: -contentHeight / 2,
        width: contentWidth,
        height: contentHeight,
      },
      columns,
    };
  }

  /**
   * Choose a readable initial zoom and the point where full cards fit without
   * overlap. Nodes stay pixel-sized in ECharts, so the relationship between
   * graph bounds and viewport size must be reflected in the roam zoom.
   */
  function zoomLevels(bounds, viewport, sizes) {
    const availableWidth = Math.max(320, viewport.width - 64);
    const availableHeight = Math.max(240, viewport.height - 64);
    const fittedScale = Math.max(0.01, Math.min(
      availableWidth / Math.max(1, bounds.width),
      availableHeight / Math.max(1, bounds.height),
    ));
    const overview = Math.max(1, Math.min(12, sizes.overviewWidth / (sizes.detailWidth * fittedScale)));
    let detail = Math.max(2.2, Math.min(18, 1 / fittedScale));
    if (detail <= overview) detail = Math.min(24, overview * 1.6);
    return { overview, detail };
  }

  const api = { buildAdjacency, relationshipOrder, layout, zoomLevels };
  if (root) root.ViewstorErLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
