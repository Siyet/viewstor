import { describe, it, expect, vi, beforeEach } from 'vitest';

const { instances, FakeEmitter, fakeForwardOutStream } = vi.hoisted(() => {
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
  // A single identifiable marker object stands in for the ClientChannel forwardOut()
  // would normally return, so tests can assert the *same* stream is threaded into
  // the next hop's connect({ sock }) rather than just that forwardOut was called.
  const fakeForwardOutStream = { marker: 'fake-forward-out-stream' };
  return { instances: [] as FakeEmitter[], FakeEmitter, fakeForwardOutStream };
});

vi.mock('ssh2', () => {
  class FakeSSHClient extends FakeEmitter {
    connect = vi.fn();
    // By default, forwardOut succeeds synchronously with the shared stand-in stream.
    forwardOut = vi.fn((_srcHost: string, _srcPort: number, _dstHost: string, _dstPort: number, cb: (err: Error | null, stream?: unknown) => void) => {
      cb(null, fakeForwardOutStream);
    });
    end = vi.fn();
    constructor() {
      super();
      instances.push(this);
    }
  }
  return { Client: FakeSSHClient };
});

import { createSSHTunnel } from '../connections/tunnel';

beforeEach(() => {
  instances.length = 0;
});

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

  it('chains through proxy.sshHops and does not resolve until every hop is ready', async () => {
    const proxy = {
      type: 'ssh' as const,
      sshHost: 'bastion.example.com',
      sshUsername: 'u1',
      sshPassword: 'p1',
      sshHops: [{ host: 'internal.example.com', username: 'u2', password: 'p2' }],
    };

    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Only hop 1 connects up front — hop 2 is dialed through hop 1's forwardOut.
    await new Promise((r) => setTimeout(r, 10));
    expect(instances.length).toBe(1);

    // Hop 1 is dialed directly — no `sock`, i.e. a real TCP connection, not chained through anything.
    expect(instances[0].connect).toHaveBeenCalledWith(expect.not.objectContaining({ sock: expect.anything() }));

    instances[0].emit('ready');
    await new Promise((r) => setTimeout(r, 10));

    expect(instances[0].forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, 'internal.example.com', 22, expect.any(Function));
    expect(instances.length).toBe(2);
    // Hop 2 must be dialed *through* hop 1's stream (ssh2's ConnectConfig.sock), not
    // over a direct network connection — otherwise the whole point of chaining is lost.
    expect(instances[1].connect).toHaveBeenCalledWith(expect.objectContaining({ sock: fakeForwardOutStream }));
    expect(resolved).toBe(false); // hop 2 not ready yet

    instances[1].emit('ready');
    const tunnel = await promise;

    expect(tunnel.localPort).toBeGreaterThan(0);
    tunnel.close();
    expect(instances[0].end).toHaveBeenCalled();
    expect(instances[1].end).toHaveBeenCalled();
  });

  it('tears down already-connected hops when a later hop fails', async () => {
    const proxy = {
      type: 'ssh' as const,
      sshHost: 'bastion.example.com',
      sshUsername: 'u1',
      sshPassword: 'p1',
      sshHops: [{ host: 'internal.example.com', username: 'u2', password: 'p2' }],
    };

    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    const failure = promise.catch((err: Error) => err);

    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('ready');
    await new Promise((r) => setTimeout(r, 10));

    const hop2Error = new Error('hop 2 auth failed');
    instances[1].emit('error', hop2Error);

    const err = await failure;
    expect(err).toBe(hop2Error);
    expect(instances[0].end).toHaveBeenCalled();
  });
});
