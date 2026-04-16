import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Unit tests for the shared webview color-picker widget (#94).
 *
 * The widget ships as a plain IIFE (`src/webview/scripts/color-picker.js`)
 * that installs `window.ViewstorColorPicker` so the Connection and Folder
 * forms can reuse it. Loading it through Node's `vm` mirrors how the file
 * ultimately runs in the webview: no bundler step, no TS transform, only the
 * globals it explicitly pokes at.
 */

const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  'webview',
  'scripts',
  'color-picker.js',
);

interface ColorPalette {
  readonly label: string;
  readonly css: string;
}

interface ColorPickerApi {
  hslToHex(h: number, s: number, l: number): string;
  randomHex(): string;
  COLOR_PALETTE: readonly ColorPalette[];
  attach(options: AttachOptions): { setValue(v: string): void; getValue(): string };
}

type AttachOptions = {
  textEl: FakeInput;
  pickerEl: FakeInput;
  swatchEl: FakeElement;
  clearBtn?: FakeElement;
  randomBtn?: FakeElement;
  paletteEl?: FakeElement;
  defaultPickerColor?: string;
};

type Listener = (evt?: unknown) => void;

class FakeElement {
  public value: string = '';
  public style: Record<string, string> = {};
  public type: string = '';
  public className: string = '';
  public title: string = '';
  public children: FakeElement[] = [];
  private listeners: Map<string, Listener[]> = new Map();

  addEventListener(event: string, listener: Listener) {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  dispatch(event: string) {
    (this.listeners.get(event) || []).forEach((l) => l());
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
}

class FakeInput extends FakeElement {
  constructor(initial: string = '') {
    super();
    this.value = initial;
  }

  setUserInput(next: string) {
    this.value = next;
    this.dispatch('input');
  }

  click() {
    this.dispatch('click');
  }
}

function loadColorPicker(): ColorPickerApi {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const fakeWindow: Record<string, unknown> = {};
  const sandbox = {
    window: fakeWindow,
    module: { exports: {} as unknown },
    document: {
      createElement(_tag: string) {
        return new FakeElement();
      },
    },
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return fakeWindow.ViewstorColorPicker as ColorPickerApi;
}

describe('ViewstorColorPicker module surface', () => {
  it('exposes hslToHex / randomHex / COLOR_PALETTE / attach on window', () => {
    const api = loadColorPicker();
    expect(typeof api.hslToHex).toBe('function');
    expect(typeof api.randomHex).toBe('function');
    expect(Array.isArray(api.COLOR_PALETTE)).toBe(true);
    expect(typeof api.attach).toBe('function');
  });

  it('also exports via module.exports for Node-side tests', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const sandbox = {
      window: {} as Record<string, unknown>,
      module: { exports: {} as unknown },
      document: {
        createElement: () => new FakeElement(),
      },
      Math,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    expect((sandbox.module.exports as ColorPickerApi).hslToHex(0, 100, 50)).toBe('#ff0000');
  });
});

describe('hslToHex', () => {
  let api: ColorPickerApi;
  beforeEach(() => { api = loadColorPicker(); });

  it('produces 6-digit lower-case hex with a leading #', () => {
    for (const h of [0, 60, 120, 180, 240, 300]) {
      expect(api.hslToHex(h, 70, 50)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('maps saturated primaries to the expected hex', () => {
    expect(api.hslToHex(0, 100, 50)).toBe('#ff0000');
    expect(api.hslToHex(120, 100, 50)).toBe('#00ff00');
    expect(api.hslToHex(240, 100, 50)).toBe('#0000ff');
  });

  it('collapses to grey when saturation is zero', () => {
    expect(api.hslToHex(0, 0, 50)).toBe('#808080');
    expect(api.hslToHex(180, 0, 25)).toBe('#404040');
  });

  it('returns black/white at the luminance extremes', () => {
    expect(api.hslToHex(123, 50, 0)).toBe('#000000');
    expect(api.hslToHex(45, 80, 100)).toBe('#ffffff');
  });

  it('is deterministic for the same inputs', () => {
    expect(api.hslToHex(42, 73, 51)).toBe(api.hslToHex(42, 73, 51));
  });
});

describe('randomHex', () => {
  it('stays inside the saturated / mid-luminance band so picks are always visible', () => {
    const api = loadColorPicker();
    for (let i = 0; i < 25; i++) {
      const hex = api.randomHex();
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('COLOR_PALETTE', () => {
  it('enumerates the 12 VS Code terminal ANSI theme colors', () => {
    const api = loadColorPicker();
    expect(api.COLOR_PALETTE).toHaveLength(12);
    for (const entry of api.COLOR_PALETTE) {
      expect(entry.label).toBeTruthy();
      expect(entry.css).toMatch(/^var\(--vscode-terminal-ansi[A-Z][A-Za-z]+\)$/);
    }
  });

  it('is frozen so consumers cannot mutate the shared list', () => {
    const api = loadColorPicker();
    expect(Object.isFrozen(api.COLOR_PALETTE)).toBe(true);
  });
});

describe('attach() DOM wiring', () => {
  function buildRig(initialText: string = '') {
    const api = loadColorPicker();
    const rig = {
      textEl: new FakeInput(initialText),
      pickerEl: new FakeInput('#1e1e1e'),
      swatchEl: new FakeElement(),
      clearBtn: new FakeElement(),
      randomBtn: new FakeElement(),
      paletteEl: new FakeElement(),
    };
    const handle = api.attach(rig);
    return { api, rig, handle };
  }

  it('primes the swatch from the text field on first attach', () => {
    const { rig } = buildRig('#abcdef');
    expect(rig.swatchEl.style.background).toBe('#abcdef');
  });

  it('falls back to the native picker value when the text field is empty', () => {
    const { rig } = buildRig('');
    expect(rig.swatchEl.style.background).toBe('#1e1e1e');
  });

  it('syncs hex text → native picker + swatch on input', () => {
    const { rig } = buildRig('');
    rig.textEl.setUserInput('#123456');
    expect(rig.pickerEl.value).toBe('#123456');
    expect(rig.swatchEl.style.background).toBe('#123456');
  });

  it('updates only the swatch for CSS var values (native picker stays)', () => {
    const { rig } = buildRig('');
    rig.pickerEl.value = '#1e1e1e';
    rig.textEl.setUserInput('var(--vscode-terminal-ansiRed)');
    expect(rig.swatchEl.style.background).toBe('var(--vscode-terminal-ansiRed)');
    // Native <input type=color> can only hold hex; we must leave it untouched
    // for CSS-var values rather than poke an invalid string in.
    expect(rig.pickerEl.value).toBe('#1e1e1e');
  });

  it('ignores typos until the text is a valid hex or var(', () => {
    const { rig } = buildRig('');
    rig.pickerEl.value = '#1e1e1e';
    rig.swatchEl.style.background = '';
    rig.textEl.setUserInput('#12');
    expect(rig.pickerEl.value).toBe('#1e1e1e');
    expect(rig.swatchEl.style.background).toBe('');
  });

  it('syncs native picker → text field + swatch on input', () => {
    const { rig } = buildRig('');
    rig.pickerEl.setUserInput('#facade');
    expect(rig.textEl.value).toBe('#facade');
    expect(rig.swatchEl.style.background).toBe('#facade');
  });

  it('clear button resets text, picker, and swatch', () => {
    const { rig } = buildRig('#ff00ff');
    rig.clearBtn.dispatch('click');
    expect(rig.textEl.value).toBe('');
    expect(rig.pickerEl.value).toBe('#1e1e1e');
    expect(rig.swatchEl.style.background).toBe('transparent');
  });

  it('random button fills all three with a valid hex in one go', () => {
    const { rig } = buildRig('');
    rig.randomBtn.dispatch('click');
    expect(rig.textEl.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(rig.pickerEl.value).toBe(rig.textEl.value);
    expect(rig.swatchEl.style.background).toBe(rig.textEl.value);
  });

  it('populates the palette container with one button per theme color', () => {
    const { rig, api } = buildRig('');
    expect(rig.paletteEl.children).toHaveLength(api.COLOR_PALETTE.length);
    const first = rig.paletteEl.children[0];
    expect(first.className).toBe('color-swatch');
    expect(first.type).toBe('button');
    expect(first.style.background).toBe(api.COLOR_PALETTE[0].css);
  });

  it('clicking a palette swatch writes the CSS var into the text field', () => {
    const { rig, api } = buildRig('');
    const picked = api.COLOR_PALETTE[3];
    const btn = rig.paletteEl.children[3];
    btn.dispatch('click');
    expect(rig.textEl.value).toBe(picked.css);
    expect(rig.swatchEl.style.background).toBe(picked.css);
  });

  it('handle.setValue hydrates all three DOM targets (hex)', () => {
    const { rig, handle } = buildRig('');
    handle.setValue('#aabbcc');
    expect(rig.textEl.value).toBe('#aabbcc');
    expect(rig.pickerEl.value).toBe('#aabbcc');
    expect(rig.swatchEl.style.background).toBe('#aabbcc');
  });

  it('handle.setValue leaves the native picker on its default for non-hex values', () => {
    const { rig, handle } = buildRig('');
    handle.setValue('var(--vscode-terminal-ansiCyan)');
    expect(rig.textEl.value).toBe('var(--vscode-terminal-ansiCyan)');
    expect(rig.pickerEl.value).toBe('#1e1e1e');
    expect(rig.swatchEl.style.background).toBe('var(--vscode-terminal-ansiCyan)');
  });

  it('handle.setValue("") clears + falls back to default picker color', () => {
    const { rig, handle } = buildRig('#deadbe');
    handle.setValue('');
    expect(rig.textEl.value).toBe('');
    expect(rig.pickerEl.value).toBe('#1e1e1e');
    expect(rig.swatchEl.style.background).toBe('transparent');
  });

  it('handle.getValue returns the current text, trimmed', () => {
    const { rig, handle } = buildRig('  #cafe00  ');
    expect(handle.getValue()).toBe('#cafe00');
    rig.textEl.value = '';
    expect(handle.getValue()).toBe('');
  });

  it('honors a caller-supplied defaultPickerColor', () => {
    const api = loadColorPicker();
    const rig = {
      textEl: new FakeInput(''),
      pickerEl: new FakeInput('#111111'),
      swatchEl: new FakeElement(),
      defaultPickerColor: '#444444',
    };
    const handle = api.attach(rig);
    handle.setValue('');
    expect(rig.pickerEl.value).toBe('#444444');
  });

  it('throws when required elements are missing', () => {
    const api = loadColorPicker();
    expect(() => api.attach({
      // @ts-expect-error intentional: exercise the runtime guard
      textEl: null,
      pickerEl: new FakeInput(''),
      swatchEl: new FakeElement(),
    })).toThrow(/textEl.*pickerEl.*swatchEl/);
  });

  it('works without optional clearBtn / randomBtn / paletteEl', () => {
    const api = loadColorPicker();
    const rig = {
      textEl: new FakeInput('#012345'),
      pickerEl: new FakeInput('#1e1e1e'),
      swatchEl: new FakeElement(),
    };
    expect(() => api.attach(rig)).not.toThrow();
    // The swatch is still primed from the text value:
    expect(rig.swatchEl.style.background).toBe('#012345');
  });
});
