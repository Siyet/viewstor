/* eslint-disable */
/**
 * Shared color-picker widget used by the Connection form and Folder form
 * webviews. Installs `window.ViewstorColorPicker` with:
 *
 *   - hslToHex(h, s, l)            pure helper, h in [0,360), s/l in [0,100]
 *   - normalizeHex(v)              expand "#abc" → "#aabbcc", pass-through "#abcdef", null otherwise
 *   - COLOR_PALETTE                static list of VS Code theme-color swatches
 *   - attach({                     wire DOM handlers onto an existing color-row
 *       textEl,                    vscode-textfield storing the raw value (hex | css var | "")
 *       pickerEl,                  native <input type="color">
 *       swatchEl,                  <span> whose background previews the current color
 *       clearBtn,                  button that resets the value to ""
 *       randomBtn,                 button that picks a random hex
 *       paletteEl,                 container populated with per-swatch buttons
 *       defaultPickerColor = '#1e1e1e',
 *     }) => { setValue(v), getValue() }
 *
 * The attach() return value lets callers programmatically set the value
 * (e.g. when hydrating a form from a stored connection/folder) without
 * re-implementing the swatch-update logic.
 *
 * Unit tests: src/test/colorPicker.test.ts (loaded via node:vm).
 */
(function (root) {
  'use strict';

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    function f(n) {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    }
    return '#' + f(0) + f(8) + f(4);
  }

  function randomHex() {
    const h = Math.floor(Math.random() * 360);
    const s = 60 + Math.floor(Math.random() * 30);
    const l = 45 + Math.floor(Math.random() * 20);
    return hslToHex(h, s, l);
  }

  const HEX_LONG_RE = /^#[0-9a-fA-F]{6}$/;
  const HEX_SHORT_RE = /^#[0-9a-fA-F]{3}$/;

  // Native <input type="color"> only accepts 7-char #rrggbb. Expand #rgb → #rrggbb.
  function normalizeHex(v) {
    if (HEX_LONG_RE.test(v)) return v;
    if (HEX_SHORT_RE.test(v)) return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    return null;
  }

  const COLOR_PALETTE = Object.freeze([
    { label: 'Red', css: 'var(--vscode-terminal-ansiRed)' },
    { label: 'Green', css: 'var(--vscode-terminal-ansiGreen)' },
    { label: 'Yellow', css: 'var(--vscode-terminal-ansiYellow)' },
    { label: 'Blue', css: 'var(--vscode-terminal-ansiBlue)' },
    { label: 'Magenta', css: 'var(--vscode-terminal-ansiMagenta)' },
    { label: 'Cyan', css: 'var(--vscode-terminal-ansiCyan)' },
    { label: 'Bright Red', css: 'var(--vscode-terminal-ansiBrightRed)' },
    { label: 'Bright Green', css: 'var(--vscode-terminal-ansiBrightGreen)' },
    { label: 'Bright Yellow', css: 'var(--vscode-terminal-ansiBrightYellow)' },
    { label: 'Bright Blue', css: 'var(--vscode-terminal-ansiBrightBlue)' },
    { label: 'Bright Magenta', css: 'var(--vscode-terminal-ansiBrightMagenta)' },
    { label: 'Bright Cyan', css: 'var(--vscode-terminal-ansiBrightCyan)' },
  ]);

  const ATTACHED_FLAG = '__viewstorColorPickerAttached';

  function attach(options) {
    const textEl = options.textEl;
    const pickerEl = options.pickerEl;
    const swatchEl = options.swatchEl;
    const clearBtn = options.clearBtn;
    const randomBtn = options.randomBtn;
    const paletteEl = options.paletteEl;
    const defaultPickerColor = options.defaultPickerColor != null && options.defaultPickerColor !== ''
      ? options.defaultPickerColor
      : '#1e1e1e';

    if (!textEl || !pickerEl || !swatchEl) {
      throw new Error('ViewstorColorPicker.attach: textEl, pickerEl and swatchEl are required');
    }

    // Guard against double-attach on the same DOM. Re-running would duplicate
    // listeners and the palette, leading to double-fired handlers and a 24-swatch grid.
    if (textEl[ATTACHED_FLAG]) {
      throw new Error('ViewstorColorPicker.attach: textEl is already attached');
    }
    textEl[ATTACHED_FLAG] = true;

    function setSwatch(color) {
      swatchEl.style.background = color || 'transparent';
    }

    function setValue(color) {
      const v = color || '';
      const hex = normalizeHex(v);
      textEl.value = v;
      pickerEl.value = hex || defaultPickerColor;
      setSwatch(v);
    }

    function getValue() {
      return String(textEl.value || '').trim();
    }

    pickerEl.addEventListener('input', function () {
      textEl.value = pickerEl.value;
      setSwatch(pickerEl.value);
    });

    textEl.addEventListener('input', function () {
      const v = String(textEl.value || '');
      const hex = normalizeHex(v);
      if (hex) {
        pickerEl.value = hex;
        setSwatch(v);
      } else if (v.startsWith('var(')) {
        setSwatch(v);
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        textEl.value = '';
        pickerEl.value = defaultPickerColor;
        setSwatch('');
      });
    }

    if (randomBtn) {
      randomBtn.addEventListener('click', function () {
        const hex = randomHex();
        textEl.value = hex;
        pickerEl.value = hex;
        setSwatch(hex);
      });
    }

    if (paletteEl) {
      COLOR_PALETTE.forEach(function (tc) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'color-swatch';
        swatch.title = tc.label;
        swatch.style.background = tc.css;
        swatch.addEventListener('click', function () {
          textEl.value = tc.css;
          setSwatch(tc.css);
        });
        paletteEl.appendChild(swatch);
      });
    }

    // Prime swatch from whatever the form is already carrying.
    setSwatch(textEl.value || pickerEl.value);

    return { setValue: setValue, getValue: getValue };
  }

  const api = {
    hslToHex: hslToHex,
    randomHex: randomHex,
    normalizeHex: normalizeHex,
    COLOR_PALETTE: COLOR_PALETTE,
    attach: attach,
  };

  root.ViewstorColorPicker = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
