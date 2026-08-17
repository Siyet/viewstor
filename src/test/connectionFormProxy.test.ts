/**
 * Unit tests for ConnectionFormPanel's form-data → ConnectionConfig mapping,
 * focused on the SSH proxy / second-hop fields.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ConnectionFormPanel } from '../views/connectionForm';
import { ConnectionConfig } from '../types/connection';

// parseFormData is a private instance method — it doesn't touch `this`, so a
// panel built from stub constructor args is enough to call it.
function parse(data: Record<string, string>): ConnectionConfig {
  const panel = new ConnectionFormPanel({} as never, {} as never);
  return (panel as unknown as { parseFormData(d: Record<string, string>): ConnectionConfig }).parseFormData(data);
}

const baseData: Record<string, string> = {
  name: 'test',
  type: 'postgresql',
  host: '127.0.0.1',
  port: '5435',
  proxyType: 'ssh',
  sshHost: 'bastion.example.com',
  sshPort: '22',
  sshUsername: 'u1',
  sshPassword: 'p1',
};

describe('ConnectionFormPanel.parseFormData — SSH proxy', () => {
  it('omits sshHops when the second-hop checkbox is unset', () => {
    const config = parse({ ...baseData, sshHop2Enabled: 'false', sshHop2Host: '' });
    expect(config.proxy?.sshHops).toBeUndefined();
  });

  it('omits sshHops when enabled but no host was entered', () => {
    const config = parse({ ...baseData, sshHop2Enabled: 'true', sshHop2Host: '' });
    expect(config.proxy?.sshHops).toBeUndefined();
  });

  it('builds a single-entry sshHops array from the second-hop fields', () => {
    const config = parse({
      ...baseData,
      sshHop2Enabled: 'true',
      sshHop2Host: 'internal.example.com',
      sshHop2Port: '2222',
      sshHop2Username: 'u2',
      sshHop2Password: 'p2',
      sshHop2PrivateKey: '',
    });

    expect(config.proxy?.sshHops).toEqual([{
      host: 'internal.example.com',
      port: 2222,
      username: 'u2',
      password: 'p2',
      privateKey: undefined,
    }]);
  });

  it('defaults the second hop port to 22', () => {
    const config = parse({
      ...baseData,
      sshHop2Enabled: 'true',
      sshHop2Host: 'internal.example.com',
      sshHop2Port: '',
    });
    expect(config.proxy?.sshHops?.[0].port).toBe(22);
  });
});
