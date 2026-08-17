import { describe, it, expect, vi } from 'vitest';

const { instances, FakeEmitter } = vi.hoisted(() => {
  class FakeEmitter {
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    on(event: string, cb: (...args: unknown[]) => void) {
      (this.listeners[event] ||= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      (this.listeners[event] || []).forEach((cb) => cb(...args));
    }
  }
  return { instances: [] as FakeEmitter[], FakeEmitter };
});

vi.mock('ssh2', () => {
  class FakeSSHClient extends FakeEmitter {
    connect = vi.fn();
    forwardOut = vi.fn();
    end = vi.fn();
    constructor() {
      super();
      instances.push(this);
    }
  }
  return { Client: FakeSSHClient };
});

import { createSSHTunnel } from '../connections/tunnel';

describe('createSSHTunnel', () => {
  it('does not resolve before the SSH session emits "ready"', async () => {
    const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);

    let resolved = false;
    promise.then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    instances[0].emit('ready');
    const tunnel = await promise;

    expect(tunnel.localPort).toBeGreaterThan(0);
    tunnel.close();
  });
});
