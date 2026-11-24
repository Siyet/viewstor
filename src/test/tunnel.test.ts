import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as net from 'net';
import type { EventEmitter } from 'events';
import type { PassThrough } from 'stream';

// Type-only imports above are erased at compile time, so referencing them in the
// vi.hoisted/vi.mock factories below is safe — using the real *values* (not just
// types) there would hit vitest's hoisting TDZ (mock factories run before the
// module's own top-level imports are linked). The factories instead grab the real
// classes via dynamic import(), which isn't subject to that ordering constraint.
const { instances, createdForwardOutStreams, listenGateState, forwardOutGateState } = vi.hoisted(() => {
  return {
    instances: [] as EventEmitter[],
    // ClientChannel forwardOut() would normally return — using a real PassThrough
    // (not a hand-rolled fake) so a real local socket piping through it
    // (sock.pipe(stream).pipe(sock)) works exactly like the genuine ssh2 stream would.
    createdForwardOutStreams: [] as PassThrough[],
    // Off by default (net.createServer behaves exactly like the real thing). One test
    // flips this on to deterministically hold back listen()'s success callback, standing
    // in for the real (but hard-to-time) async gap between listen() being called and its
    // callback firing.
    listenGateState: { active: false, gate: null as Promise<void> | null },
    // Same idea, for forwardOut()'s callback — standing in for the real (but
    // hard-to-time) async gap between dialing the SSH channel and it opening.
    forwardOutGateState: { active: false, gate: null as Promise<void> | null },
  };
});

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');

  class FakeSSHClient extends EventEmitter {
    connect = vi.fn();
    // By default, forwardOut succeeds synchronously with a fresh real stream.
    forwardOut = vi.fn((_srcHost: string, _srcPort: number, _dstHost: string, _dstPort: number, cb: (err: Error | null, stream?: unknown) => void) => {
      const stream = new PassThrough();
      createdForwardOutStreams.push(stream);
      if (forwardOutGateState.active) {
        (forwardOutGateState.gate as Promise<void>).then(() => cb(null, stream));
      } else {
        cb(null, stream);
      }
    });
    end = vi.fn();
    constructor() {
      super();
      instances.push(this as unknown as EventEmitter);
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

  it('rejects instead of hanging forever when a hop closes mid-handshake, before "ready" or "error"', async () => {
    // Real ssh2 only synthesizes an 'error' before 'close' if the transport drops
    // before the identification banner is exchanged — past that point (i.e. for
    // nearly all of a real handshake) a dropped connection emits 'close' alone and
    // cancels ssh2's own internal handshake-timeout backstop. No listener for
    // 'error' would ever fire, and nothing else in this codebase times the connect
    // out either.
    const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    const failure = promise.catch((err: Error) => err);

    let settled: 'pending' | 'settled' = 'pending';
    failure.then(() => { settled = 'settled'; });

    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('close'); // no 'ready', no 'error' — just closes mid-handshake
    await new Promise((r) => setTimeout(r, 10));

    expect(settled).toBe('settled'); // must not still be pending — that would be a permanent hang
    const err = await failure;
    expect(err).toBeInstanceOf(Error);
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

  it('rejects instead of hanging forever when an already-connected hop dies while the next hop is still connecting', async () => {
    // A hop's own 'sock' (when it's a channel over a previous hop, not a real TCP
    // socket) ending quietly only emits 'close', never 'error' — this is real ssh2
    // behavior (a custom `sock` stream ending cancels its internal connect-timeout
    // without raising one), so a listener for 'error' alone isn't enough to unstick
    // a hop that's still mid-connect over a now-dead earlier hop.
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
    instances[0].emit('ready'); // hop 1 connects; hop 2's connect (through it) starts
    await new Promise((r) => setTimeout(r, 10));
    expect(instances.length).toBe(2); // hop 2's client now exists and is mid-connect

    let settled: 'pending' | 'settled' = 'pending';
    failure.then(() => { settled = 'settled'; });

    instances[0].emit('close'); // hop 1 dies with no 'error', only 'close'
    await new Promise((r) => setTimeout(r, 10));

    expect(settled).toBe('settled'); // must not still be pending — that would be a permanent hang
    const err = await failure;
    expect(err).toBeInstanceOf(Error);
    expect(instances[0].end).toHaveBeenCalled();
    // Hop 2's client was created (and started connecting) before losing the
    // chainDeath race — connectHop's own promise settling isn't what makes it safe
    // to abandon; without ending it explicitly it keeps connecting in the background.
    expect(instances[1].end).toHaveBeenCalled();
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

  it('tears down the tunnel when a hop closes cleanly post-establishment, with no error event at all', async () => {
    // A real ssh2 client whose underlying TCP connection closes cleanly (remote sshd
    // restart, idle timeout, graceful process exit — not a reset) only ever emits
    // 'close', never 'error'. Listening for 'error' alone leaves a zombie tunnel: the
    // local listener stays up against a fully dead SSH chain.
    const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('ready');
    const tunnel = await promise;

    instances[0].emit('close'); // no 'error' at all
    await new Promise((r) => setTimeout(r, 10));

    expect(instances[0].end).toHaveBeenCalled();

    // The local listener must be gone, not a zombie still accepting doomed connections.
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(tunnel.localPort, tunnel.localHost);
      probe.on('connect', () => { probe.destroy(); reject(new Error('local listener is still accepting connections')); });
      probe.on('error', () => resolve());
    });
  });

  it('does not crash when forwardOut throws synchronously ("Not connected") for a dead hop', async () => {
    // ssh2's Client.forwardOut() throws synchronously rather than erroring via
    // callback once the client's underlying socket is already gone — a real,
    // observed behavior, not a hypothetical one.
    const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('ready');
    const tunnel = await promise;

    (instances[0] as unknown as { forwardOut: ReturnType<typeof vi.fn> }).forwardOut.mockImplementationOnce(() => {
      throw new Error('Not connected');
    });

    // Reaching the assertions below at all (rather than crashing the process) is
    // most of what this test proves.
    const probe = net.connect(tunnel.localPort, tunnel.localHost);
    await new Promise<void>((resolve, reject) => {
      probe.on('connect', () => resolve());
      probe.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 10));

    tunnel.close();
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

  it('does not crash the process when the forwarded SSH channel errors mid-connection', async () => {
    const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('ready');
    const tunnel = await promise;

    // A real connection, so the server's connection handler actually runs forwardOut
    // and pipes a real local socket into the (fake) SSH channel — not a probe that
    // disconnects before that handler fires.
    const probe = net.connect(tunnel.localPort, tunnel.localHost);
    await new Promise<void>((resolve, reject) => {
      probe.on('connect', () => resolve());
      probe.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(createdForwardOutStreams.length).toBe(1);

    // Without an 'error' listener on the forwarded stream, this throws synchronously —
    // an uncaught exception that would crash the whole extension host, not just this
    // connection. Reaching the assertions below at all is part of what this proves.
    createdForwardOutStreams[0].emit('error', new Error('ssh channel closed'));
    await new Promise((r) => setTimeout(r, 10));

    // .pipe() doesn't cascade destruction on error — the local socket being gone must
    // not leave the SSH channel (the real connection out to the database) dangling.
    expect(createdForwardOutStreams[0].destroyed).toBe(true);

    // The tunnel itself must still be healthy — only the one bad connection should
    // have been torn down, not the whole local listener.
    await new Promise<void>((resolve, reject) => {
      const secondProbe = net.connect(tunnel.localPort, tunnel.localHost);
      secondProbe.on('connect', () => { secondProbe.destroy(); resolve(); });
      secondProbe.on('error', reject);
    });

    probe.destroy();
    tunnel.close();
  });

  it('does not crash the process when the local client socket resets mid-connection', async () => {
    const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
    const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
    await new Promise((r) => setTimeout(r, 10));
    instances[0].emit('ready');
    const tunnel = await promise;

    const probe = net.connect(tunnel.localPort, tunnel.localHost);
    await new Promise<void>((resolve, reject) => {
      probe.on('connect', () => resolve());
      probe.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(createdForwardOutStreams.length).toBe(1);

    // A genuine TCP RST (query cancellation, client crash, network blip) rather than
    // a clean close — this is what an unhandled 'error' on the server-side `sock`
    // would previously have crashed the process on.
    probe.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 10));

    // The SSH channel (the real connection out to the database) must not be left
    // dangling just because the local leg reset — .pipe() doesn't cascade destruction.
    expect(createdForwardOutStreams[0].destroyed).toBe(true);

    // The tunnel itself must still be healthy.
    await new Promise<void>((resolve, reject) => {
      const secondProbe = net.connect(tunnel.localPort, tunnel.localHost);
      secondProbe.on('connect', () => { secondProbe.destroy(); resolve(); });
      secondProbe.on('error', reject);
    });

    tunnel.close();
  });

  it('destroys the SSH channel if the local socket dies before forwardOut finishes opening it', async () => {
    // forwardOut is a real round trip to the SSH server — the local socket can die
    // (reset, or a driver's own connect-timeout) while that's still in flight. Real
    // network timing can't be relied on to land in that exact window, so this gates
    // the mocked forwardOut's callback behind a promise we control.
    let releaseForwardOut: () => void = () => {};
    forwardOutGateState.gate = new Promise<void>((resolve) => { releaseForwardOut = resolve; });
    forwardOutGateState.active = true;

    try {
      const proxy = { type: 'ssh' as const, sshHost: 'example.com', sshUsername: 'u', sshPassword: 'p' };
      const promise = createSSHTunnel(proxy, '127.0.0.1', 5432);
      await new Promise((r) => setTimeout(r, 10));
      instances[0].emit('ready');
      const tunnel = await promise;

      const probe = net.connect(tunnel.localPort, tunnel.localHost);
      await new Promise<void>((resolve, reject) => {
        probe.on('connect', () => resolve());
        probe.on('error', reject);
      });
      // forwardOut has now been called (and captured a channel) but our gate is
      // holding back its callback — this is the "channel still opening" window.
      await new Promise((r) => setTimeout(r, 10));
      expect(createdForwardOutStreams.length).toBe(1);

      probe.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 10));

      releaseForwardOut(); // the gated callback now runs with sock already destroyed
      await new Promise((r) => setTimeout(r, 10));

      // Piping into/from an already-destroyed socket is a silent no-op — without an
      // explicit guard, the channel opened after the fact would never get destroyed.
      expect(createdForwardOutStreams[0].destroyed).toBe(true);

      // The tunnel itself must still be healthy.
      await new Promise<void>((resolve, reject) => {
        const secondProbe = net.connect(tunnel.localPort, tunnel.localHost);
        secondProbe.on('connect', () => { secondProbe.destroy(); resolve(); });
        secondProbe.on('error', reject);
      });

      tunnel.close();
    } finally {
      forwardOutGateState.active = false;
      forwardOutGateState.gate = null;
    }
  });
});
