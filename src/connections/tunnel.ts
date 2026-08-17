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

/** Connects one SSH hop, optionally tunneling the connection itself through `sock` (a stream from a previous hop's forwardOut). */
function connectHop(hop: SshHop, sock?: ClientChannel): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
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
  try {
    for (const hop of hops) {
      let sock: ClientChannel | undefined;
      if (clients.length > 0) {
        const previous = clients[clients.length - 1];
        sock = await new Promise<ClientChannel>((resolve, reject) => {
          previous.forwardOut('127.0.0.1', 0, hop.host, hop.port || 22, (err, stream) => {
            if (err) reject(err); else resolve(stream);
          });
        });
      }
      clients.push(await connectHop(hop, sock));
    }
    return clients;
  } catch (err) {
    clients.forEach((c) => c.end());
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
      const closeAll = () => clients.forEach((c) => c.end());

      const server = net.createServer((sock) => {
        lastHop.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, remoteHost, remotePort, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve({
          localHost: '127.0.0.1',
          localPort: addr.port,
          close: () => {
            server.close();
            closeAll();
          },
        });
      });

      server.on('error', (err) => {
        server.close();
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
