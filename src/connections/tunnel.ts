import { Client as SSHClient, type ClientChannel } from 'ssh2';
import * as net from 'net';
import { ProxyConfig, SshHop } from '../types/connection';

export interface TunnelInfo {
  localHost: string;
  localPort: number;
  close: () => void;
}

/** proxy's flat ssh* fields are hop 1; proxy.sshHops are chained after it. */
function buildHopChain(proxy: ProxyConfig): SshHop[] {
  const firstHop: SshHop = {
    host: proxy.sshHost || '',
    port: proxy.sshPort,
    username: proxy.sshUsername,
    password: proxy.sshPassword,
    privateKey: proxy.sshPrivateKey,
    passphrase: proxy.sshPassphrase,
  };
  return [firstHop, ...(proxy.sshHops || [])];
}

/** Connects one SSH hop, optionally tunneling the connection itself through `sock` (a stream from a previous hop's forwardOut). `onCreated` fires synchronously with the client, before any connect/auth I/O — the caller needs it even if this hop later loses a race and its promise is abandoned. */
function connectHop(hop: SshHop, sock: ClientChannel | undefined, onCreated: (client: SSHClient) => void): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    onCreated(client);
    const connectConfig: Record<string, unknown> = {
      host: hop.host,
      port: hop.port || 22,
      username: hop.username,
    };
    if (hop.privateKey) {
      connectConfig.privateKey = hop.privateKey;
      if (hop.passphrase) connectConfig.passphrase = hop.passphrase;
    } else if (hop.password) {
      connectConfig.password = hop.password;
    }
    if (sock) connectConfig.sock = sock;

    client.on('ready', () => resolve(client));
    client.on('error', (err) => reject(err));
    client.connect(connectConfig);
  });
}

/** Connects each hop in order, tunneling hop N+1's SSH connection through hop N's forwardOut. */
async function connectHopChain(hops: SshHop[]): Promise<SSHClient[]> {
  const clients: SSHClient[] = [];
  // Every SSHClient ever created, including one that loses the chainDeath race below
  // while still mid-connect. `clients` alone isn't enough to clean up on failure — a
  // client is only pushed there once its own connect *wins* its race, but a loser is
  // still a real, live socket that keeps connecting/authenticating in the background
  // unless something ends it too.
  const allCreated: SSHClient[] = [];

  // If an already-connected hop dies while a later hop is still connecting through
  // it, that later hop's connect attempt can hang forever instead of erroring: its
  // `sock` is a channel over the dead hop, and a custom `sock` stream ending quietly
  // cancels ssh2's own internal connect timeout without ever emitting 'error' — only
  // 'close'. Racing every connect step against this lets a mid-chain death abort
  // whatever's currently in flight instead of leaving it stuck. Left armed (and
  // harmlessly inert) after the chain finishes; a promise nothing awaits doesn't need
  // to be observed, but must not raise an unhandled rejection if it fires later.
  let onChainDeath: (err: Error) => void = () => {};
  const chainDeath = new Promise<never>((_, reject) => { onChainDeath = reject; });
  chainDeath.catch(() => {});
  const armDeathWatch = (client: SSHClient) => {
    const die = (err?: Error) => onChainDeath(err || new Error('SSH hop closed unexpectedly'));
    client.on('error', die);
    client.on('close', die);
  };

  try {
    for (const hop of hops) {
      let sock: ClientChannel | undefined;
      if (clients.length > 0) {
        const previous = clients[clients.length - 1];
        const forwardOutPromise = new Promise<ClientChannel>((resolve, reject) => {
          previous.forwardOut('127.0.0.1', 0, hop.host, hop.port || 22, (err, stream) => {
            if (err) reject(err); else resolve(stream);
          });
        });
        forwardOutPromise.catch(() => {}); // don't leave an unhandled rejection if chainDeath wins first
        sock = await Promise.race([forwardOutPromise, chainDeath]);
      }
      const connectPromise = connectHop(hop, sock, (c) => allCreated.push(c));
      connectPromise.catch(() => {}); // same — a losing hop keeps connecting in the background
      const client = await Promise.race([connectPromise, chainDeath]);
      armDeathWatch(client);
      clients.push(client);
    }
    return clients;
  } catch (err) {
    // Sweep every client ever created, not just the ones that made it into `clients`
    // — a hop that lost its chainDeath race is still a real, live connecting socket.
    allCreated.forEach((c) => c.end());
    throw err;
  }
}

/**
 * Creates an SSH tunnel — through one or more chained hops — that forwards a local
 * port to a remote host:port reachable from the last hop. Returns the local
 * host:port to connect the DB driver to.
 */
export function createSSHTunnel(
  proxy: ProxyConfig,
  remoteHost: string,
  remotePort: number,
): Promise<TunnelInfo> {
  return new Promise((resolve, reject) => {
    const hops = buildHopChain(proxy);

    // The local server must not accept connections (and forwardOut must not be called)
    // until every hop is authenticated — otherwise a DB client that dials in
    // immediately after this promise resolves can race the SSH handshake and crash it.
    connectHopChain(hops).then((clients) => {
      const lastHop = clients[clients.length - 1];
      let tornDown = false;
      const closeAll = () => {
        if (tornDown) return;
        tornDown = true;
        server.close();
        clients.forEach((c) => c.end());
      };

      const server = net.createServer((sock) => {
        // Neither side of an ordinary TCP reset (query cancellation, DB restart, a
        // client that drops without reading) is handled by .pipe() itself — an
        // EventEmitter that emits 'error' with no listener throws, which without
        // these would crash the whole extension host, not just this connection.
        // .pipe() also doesn't cascade destruction on error, so each handler must
        // destroy *both* ends itself — leaving `stream` (the actual SSH channel,
        // i.e. the real connection out to the database) open otherwise leaks one
        // channel and one DB-side connection per reset, for the tunnel's lifetime.
        let stream: ClientChannel | undefined;
        sock.on('error', () => { sock.destroy(); stream?.destroy(); });
        try {
          lastHop.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, remoteHost, remotePort, (err, s) => {
            if (err) { sock.destroy(); return; }
            // forwardOut is a real round trip to the SSH server — sock can already be
            // dead (reset, or a driver's own connect timeout) by the time this fires.
            // Piping into/from an already-destroyed socket is a silent no-op, so
            // without this the freshly opened channel would never get destroyed.
            if (sock.destroyed) { s.destroy(); return; }
            stream = s;
            stream.on('error', () => { sock.destroy(); stream?.destroy(); });
            sock.pipe(stream).pipe(sock);
          });
        } catch {
          // ssh2's forwardOut() throws synchronously ("Not connected") once the
          // client's underlying socket is gone, rather than erroring via callback —
          // same outcome as the async `err` case above, just a different shape.
          sock.destroy();
        }
      });

      // A hop can drop after the tunnel is already established (network blip, idle
      // timeout, server-side restart) — tear down the whole chain instead of leaking
      // the local listener and the other hops' now-orphaned SSH clients. It can also
      // drop in the short async window between server.listen() being called and its
      // callback firing; reject() is a no-op once resolve() has already run, so this
      // covers both cases without needing to know which one happened. A real ssh2
      // client that dies cleanly (remote end closed the TCP connection, no reset)
      // only ever emits 'close', never 'error' — 'error' alone would leave a zombie
      // listener up against a fully dead chain.
      clients.forEach((c) => {
        const die = (err?: Error) => {
          closeAll();
          reject(err || new Error('SSH hop closed unexpectedly'));
        };
        c.on('error', die);
        c.on('close', die);
      });

      server.listen(0, '127.0.0.1', () => {
        // A hop can die between listen() being called and this callback firing;
        // closeAll() already rejected the promise in that case, and server.address()
        // returns null once the server is closed — bail out instead of crashing on it.
        if (tornDown) return;
        const addr = server.address() as net.AddressInfo;
        resolve({
          localHost: '127.0.0.1',
          localPort: addr.port,
          close: closeAll,
        });
      });

      server.on('error', (err) => {
        closeAll();
        reject(err);
      });
    }, reject);
  });
}

/**
 * Creates a SOCKS5 proxy connection.
 * Returns a net.Socket connected through the proxy.
 */
export function createSocks5Connection(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.proxyPort || 1080, proxy.proxyHost || '127.0.0.1', () => {
      // SOCKS5 handshake
      const authMethod = proxy.proxyUsername ? 0x02 : 0x00;
      socket.write(Buffer.from([0x05, 0x01, authMethod]));

      socket.once('data', (data) => {
        if (data[0] !== 0x05) { reject(new Error('SOCKS5: invalid version')); return; }

        const afterAuth = () => {
          // Connect request
          const hostBuf = Buffer.from(targetHost);
          const req = Buffer.alloc(7 + hostBuf.length);
          req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
          req[4] = hostBuf.length;
          hostBuf.copy(req, 5);
          req.writeUInt16BE(targetPort, 5 + hostBuf.length);
          socket.write(req);

          socket.once('data', (resp) => {
            if (resp[1] === 0x00) resolve(socket);
            else reject(new Error(`SOCKS5: connect failed (${resp[1]})`));
          });
        };

        if (data[1] === 0x02 && proxy.proxyUsername) {
          // Username/password auth
          const uBuf = Buffer.from(proxy.proxyUsername);
          const pBuf = Buffer.from(proxy.proxyPassword || '');
          const auth = Buffer.alloc(3 + uBuf.length + pBuf.length);
          auth[0] = 0x01; auth[1] = uBuf.length;
          uBuf.copy(auth, 2);
          auth[2 + uBuf.length] = pBuf.length;
          pBuf.copy(auth, 3 + uBuf.length);
          socket.write(auth);
          socket.once('data', (authResp) => {
            if (authResp[1] === 0x00) afterAuth();
            else reject(new Error('SOCKS5: auth failed'));
          });
        } else {
          afterAuth();
        }
      });
    });
    socket.on('error', reject);
  });
}
