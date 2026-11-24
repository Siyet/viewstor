import { describe, expect, it, vi } from 'vitest';
import { createStandaloneMcpSettingsSync } from '../utils/standaloneMcpSettingsSync';

describe('createStandaloneMcpSettingsSync', () => {
  it('does not touch standalone JSON when no explicit global value exists', () => {
    const write = vi.fn();
    const sync = createStandaloneMcpSettingsSync(write);

    sync(undefined);
    sync(undefined);

    expect(write).not.toHaveBeenCalled();
  });

  it.each(['off', 'restricted', 'unrestricted'] as const)('writes an explicit %s value', value => {
    const write = vi.fn();
    const sync = createStandaloneMcpSettingsSync(write);

    sync(value);

    expect(write.mock.calls).toEqual([[value]]);
  });

  it.each(['off', 'unrestricted'] as const)('restores restricted after resetting explicit %s', value => {
    const write = vi.fn();
    const sync = createStandaloneMcpSettingsSync(write);

    sync(value);
    sync(undefined);
    sync(undefined);

    expect(write.mock.calls).toEqual([[value], ['restricted']]);
  });
});
