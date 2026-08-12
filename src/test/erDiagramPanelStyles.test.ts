import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'er-diagram-panel.js');
const PANEL_PATH = path.join(__dirname, '..', 'er', 'erDiagramPanel.ts');

function readScript(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf-8');
}

describe('ER diagram transitions', () => {
  it('uses fast hover and semantic card animations', () => {
    const script = readScript();
    const duration = script.match(/const HOVER_TRANSITION_MS = (\d+);/);
    const semanticDuration = script.match(/const SEMANTIC_TRANSITION_MS = (\d+);/);

    expect(duration, 'hover transition constant not found').not.toBeNull();
    expect(Number(duration![1])).toBeGreaterThanOrEqual(100);
    expect(Number(duration![1])).toBeLessThanOrEqual(200);
    expect(semanticDuration, 'semantic transition constant not found').not.toBeNull();
    expect(Number(semanticDuration![1])).toBeGreaterThanOrEqual(100);
    expect(Number(semanticDuration![1])).toBeLessThanOrEqual(200);
    expect(script).toMatch(/animationDuration:\s*0/);
    expect(script).toMatch(/animationDurationUpdate:\s*SEMANTIC_TRANSITION_MS/);
    expect(script).toMatch(/animationEasingUpdate:\s*'cubicOut'/);
    expect(script).toMatch(/stateAnimation:\s*\{[^}]*duration:\s*HOVER_TRANSITION_MS[^}]*easing:\s*'cubicOut'/s);
  });

  it('switches LOD only at hysteretic thresholds and scales each card as one local group', () => {
    const script = readScript();
    expect(script).toContain('detailZoom * DETAIL_ENTER_RATIO');
    expect(script).toContain('detailZoom * DETAIL_EXIT_RATIO');
    expect(script).toContain('if (!force && !modeChanged)');
    expect(script).toContain('new echarts.graphic.Group');
    expect(script).toContain('new echarts.graphic.Rect');
    expect(script).toContain('new echarts.graphic.Text');
    expect(script).toContain('graphView.group.add(cardLayer)');
    expect(script).toContain('scaleX: cardScaleX');
    expect(script).toContain('graphView.group.scaleX');
    expect(script).toContain('nodeScaleRatio: 1');
    expect(script).toContain('culling: true');
    expect(script).toContain('function rebaseCardLayer()');
    expect(script).toContain('window.addEventListener(\'resize\', resizeChart)');
    expect(script).toContain('cardTextStyleCache.has(cacheKey)');
    expect(script).toContain('const DETAIL_REVEAL_RATIO = 1.48');
    expect(script).toContain('overviewZoom * DETAIL_REVEAL_RATIO');
    expect(script).not.toContain('visualScale');
    expect(script).not.toContain('detailProgress');
  });

  it('reveals detail text after the card opening transition', () => {
    const script = readScript();
    expect(script).toContain('const enteringDetails = nextMode === \'details\'');
    expect(script).toContain('showingDetails = nextMode === \'details\' && !enteringDetails');
    expect(script).toContain('semanticTransitionTimer = window.setTimeout');
    expect(script).toContain('}, SEMANTIC_TRANSITION_MS)');
  });

  it('fades custom cards and native relationships with fast state animations', () => {
    const script = readScript();

    expect(script).toMatch(/emphasis:\s*\{[^}]*focus:\s*'adjacency'/s);
    expect(script).toContain('animateCardOpacity(record, ids.has(record.node.id) ? 1 : 0.18)');
    expect(script).toMatch(/blur:\s*\{[\s\S]*?lineStyle:\s*\{\s*opacity:/);
  });
});

describe('ER diagram interactions', () => {
  it('uses a three-second delayed full-table preview', () => {
    const script = readScript();
    expect(script).toMatch(/const TABLE_PREVIEW_DELAY_MS = 3000;/);
    expect(script).toContain('showTablePreviewTooltip(table, point)');
    expect(script).toContain('allColumns: entity.columns');
  });

  it('supports relationship visibility, focused graphs, and blank-canvas primary pan', () => {
    const script = readScript();
    expect(script).toContain('links: relationshipsVisible ? links : []');
    expect(script).toContain('group.on(\'dblclick\'');
    expect(script).toContain('ViewstorErLayout.focusLayout(cards, isolatedTableId');
    expect(script).toContain('x: node.x');
    expect(script).toContain('new echarts.graphic.Group({ name: \'viewstor-er-regions\'');
    expect(script).toContain('regions = isolatedTableId ? []');
    expect(script).toContain('event.button === 0 && canStartCanvasPan(event)');
    expect(script).toContain('graphView.group.x += dx');
    expect(script).toContain('event.key === \'Escape\'');
  });

  it('bridges wheel zoom over the entire canvas and synchronizes graph roam state', () => {
    const script = readScript();
    expect(script).toContain('chartEl.addEventListener(\'wheel\', zoomCanvas');
    expect(script).toContain('graphView._controller.trigger(\'zoom\'');
    expect(script).toContain('type: \'graphRoam\'');
    expect(script).toContain('zoom: appliedScale');
    expect(script).toContain('window.requestAnimationFrame(animateCanvasZoom)');
    expect(script).toContain('Math.pow(0.5, elapsed / ZOOM_HALF_LIFE_MS)');
  });

  it('keeps steady zoom free of card style patches and graph data rebuilds', () => {
    const script = readScript();
    const visualPatch = script.slice(
      script.indexOf('function semanticVisualPatch()'),
      script.indexOf('function modeForZoom'),
    );
    expect(visualPatch).not.toMatch(/\bdata:/);
    expect(visualPatch).not.toMatch(/\blinks:/);
    const semanticUpdate = script.slice(
      script.indexOf('function updateSemanticDisplay'),
      script.indexOf('function removeCardLayer'),
    );
    expect(semanticUpdate).toContain('if (!force && !modeChanged)');
    expect(semanticUpdate).not.toContain('scaleChanged');
  });

  it('renders PK, FK, and indexed column markers', () => {
    const script = readScript();
    expect(script).toContain('markers.push(\'PK\')');
    expect(script).toContain('markers.push(\'FK\')');
    expect(script).toContain('markers.push(\'IDX\')');
    expect(script).toContain('return \'fk\'');
    expect(script).toContain('return \'indexed\'');
    expect(script).toContain('const ROLE_COLOR_ALPHA = 0.78');
  });

  it('removes Overview and renders the relationship toggle plus legend', () => {
    const panel = fs.readFileSync(PANEL_PATH, 'utf-8');
    expect(panel).not.toContain('id="fitBtn"');
    expect(panel).not.toContain('>Overview</vscode-button>');
    expect(panel).toContain('id="relationshipsBtn"');
    expect(panel).toContain('aria-label="ER diagram legend"');
    for (const label of ['Table', 'View', 'Schema / database', 'Relationship', 'Primary key', 'Foreign key', 'Indexed', 'Required']) {
      expect(panel).toContain(label);
    }
  });
});
