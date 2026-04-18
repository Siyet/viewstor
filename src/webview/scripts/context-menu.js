/* eslint-disable */
/**
 * Shared context-menu primitive for Viewstor webviews (#94).
 *
 * Installs `window.ViewstorContextMenu` with two functions:
 *
 *   open({ x, y, items }) -> { close, el }
 *       x, y      viewport coordinates (usually `e.clientX` / `e.clientY`).
 *       items     array of:
 *                   { label, onClick, destructive? }  — button row
 *                   { separator: true }              — thin divider
 *
 *   close()
 *       Close the currently-open menu (no-op when none is open).
 *
 * Behavior:
 *   - At most one menu is visible; opening a new one closes the previous.
 *   - Click outside / Escape closes the menu.
 *   - Clamps to the viewport when the browser reports sizes.
 *   - Clicking a button runs `onClick()` and closes the menu.
 *
 * This module is also used by the Result Panel (inlined via `<script>`)
 * and the Diff Panel (loaded via `<script src>`) so both surfaces share
 * one implementation — the drift #94 flags between `.ctx-menu` and
 * `.diff-ctx-menu` is resolved by both pointing at this one file.
 *
 * Unit tests: src/test/contextMenu.test.ts (loaded via node:vm).
 */
(function (root) {
  'use strict';

  var activeMenu = null;

  function close() {
    if (!activeMenu) return;
    var m = activeMenu;
    activeMenu = null;
    if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    document.removeEventListener('mousedown', m.onDocMouseDown, true);
    document.removeEventListener('keydown', m.onKeyDown, true);
  }

  function appendItem(menuEl, item) {
    if (!item) return;
    if (item.separator) {
      var sep = document.createElement('div');
      sep.className = 'viewstor-ctx-menu-separator';
      menuEl.appendChild(sep);
      return;
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label || '';
    if (item.destructive) btn.classList.add('viewstor-ctx-menu-destructive');
    btn.addEventListener('click', function () {
      try {
        if (typeof item.onClick === 'function') item.onClick();
      } finally {
        close();
      }
    });
    menuEl.appendChild(btn);
  }

  function clamp(menuEl) {
    var w = typeof window !== 'undefined' ? window.innerWidth : 0;
    var h = typeof window !== 'undefined' ? window.innerHeight : 0;
    if (!w || !h || typeof menuEl.getBoundingClientRect !== 'function') return;
    var rect = menuEl.getBoundingClientRect();
    if (rect.right > w) menuEl.style.left = Math.max(0, w - rect.width - 4) + 'px';
    if (rect.bottom > h) menuEl.style.top = Math.max(0, h - rect.height - 4) + 'px';
  }

  function open(options) {
    close();
    options = options || {};
    var items = Array.isArray(options.items) ? options.items : [];
    var x = typeof options.x === 'number' ? options.x : 0;
    var y = typeof options.y === 'number' ? options.y : 0;

    var el = document.createElement('div');
    el.className = 'viewstor-ctx-menu';
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    for (var i = 0; i < items.length; i++) appendItem(el, items[i]);

    document.body.appendChild(el);

    function onDocMouseDown(e) {
      var t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('.viewstor-ctx-menu')) return;
      close();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopPropagation();
        close();
      }
    }

    // Capture phase so we see the mousedown before any panel-local handler
    // starts a drag-select on the cell underneath the menu.
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    // Register activeMenu BEFORE clamp() runs: if clamp throws on some exotic
    // layout polyfill, the next open/close still cleans up this menu.
    activeMenu = { el: el, onDocMouseDown: onDocMouseDown, onKeyDown: onKeyDown };

    clamp(el);

    return { el: el, close: close };
  }

  var api = { open: open, close: close };
  root.ViewstorContextMenu = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
