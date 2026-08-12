import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'er-diagram-panel.js');

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
