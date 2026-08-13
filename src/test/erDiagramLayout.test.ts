import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'er-diagram-layout.js');

interface LayoutNode {
  id: string;
  schema?: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}

interface LayoutLink {
  source: string;
  target: string;
}

interface LayoutApi {
  relationshipOrder(nodes: LayoutNode[], links: LayoutLink[]): LayoutNode[];
  layout(nodes: LayoutNode[], links: LayoutLink[], options?: { aspectRatio?: number }): {
    nodes: Required<LayoutNode>[];
    regions: Array<{ name: string; x: number; y: number; width: number; height: number }>;
    bounds: { x: number; y: number; width: number; height: number };
    columns: number;
  };
  focusLayout(nodes: LayoutNode[], centerId: string, options?: { gap?: number }): {
    nodes: Required<LayoutNode>[];
    bounds: { x: number; y: number; width: number; height: number };
  };
  fittedZoom(
    bounds: { width: number; height: number },
    viewport: { width: number; height: number },
    sizes: { fitWidth: number; cardWidth: number },
  ): number;
}

function loadLayout(): LayoutApi {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {} as Record<string, unknown>,
    module: { exports: {} as unknown },
    globalThis: {} as Record<string, unknown>,
    Map,
    Set,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.module.exports as LayoutApi;
}

function expectNoOverlap(nodes: Required<LayoutNode>[]) {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
    const left = nodes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
      const right = nodes[rightIndex];
      const separated = Math.abs(left.x - right.x) >= (left.width + right.width) / 2
        || Math.abs(left.y - right.y) >= (left.height + right.height) / 2;
      expect(separated, `${left.id} overlaps ${right.id}`).toBe(true);
    }
  }
}

describe('ER diagram layout', () => {
  it('lays variable-size cards out without overlap', () => {
    const api = loadLayout();
    const nodes = Array.from({ length: 306 }, (_, index) => ({
      id: `table_${index}`,
      width: 326,
      height: 68 + (index % 25) * 18,
    }));
    const links = Array.from({ length: 659 }, (_, index) => ({
      source: `table_${index % nodes.length}`,
      target: `table_${(index * 17 + 11) % nodes.length}`,
    }));

    const result = api.layout(nodes, links, { aspectRatio: 1.6 });

    expect(result.nodes).toHaveLength(306);
    expect(result.columns).toBeGreaterThan(1);
    expect(result.bounds.width).toBeGreaterThan(0);
    expect(result.bounds.height).toBeGreaterThan(0);
    expectNoOverlap(result.nodes);
  });

  it('is deterministic for the same graph', () => {
    const api = loadLayout();
    const nodes = [
      { id: 'orders', width: 300, height: 200 },
      { id: 'users', width: 320, height: 300 },
      { id: 'items', width: 310, height: 240 },
      { id: 'audit', width: 280, height: 120 },
    ];
    const links = [
      { source: 'orders', target: 'users' },
      { source: 'items', target: 'orders' },
    ];

    const first = api.layout(nodes, links);
    const second = api.layout(nodes, links);

    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });

  it('places schemas into distinct labelled regions', () => {
    const api = loadLayout();
    const nodes = [
      { id: 'public.users', schema: 'public', width: 326, height: 180 },
      { id: 'public.orders', schema: 'public', width: 326, height: 220 },
      { id: 'audit.events', schema: 'audit', width: 326, height: 260 },
      { id: 'audit.changes', schema: 'audit', width: 326, height: 140 },
    ];
    const result = api.layout(nodes, [
      { source: 'public.orders', target: 'public.users' },
      { source: 'audit.changes', target: 'audit.events' },
      { source: 'audit.events', target: 'public.users' },
    ]);

    expect(result.regions.map(region => region.name)).toEqual(['audit', 'public']);
    expectNoOverlap(result.nodes);
    for (const region of result.regions) {
      const regionNodes = result.nodes.filter(node => node.schema === region.name);
      expect(regionNodes.length).toBeGreaterThan(0);
      for (const node of regionNodes) {
        expect(node.x - node.width / 2).toBeGreaterThanOrEqual(region.x);
        expect(node.x + node.width / 2).toBeLessThanOrEqual(region.x + region.width);
        expect(node.y - node.height / 2).toBeGreaterThanOrEqual(region.y);
        expect(node.y + node.height / 2).toBeLessThanOrEqual(region.y + region.height);
      }
    }
    const [first, second] = result.regions;
    const separated = first.x + first.width <= second.x
      || second.x + second.width <= first.x
      || first.y + first.height <= second.y
      || second.y + second.height <= first.y;
    expect(separated).toBe(true);
  });

  it('keeps connected components contiguous', () => {
    const api = loadLayout();
    const nodes = ['hub', 'a', 'b', 'c', 'isolated'].map(id => ({ id, width: 100, height: 60 }));
    const links = [
      { source: 'hub', target: 'a' },
      { source: 'hub', target: 'b' },
      { source: 'hub', target: 'c' },
    ];

    expect(api.relationshipOrder(nodes, links).map(node => node.id)).toEqual(['hub', 'a', 'b', 'c', 'isolated']);
  });

  it('centres a selected table and places its neighbours around it without overlap', () => {
    const api = loadLayout();
    const nodes = Array.from({ length: 32 }, (_, index) => ({
      id: index === 0 ? 'hub' : `neighbour_${index}`,
      width: 326,
      height: 68 + (index % 12) * 18,
    }));

    const result = api.focusLayout(nodes, 'hub');
    const hub = result.nodes.find(node => node.id === 'hub');

    expect(hub).toMatchObject({ x: 0, y: 0 });
    expect(result.bounds.width).toBeGreaterThan(0);
    expect(result.bounds.height).toBeGreaterThan(0);
    expectNoOverlap(result.nodes);
  });

  it('derives a bounded initial zoom from the graph and viewport', () => {
    const api = loadLayout();
    const zoom = api.fittedZoom(
      { width: 7800, height: 9800 },
      { width: 1468, height: 1000 },
      { fitWidth: 196, cardWidth: 326 },
    );

    expect(zoom).toBeGreaterThan(1);
    expect(zoom).toBeLessThanOrEqual(12);
  });

  it('reserves enough fitted layout space for always-complete cards', () => {
    const api = loadLayout();
    const fitCardWidth = 196;
    const detailWidth = 326;
    const layoutScale = detailWidth / fitCardWidth;
    const detailHeights = [188, 296, 404, 224, 350, 170, 440, 260];
    const nodes = detailHeights.map((height, index) => ({
      id: `table_${index}`,
      width: detailWidth * layoutScale,
      height: height * layoutScale,
    }));
    const result = api.layout(nodes, [], { aspectRatio: 1.6 });
    const screenScale = fitCardWidth / detailWidth;
    const projected = result.nodes.map((node, index) => ({
      ...node,
      x: node.x * screenScale,
      y: node.y * screenScale,
      width: detailWidth,
      height: detailHeights[index],
    }));

    expectNoOverlap(projected);
  });
});
