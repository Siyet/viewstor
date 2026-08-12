/* global window, module */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    gapX: 96,
    gapY: 96,
    aspectRatio: 1.55,
    regionGapX: 150,
    regionGapY: 150,
    regionPaddingX: 72,
    regionPaddingTop: 82,
    regionPaddingBottom: 64,
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
  function shelfLayout(nodes, links, options) {
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
   * Keep every named schema/database in its own non-overlapping region. Each
   * namespace gets the same deterministic relationship-aware shelf layout,
   * then the resulting region rectangles are packed into a larger grid.
   */
  function layout(nodes, links, options) {
    if (nodes.length === 0) {
      return { nodes: [], regions: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, columns: 0 };
    }
    const config = { ...DEFAULTS, ...(options || {}) };
    const namedNodes = nodes.filter(node => node.schema);
    if (namedNodes.length === 0) {
      return { ...shelfLayout(nodes, links, config), regions: [] };
    }

    const nodesByNamespace = new Map();
    for (const node of nodes) {
      const name = node.schema || 'default';
      if (!nodesByNamespace.has(name)) nodesByNamespace.set(name, []);
      nodesByNamespace.get(name).push(node);
    }
    const namespaceNames = [...nodesByNamespace.keys()].sort(compareIds);
    const namespaceCards = namespaceNames.map(name => {
      const namespaceNodes = nodesByNamespace.get(name);
      const ids = new Set(namespaceNodes.map(node => node.id));
      const namespaceLinks = links.filter(link => ids.has(link.source) && ids.has(link.target));
      const inner = shelfLayout(namespaceNodes, namespaceLinks, {
        ...config,
        aspectRatio: Math.max(1, Math.min(1.6, config.aspectRatio)),
      });
      return {
        name,
        inner,
        width: inner.bounds.width + config.regionPaddingX * 2,
        height: inner.bounds.height + config.regionPaddingTop + config.regionPaddingBottom,
      };
    });

    const averageWidth = namespaceCards.reduce((sum, card) => sum + card.width, 0) / namespaceCards.length;
    const averageHeight = namespaceCards.reduce((sum, card) => sum + card.height, 0) / namespaceCards.length;
    const regionColumns = Math.max(1, Math.min(namespaceCards.length, Math.ceil(Math.sqrt(
      namespaceCards.length * config.aspectRatio * averageHeight / averageWidth,
    ))));
    const rows = [];
    for (let offset = 0; offset < namespaceCards.length; offset += regionColumns) {
      rows.push(namespaceCards.slice(offset, offset + regionColumns));
    }

    const positioned = [];
    const regions = [];
    let top = 0;
    let contentWidth = 0;
    for (const row of rows) {
      const rowHeight = Math.max(...row.map(card => card.height));
      let left = 0;
      for (const card of row) {
        regions.push({
          id: `namespace:${card.name}`,
          name: card.name,
          x: left,
          y: top,
          width: card.width,
          height: card.height,
        });
        const offsetX = left + config.regionPaddingX - card.inner.bounds.x;
        const offsetY = top + config.regionPaddingTop - card.inner.bounds.y;
        for (const node of card.inner.nodes) {
          positioned.push({ ...node, x: node.x + offsetX, y: node.y + offsetY });
        }
        left += card.width + config.regionGapX;
      }
      contentWidth = Math.max(contentWidth, Math.max(0, left - config.regionGapX));
      top += rowHeight + config.regionGapY;
    }
    const contentHeight = Math.max(0, top - config.regionGapY);
    for (const node of positioned) {
      node.x -= contentWidth / 2;
      node.y -= contentHeight / 2;
    }
    for (const region of regions) {
      region.x -= contentWidth / 2;
      region.y -= contentHeight / 2;
    }
    return {
      nodes: positioned,
      regions,
      bounds: { x: -contentWidth / 2, y: -contentHeight / 2, width: contentWidth, height: contentHeight },
      columns: regionColumns,
    };
  }

  /**
   * Place one table at the origin and its direct neighbours on concentric
   * rings. Ring capacity grows with circumference so variable-sized cards do
   * not collapse into each other when a hub has many relationships.
   */
  function focusLayout(nodes, centerId, options) {
    if (nodes.length === 0) {
      return { nodes: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
    }

    const center = nodes.find(node => node.id === centerId) || nodes[0];
    const neighbours = nodes.filter(node => node.id !== center.id).sort((left, right) => compareIds(left.id, right.id));
    const maxWidth = Math.max(...nodes.map(node => node.width));
    const maxHeight = Math.max(...nodes.map(node => node.height));
    const gap = Math.max(72, options?.gap ?? 110);
    const slotSize = Math.max(maxWidth, maxHeight) + gap;
    const positioned = [{ ...center, x: 0, y: 0 }];

    let offset = 0;
    let ring = 1;
    while (offset < neighbours.length) {
      const radius = ring * slotSize;
      const capacity = Math.max(6, Math.floor((2 * Math.PI * radius) / slotSize));
      const count = Math.min(capacity, neighbours.length - offset);
      for (let index = 0; index < count; index += 1) {
        const angle = -Math.PI / 2 + (2 * Math.PI * index / count);
        positioned.push({
          ...neighbours[offset + index],
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      }
      offset += count;
      ring += 1;
    }

    const left = Math.min(...positioned.map(node => node.x - node.width / 2));
    const right = Math.max(...positioned.map(node => node.x + node.width / 2));
    const top = Math.min(...positioned.map(node => node.y - node.height / 2));
    const bottom = Math.max(...positioned.map(node => node.y + node.height / 2));
    return {
      nodes: positioned,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
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

  const api = { buildAdjacency, relationshipOrder, layout, focusLayout, zoomLevels };
  if (root) root.ViewstorErLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
