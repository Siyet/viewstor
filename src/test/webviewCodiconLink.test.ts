import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression guard: every panel that embeds @vscode-elements web components must
 * declare the codicon stylesheet with `id="vscode-codicon-stylesheet"`.
 *
 * `<vscode-icon>` (including the icon rendered inside `<vscode-button icon="...">`)
 * looks up that exact element id in the light DOM to forward the href into its own
 * shadow DOM — without the id the icons render as empty boxes even though the CSS
 * link itself is present. This silently broke the "+ Source" button and every
 * × close button in the Chart panel (#88).
 */

const ROOT = path.join(__dirname, '..');
const PANEL_FILES = [
  'chart/chartPanel.ts',
  'diff/diffPanel.ts',
  'views/connectionForm.ts',
  'views/folderForm.ts',
];

const CODICON_LINK_RE = /<link\b[^>]*codiconUri[^>]*>/i;

function readPanel(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

describe('webview codicon stylesheet id', () => {
  for (const relPath of PANEL_FILES) {
    it(`${relPath} tags the codicon <link> with id="vscode-codicon-stylesheet"`, () => {
      const source = readPanel(relPath);
      const match = source.match(CODICON_LINK_RE);
      expect(match, `codicon <link> not found in ${relPath}`).not.toBeNull();
      // The id must appear on the same tag as codiconUri — otherwise <vscode-icon> fails to resolve the href
      expect(match![0]).toContain('id="vscode-codicon-stylesheet"');
    });
  }
});

describe('chart panel icon buttons', () => {
  // Regression guard for #88: the "+ Source", refresh, close-×, and Grafana footer buttons
  // must use the `icon="..."` attribute on <vscode-button>. Nesting a raw <vscode-icon> as a
  // child of <vscode-button> does NOT render because the codicon stylesheet lookup happens
  // inside the icon's shadow DOM.
  const chartTs = readPanel('chart/chartPanel.ts');

  const iconButtons = [
    { id: 'refreshBtn', icon: 'refresh' },
    { id: 'addDataSourceBtn', icon: 'add' },
    { id: 'closePinnedPicker', icon: 'close' },
    { id: 'closeDsConfig', icon: 'close' },
    { id: 'closePopup', icon: 'close' },
    { id: 'copyJsonBtn', icon: 'copy' },
    { id: 'saveJsonBtn', icon: 'save' },
    { id: 'pushGrafanaBtn', icon: 'cloud-upload' },
  ];

  for (const { id, icon } of iconButtons) {
    it(`#${id} carries icon="${icon}"`, () => {
      const re = new RegExp(`<vscode-button\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
      const m = chartTs.match(re);
      expect(m, `<vscode-button id="${id}"> not found in chart/chartPanel.ts`).not.toBeNull();
      expect(m![0]).toMatch(new RegExp(`\\bicon=["']${icon}["']`));
    });
  }

  it('ds-remove-btn (rendered in chart-panel.js) carries icon="close"', () => {
    const js = fs.readFileSync(path.join(ROOT, 'webview/scripts/chart-panel.js'), 'utf-8');
    const m = js.match(/vscode-button[^'"<]*class=["']ds-remove-btn["'][^<]*/);
    expect(m, 'ds-remove-btn <vscode-button> markup not found').not.toBeNull();
    expect(m![0]).toMatch(/icon=["']close["']/);
  });
});
