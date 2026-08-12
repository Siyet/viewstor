import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'er-diagram-panel.js');
const PANEL_PATH = path.join(__dirname, '..', 'er', 'erDiagramPanel.ts');

function readScript(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf-8');
}

describe('ER diagram hover transitions', () => {
  it('uses a fast state animation without delaying layout updates', () => {
    const script = readScript();
    const duration = script.match(/const HOVER_TRANSITION_MS = (\d+);/);

    expect(duration, 'hover transition constant not found').not.toBeNull();
    expect(Number(duration![1])).toBeGreaterThanOrEqual(100);
    expect(Number(duration![1])).toBeLessThanOrEqual(200);
    expect(script).toMatch(/animationDuration:\s*0/);
    expect(script).toMatch(/animationDurationUpdate:\s*0/);
    expect(script).toMatch(/stateAnimation:\s*\{[^}]*duration:\s*HOVER_TRANSITION_MS[^}]*easing:\s*'cubicOut'/s);
  });

  it('defines emphasis and blur styles for tables, labels, and relationships', () => {
    const script = readScript();

    expect(script).toMatch(/emphasis:\s*\{[^}]*focus:\s*'adjacency'/s);
    expect(script).toMatch(
      /blur:\s*\{[\s\S]*?itemStyle:\s*\{\s*opacity:[\s\S]*?label:\s*\{\s*opacity:[\s\S]*?lineStyle:\s*\{\s*opacity:/,
    );
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
    expect(script).toContain('chart.on(\'dblclick\', handleChartDoubleClick)');
    expect(script).toContain('ViewstorErLayout.focusLayout(cards, isolatedTableId');
    expect(script).toContain('event.button === 0 && canStartCanvasPan(event)');
    expect(script).toContain('graphView.group.x += dx');
    expect(script).toContain('event.key === \'Escape\'');
  });

  it('bridges wheel zoom over the entire canvas and synchronizes graph roam state', () => {
    const script = readScript();
    expect(script).toContain('chartEl.addEventListener(\'wheel\', zoomCanvas');
    expect(script).toContain('group.scaleX *= appliedScale');
    expect(script).toContain('type: \'graphRoam\'');
    expect(script).toContain('zoom: appliedScale');
  });

  it('renders PK, FK, and indexed column markers', () => {
    const script = readScript();
    expect(script).toContain('markers.push(\'PK\')');
    expect(script).toContain('markers.push(\'FK\')');
    expect(script).toContain('markers.push(\'IDX\')');
    expect(script).toContain('return \'fk\'');
    expect(script).toContain('return \'indexed\'');
  });

  it('removes Overview and renders the relationship toggle plus legend', () => {
    const panel = fs.readFileSync(PANEL_PATH, 'utf-8');
    expect(panel).not.toContain('id="fitBtn"');
    expect(panel).not.toContain('>Overview</vscode-button>');
    expect(panel).toContain('id="relationshipsBtn"');
    expect(panel).toContain('aria-label="ER diagram legend"');
    for (const label of ['Table', 'View', 'Relationship', 'Primary key', 'Foreign key', 'Indexed', 'Required']) {
      expect(panel).toContain(label);
    }
  });
});
