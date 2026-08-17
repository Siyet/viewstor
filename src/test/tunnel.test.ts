import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as net from 'net';

const { instances, FakeEmitter, FakeStream, createdForwardOutStreams, listenGateState } = vi.hoisted(() => {
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
  // Stands in for the ClientChannel forwardOut() would normally return. real Socket.pipe()
  // requires a working Writable *and* Readable (its return value gets piped right back into
  // the socket) — a plain object makes .pipe() throw the moment a real local connection
  // actually reaches it, so this implements just enough of both ends to be pipe-safe. No
  // bytes need to move for these tests, so write/pipe are inert.
  class FakeStream extends FakeEmitter {
    write() { return true; }
    end() { /* no-op */ }
    pipe(dest: unknown) { return dest; }
  }
  const createdForwardOutStreams: FakeStream[] = [];
  // Off by default (net.createServer behaves exactly like the real thing). One test
  // flips this on to deterministically hold back listen()'s success callback, standing
  // in for the real (but hard-to-time) async gap between listen() being called and its
  // callback firing.
  const listenGateState = { active: false, gate: null as Promise<void> | null };
  return { instances: [] as FakeEmitter[], FakeEmitter, FakeStream, createdForwardOutStreams, listenGateState };
});

vi.mock('ssh2', () => {
  class FakeSSHClient extends FakeEmitter {
    connect = vi.fn();
    // By default, forwardOut succeeds synchronously with a fresh pipe-safe stream.
    forwardOut = vi.fn((_srcHost: string, _srcPort: number, _dstHost: string, _dstPort: number, cb: (err: Error | null, stream?: unknown) => void) => {
      const stream = new FakeStream();
      createdForwardOutStreams.push(stream);
      cb(null, stream);
    });
    end = vi.fn();
    constructor() {
      super();
      instances.push(this);
    }
  }
  return { Client: FakeSSHClient };
});

vi.mock('net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('net')>();
  return {
    ...actual,
    createServer: (connectionListener?: (sock: net.Socket) => void) => {
      const server = actual.createServer(connectionListener);
      if (!listenGateState.active) return server;
      const realListen = server.listen.bind(server);
      server.listen = ((...args: unknown[]) => {
        const cb = args[args.length - 1] as () => void;
        return realListen(args[0] as number, args[1] as string, () => { (listenGateState.gate as Promise<void>).then(cb); });
      }) as typeof server.listen;
      return server;
    },
  };
});

import { createSSHTunnel } from '../connections/tunnel';

beforeEach(() => {
  instances.length = 0;
  createdForwardOutStreams.length = 0;
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
    expect(instances[1].connect).toHaveBeenCalledWith(expect.objectContaining({ sock: createdForwardOutStreams[0] }));
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

  it('tears down the local listener and every hop when a hop drops after the tunnel is already established', async () => {
    const proxy = {
      type: 'ssh' as const,
      sshHost: 'bastion.example.com',
      sshUsername: 'u1',
      sshPassword: 'p1',
      sshHops: [{ host: 'internal.example.com', username: 'u2', password: 'p2' }],
    };

    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('ready');
    await new Promise((r) => setTimeout(r, 10));
    instances[1].emit('ready');
    const tunnel = await promise;

    // Real TCP connect against the real local port createSSHTunnel opened —
    // proves the listener is actually open, not just that a mock resolved.
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(tunnel.localPort, tunnel.localHost);
      probe.on('connect', () => { probe.destroy(); resolve(); });
      probe.on('error', reject);
    });

    // Simulate hop 1 dropping well after the tunnel is live (network blip, idle timeout).
    instances[0].emit('error', new Error('connection reset'));

    await new Promise((r) => setTimeout(r, 10));
    expect(instances[0].end).toHaveBeenCalled();
    expect(instances[1].end).toHaveBeenCalled();

    // The local listener must be gone — connecting now should fail outright.
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(tunnel.localPort, tunnel.localHost);
      probe.on('connect', () => { probe.destroy(); reject(new Error('local listener is still accepting connections')); });
      probe.on('error', () => resolve());
    });
  });

  it('rejects instead of hanging forever when a hop errors while the local listener is still binding', async () => {
    // net.Server.listen()'s success callback fires asynchronously (a real OS bind,
    // not a microtask) — there's a genuine gap between createSSHTunnel calling
    // listen() and that callback (and thus resolve()) running. A hop dying in that
    // gap must still reject the promise, not leave it pending forever. Real OS
    // timing can't reproduce that gap deterministically, so the mocked 'net' module
    // gates the real listen() callback behind a promise we control here, standing
    // in for "still binding".
    let releaseListenCallback: () => void = () => {};
    listenGateState.gate = new Promise<void>((resolve) => { releaseListenCallback = resolve; });
    listenGateState.active = true;

    try {
      const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
      const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);

      let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
      promise.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });

      await new Promise((r) => setTimeout(r, 10));
      instances[0].emit('ready');
      // listen() has now been called (and, underneath, actually bound) but our gate
      // is holding back its callback — this is the "still binding" window.
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe('pending');

      instances[0].emit('error', new Error('dropped mid-bind'));
      await new Promise((r) => setTimeout(r, 10));

      expect(settled).toBe('rejected'); // must not still be 'pending' — that would be a permanent hang
      expect(instances[0].end).toHaveBeenCalled();

      releaseListenCallback(); // let the gated callback run too; must not throw or double-settle anything
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      listenGateState.active = false;
      listenGateState.gate = null;
    }
  });
});
