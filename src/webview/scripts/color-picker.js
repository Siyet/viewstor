/* eslint-disable */
/**
 * Shared color-picker initialization for connection-form and folder-form webviews.
 *
 * Wires up:
 *   - A native <input type="color"> behind a swatch preview
 *   - A free-form text input that accepts #hex or var(--vscode-...)
 *   - Clear and Random buttons
 *   - A palette of VS Code terminal ANSI colors
 *
 * Exposes window.__viewstorColorPicker.init(opts) returning { setSwatch }.
 */
(function () {
  const themeColors = [
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
  ];

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    function f(n) {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    }
    return '#' + f(0) + f(8) + f(4);
  }

  function init(opts) {
    const $ = (id) => document.getElementById(id);
    const required = ['colorInputId', 'colorPickerId', 'swatchFillId', 'clearBtnId', 'randomBtnId', 'paletteId'];
    const missing = [];
    const els = {};
    for (const key of required) {
      const id = opts[key];
      const el = id && $(id);
      if (!el) missing.push(`${key}=${id ?? '(undefined)'}`);
      els[key] = el;
    }
    if (missing.length > 0) {
      throw new Error('color-picker.init: missing DOM element(s): ' + missing.join(', '));
    }
    const colorInput = els.colorInputId;
    const colorPicker = els.colorPickerId;
    const swatchFill = els.swatchFillId;
    const clearBtn = els.clearBtnId;
    const randomBtn = els.randomBtnId;
    const palette = els.paletteId;

    function setSwatch(color) {
      swatchFill.style.background = color || 'transparent';
    }

    colorPicker.addEventListener('input', function () {
      colorInput.value = colorPicker.value;
      setSwatch(colorPicker.value);
    });

    colorInput.addEventListener('input', function () {
      const v = colorInput.value;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        colorPicker.value = v;
        setSwatch(v);
      } else if (v.startsWith('var(')) {
        setSwatch(v);
      }
    });

    clearBtn.addEventListener('click', function () {
      colorInput.value = '';
      colorPicker.value = '#1e1e1e';
      setSwatch('');
    });

    randomBtn.addEventListener('click', function () {
      const h = Math.floor(Math.random() * 360);
      const s = 60 + Math.floor(Math.random() * 30);
      const l = 45 + Math.floor(Math.random() * 20);
      const hex = hslToHex(h, s, l);
      colorInput.value = hex;
      colorPicker.value = hex;
      setSwatch(hex);
    });

    themeColors.forEach(function (tc) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'color-swatch';
      swatch.title = tc.label;
      swatch.style.background = tc.css;
      swatch.addEventListener('click', function () {
        colorInput.value = tc.css;
        setSwatch(tc.css);
      });
      palette.appendChild(swatch);
    });

    setSwatch(colorInput.value || colorPicker.value);

    return { setSwatch };
  }

  window.__viewstorColorPicker = { init };
})();
