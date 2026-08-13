import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'er-diagram-panel.js');
const PANEL_PATH = path.join(__dirname, '..', 'er', 'erDiagramPanel.ts');

function readScript(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf-8');
}

describe('ER diagram transitions', () => {
  it('uses fast hover animations without semantic card transitions', () => {
    const script = readScript();
    const duration = script.match(/const HOVER_TRANSITION_MS = (\d+);/);

    expect(duration, 'hover transition constant not found').not.toBeNull();
    expect(Number(duration![1])).toBeGreaterThanOrEqual(100);
    expect(Number(duration![1])).toBeLessThanOrEqual(200);
    expect(script).toMatch(/animationDuration:\s*0/);
    expect(script).toMatch(/animationDurationUpdate:\s*0/);
    expect(script).toMatch(/animationEasingUpdate:\s*'cubicOut'/);
    expect(script).toMatch(/stateAnimation:\s*\{[^}]*duration:\s*HOVER_TRANSITION_MS[^}]*easing:\s*'cubicOut'/s);
    expect(script).not.toContain('SEMANTIC_TRANSITION_MS');
  });

  it('always renders complete cards as one local group', () => {
    const script = readScript();
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
    expect(script).toContain('cardTextStyleCache.has(\'details\')');
    expect(script).toContain('const CARD_LAYOUT_SCALE = DETAIL_WIDTH / FIT_CARD_WIDTH');
    expect(script).toContain('width: card.width * CARD_LAYOUT_SCALE');
    expect(script).toContain('height: card.height * CARD_LAYOUT_SCALE');
    expect(script).toContain('ViewstorErLayout.layout(layoutCards, links');
    expect(script).toContain('text: node.detailLabelText');
    expect(script).not.toContain('semanticMode');
    expect(script).not.toContain('overviewLabelText');
    expect(script).not.toContain('MAX_CARD_COLUMNS');
    expect(script).not.toContain('more columns');
  });

  it('fades custom cards and native relationships with fast state animations', () => {
    const script = readScript();

    expect(script).toMatch(/emphasis:\s*\{[^}]*focus:\s*'adjacency'/s);
    expect(script).toContain('animateCardOpacity(record, ids.has(record.node.id) ? 1 : 0.18)');
    expect(script).toMatch(/blur:\s*\{[\s\S]*?lineStyle:\s*\{\s*opacity:/);
  });

  it('uses one readable relationship style at every zoom', () => {
    const script = readScript();
    expect(script).toMatch(/lineStyle:\s*\{[^}]*opacity:\s*0\.35[^}]*width:\s*1\.4/s);
  });

  it('keeps cards above relationships on the first focused-graph frame', () => {
    const script = readScript();
    expect(script).toContain('const CARD_Z = 100');
    expect(script).toContain('const CARD_FRAME_Z = 200');
    expect(script).toContain('const CARD_TEXT_Z = 201');
    expect(script).toMatch(/new echarts\.graphic\.Rect\(\{\s*z: CARD_Z,\s*z2: CARD_FRAME_Z,/);
    expect(script).toMatch(/new echarts\.graphic\.Text\(\{\s*z: CARD_Z,\s*z2: CARD_TEXT_Z,/);
  });

  it('enables relationship arrows and hover only from 3x zoom', () => {
    const script = readScript();
    expect(script).toContain('const ARROW_ZOOM_THRESHOLD = 3');
    expect(script).toContain('const nextVisible = currentZoom >= ARROW_ZOOM_THRESHOLD');
    expect(script).toContain('edgeSymbol: [\'none\', arrowsVisible ? \'arrow\' : \'none\']');
    expect(script).toContain('edgeSymbolSize: [0, arrowsVisible ? 8 : 0]');
    expect(script).toMatch(/links = links\.map\(link => \(\{\s*\.\.\.link,\s*emphasis: \{ disabled: !arrowsVisible \}/);
    expect(script).toMatch(/if \(params\.dataType === 'edge'\) \{\s*if \(!arrowsVisible\)/);
    expect(script).toContain('activeFocusKey.startsWith(\'edge\\u0001\')');
  });
});

describe('ER diagram interactions', () => {
  it('supports relationship visibility, focused graphs, and blank-canvas primary pan', () => {
    const script = readScript();
    expect(script).toContain('links: relationshipsVisible ? links : []');
    expect(script).toContain('group.on(\'dblclick\'');
    expect(script).toContain('ViewstorErLayout.focusLayout(layoutCards, isolatedTableId');
    expect(script).toContain('x: node.x');
    expect(script).toContain('new echarts.graphic.Group({ name: \'viewstor-er-regions\'');
    expect(script).toContain('regions = isolatedTableId ? []');
    expect(script).toContain('event.button === 0 && canStartCanvasPan(event)');
    expect(script).toContain('graphView.group.x += dx');
    expect(script).toContain('event.key === \'Escape\'');
    expect(script).toContain('chart.getZr().on(\'dblclick\', handleCanvasDoubleClick)');
    expect(script).toContain('if (!isolatedTableId || event.target) return;');
    expect(script).toContain('exitFocusedGraph();');
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
      script.indexOf('function graphVisuals()'),
      script.indexOf('function removeCardLayer'),
    );
    expect(visualPatch).not.toMatch(/\bdata:/);
    expect(visualPatch).not.toMatch(/\blinks:/);
    const roamHandler = script.slice(
      script.indexOf('chart.on(\'graphRoam\''),
      script.indexOf('chart.on(\'mousemove\''),
    );
    expect(roamHandler).not.toContain('setOption');
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

  it('uses concise object and namespace labels', () => {
    const script = readScript();
    expect(script).toContain('const title = entity.name;');
    expect(script).toContain('fontSize: scaled(12, textScale)');
    expect(script).toContain('text: region.name');
    expect(script).not.toContain('`${kind} · ${region.name}`');
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
