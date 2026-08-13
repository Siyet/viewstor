import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Unit tests for the shared webview context-menu primitive (#94).
 *
 * The module ships as a plain IIFE (`src/webview/scripts/context-menu.js`)
 * that installs `window.ViewstorContextMenu`. Loading it through Node's
 * `vm` mirrors how it ultimately runs in the webview: no bundler step, no
 * TS transform, only the globals it explicitly pokes at. The Diff Panel
 * loads it via `<script src>`; the Result Panel inlines the same source
 * via `fs.readFileSync` at build time — both surfaces share this one
 * file, which is the point of the extraction.
 */

const SCRIPT_PATH = path.join(__dirname, '..', 'webview', 'scripts', 'context-menu.js');
const CSS_PATH = path.join(__dirname, '..', 'webview', 'styles', 'context-menu.css');

type Listener = (evt?: unknown) => void;

interface ContextMenuItem {
  label?: string;
  onClick?: () => void;
  destructive?: boolean;
  separator?: boolean;
}

interface ContextMenuApi {
  open(options: { x: number; y: number; items: ContextMenuItem[] }): { el: FakeElement; close(): void };
  close(): void;
}

class FakeElement {
  public tagName: string;
  public className: string = '';
  public textContent: string = '';
  public type: string = '';
  public style: Record<string, string> = {};
  public children: FakeElement[] = [];
  public parentNode: FakeElement | null = null;
  public classList: {
    add: (c: string) => void;
    contains: (c: string) => boolean;
  };
  private listeners: Map<string, Listener[]> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName;
    this.classList = {
      add: (c: string) => {
        this.className = (this.className ? this.className + ' ' : '') + c;
      },
      contains: (c: string) => this.className.split(/\s+/).includes(c),
    };
  }

  addEventListener(event: string, listener: Listener) {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  removeChild(child: FakeElement) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  dispatch(event: string, payload: Record<string, unknown> = {}) {
    (this.listeners.get(event) || []).forEach((l) => l(payload));
  }

  getBoundingClientRect() {
    // Default: zero-size, sitting at the style.left / style.top. Tests that
    // care about clamping override this via replacing the method on the node
    // the module returns.
    const left = parseInt(this.style.left || '0', 10);
    const top = parseInt(this.style.top || '0', 10);
    return { left, top, right: left, bottom: top, width: 0, height: 0 };
  }

  closest(selector: string): FakeElement | null {
    // Strip the leading `.` for a className check.
    const cls = selector.replace(/^\./, '');
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.classList.contains(cls)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

interface Loaded {
  api: ContextMenuApi;
  body: FakeElement;
  docListeners: Map<string, Listener[]>;
  fireDoc(event: string, payload?: Record<string, unknown>): void;
  window: { innerWidth: number; innerHeight: number };
  sandbox: Record<string, unknown>;
}

function load(): Loaded {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const body = new FakeElement('body');
  const docListeners = new Map<string, Listener[]>();
  const fakeWindow: { innerWidth: number; innerHeight: number } = { innerWidth: 800, innerHeight: 600 };

  const document = {
    body,
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (event: string, listener: Listener) => {
      const list = docListeners.get(event) || [];
      list.push(listener);
      docListeners.set(event, list);
    },
    removeEventListener: (event: string, listener: Listener) => {
      const list = docListeners.get(event) || [];
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
      docListeners.set(event, list);
    },
  };

  const sandbox: Record<string, unknown> = {
    window: fakeWindow,
    document,
    module: { exports: {} as unknown },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = (sandbox.window as { ViewstorContextMenu: ContextMenuApi }).ViewstorContextMenu;

  function fireDoc(event: string, payload: Record<string, unknown> = {}) {
    (docListeners.get(event) || []).slice().forEach((l) => l(payload));
  }

  return { api, body, docListeners, fireDoc, window: fakeWindow, sandbox };
}

describe('ViewstorContextMenu module surface', () => {
  it('exposes open + close on window', () => {
    const { api } = load();
    expect(typeof api.open).toBe('function');
    expect(typeof api.close).toBe('function');
  });

  it('also exports via module.exports for Node-side tests', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const body = new FakeElement('body');
    const sandbox = {
      window: { innerWidth: 0, innerHeight: 0 },
      module: { exports: {} as unknown },
      document: {
        body,
        createElement: (tag: string) => new FakeElement(tag),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    expect(typeof (sandbox.module.exports as ContextMenuApi).open).toBe('function');
  });
});

describe('open() DOM wiring', () => {
  let ctx: Loaded;
  beforeEach(() => { ctx = load(); });

  it('appends a .viewstor-ctx-menu div to document.body at (x, y)', () => {
    ctx.api.open({ x: 123, y: 456, items: [{ label: 'One', onClick: () => {} }] });
    expect(ctx.body.children).toHaveLength(1);
    const menu = ctx.body.children[0];
    expect(menu.className).toBe('viewstor-ctx-menu');
    expect(menu.style.left).toBe('123px');
    expect(menu.style.top).toBe('456px');
  });

  it('renders each item as a <button> with its label', () => {
    ctx.api.open({ x: 0, y: 0, items: [
      { label: 'Alpha', onClick: () => {} },
      { label: 'Beta', onClick: () => {} },
    ] });
    const menu = ctx.body.children[0];
    expect(menu.children).toHaveLength(2);
    expect(menu.children[0].tagName).toBe('button');
    expect(menu.children[0].type).toBe('button');
    expect(menu.children[0].textContent).toBe('Alpha');
    expect(menu.children[1].textContent).toBe('Beta');
  });

  it('renders separators as .viewstor-ctx-menu-separator divs', () => {
    ctx.api.open({ x: 0, y: 0, items: [
      { label: 'Copy', onClick: () => {} },
      { separator: true },
      { label: 'Delete', onClick: () => {}, destructive: true },
    ] });
    const menu = ctx.body.children[0];
    expect(menu.children).toHaveLength(3);
    expect(menu.children[1].tagName).toBe('div');
    expect(menu.children[1].className).toBe('viewstor-ctx-menu-separator');
  });

  it('applies .viewstor-ctx-menu-destructive to destructive items only', () => {
    ctx.api.open({ x: 0, y: 0, items: [
      { label: 'Copy', onClick: () => {} },
      { label: 'Delete', onClick: () => {}, destructive: true },
    ] });
    const menu = ctx.body.children[0];
    expect(menu.children[0].className).toBe('');
    expect(menu.children[1].classList.contains('viewstor-ctx-menu-destructive')).toBe(true);
  });

  it('clicking a button runs its onClick and closes the menu', () => {
    const calls: string[] = [];
    ctx.api.open({ x: 0, y: 0, items: [
      { label: 'A', onClick: () => calls.push('A') },
      { label: 'B', onClick: () => calls.push('B') },
    ] });
    const menu = ctx.body.children[0];
    menu.children[1].dispatch('click');
    expect(calls).toEqual(['B']);
    // Menu is gone
    expect(ctx.body.children).toHaveLength(0);
  });

  it('close() removes the menu and tolerates being called with nothing open', () => {
    ctx.api.open({ x: 0, y: 0, items: [{ label: 'A', onClick: () => {} }] });
    expect(ctx.body.children).toHaveLength(1);
    ctx.api.close();
    expect(ctx.body.children).toHaveLength(0);
    // Second close is a no-op, no exception.
    expect(() => ctx.api.close()).not.toThrow();
  });

  it('opening a second menu closes the first one', () => {
    ctx.api.open({ x: 10, y: 10, items: [{ label: 'First', onClick: () => {} }] });
    ctx.api.open({ x: 20, y: 20, items: [{ label: 'Second', onClick: () => {} }] });
    expect(ctx.body.children).toHaveLength(1);
    expect(ctx.body.children[0].children[0].textContent).toBe('Second');
  });

  it('Escape on the document closes the menu', () => {
    ctx.api.open({ x: 0, y: 0, items: [{ label: 'A', onClick: () => {} }] });
    expect(ctx.body.children).toHaveLength(1);
    ctx.fireDoc('keydown', { key: 'Escape', stopPropagation: () => {} });
    expect(ctx.body.children).toHaveLength(0);
  });

  it('mousedown outside the menu closes it', () => {
    ctx.api.open({ x: 0, y: 0, items: [{ label: 'A', onClick: () => {} }] });
    const outside = new FakeElement('div');
    ctx.fireDoc('mousedown', { target: outside });
    expect(ctx.body.children).toHaveLength(0);
  });

  it('mousedown inside the menu keeps it open', () => {
    ctx.api.open({ x: 0, y: 0, items: [{ label: 'A', onClick: () => {} }] });
    const menu = ctx.body.children[0];
    const innerButton = menu.children[0];
    ctx.fireDoc('mousedown', { target: innerButton });
    expect(ctx.body.children).toHaveLength(1);
  });

  it('clamps to the viewport when the menu overflows on the right', () => {
    // Reserve an element that reports an overflowing rect after insertion.
    const overflow = new FakeElement('div');
    overflow.getBoundingClientRect = () => ({ left: 790, top: 10, right: 1000, bottom: 40, width: 210, height: 30 });
    // Hook createElement to hand back our instrumented element for the first `div`.
    const originalCreate = (ctx.sandbox.document as { createElement: (t: string) => FakeElement }).createElement;
    let served = false;
    (ctx.sandbox.document as { createElement: (t: string) => FakeElement }).createElement = (tag: string) => {
      if (!served && tag === 'div') { served = true; return overflow; }
      return originalCreate(tag);
    };

    ctx.api.open({ x: 790, y: 10, items: [{ label: 'Long label', onClick: () => {} }] });
    // Left clamped to innerWidth(800) - width(210) - 4 = 586
    expect(overflow.style.left).toBe('586px');
  });

  it('removes document listeners after close so later events do not fire', () => {
    ctx.api.open({ x: 0, y: 0, items: [{ label: 'A', onClick: () => {} }] });
    ctx.api.close();
    const before = ctx.body.children.length;
    // Fire events after close — nothing should blow up, nothing should appear.
    ctx.fireDoc('keydown', { key: 'Escape', stopPropagation: () => {} });
    ctx.fireDoc('mousedown', { target: new FakeElement('div') });
    expect(ctx.body.children.length).toBe(before);
  });
});

describe('context-menu.css', () => {
  it('declares the base .viewstor-ctx-menu rule', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf-8');
    expect(css).toMatch(/\.viewstor-ctx-menu\s*\{/);
    expect(css).toMatch(/\.viewstor-ctx-menu button\s*\{/);
    expect(css).toMatch(/\.viewstor-ctx-menu-separator\s*\{/);
    expect(css).toMatch(/\.viewstor-ctx-menu-destructive/);
  });
});
