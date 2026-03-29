import { Client as SSHClient } from 'ssh2';
import * as net from 'net';
import { ProxyConfig } from '../types/connection';

export interface TunnelInfo {
  localHost: string;
  localPort: number;
  close: () => void;
}

/**
 * Creates an SSH tunnel that forwards a local port to a remote host:port.
 * Returns the local host:port to connect the DB driver to.
 */
export function createSSHTunnel(
  proxy: ProxyConfig,
  remoteHost: string,
  remotePort: number,
): Promise<TunnelInfo> {
  return new Promise((resolve, reject) => {
    const ssh = new SSHClient();
    const server = net.createServer((sock) => {
      ssh.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, remoteHost, remotePort, (err, stream) => {
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
          ssh.end();
        },
      });
    });

    const connectConfig: Record<string, unknown> = {
      host: proxy.sshHost,
      port: proxy.sshPort || 22,
      username: proxy.sshUsername,
    };
    if (proxy.sshPrivateKey) {
      connectConfig.privateKey = proxy.sshPrivateKey;
      if (proxy.sshPassphrase) connectConfig.passphrase = proxy.sshPassphrase;
    } else if (proxy.sshPassword) {
      connectConfig.password = proxy.sshPassword;
    }

    ssh.on('ready', () => {
      // SSH connected — local server is already listening
    });
    ssh.on('error', (err) => {
      server.close();
      reject(err);
    });
    ssh.connect(connectConfig);
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
