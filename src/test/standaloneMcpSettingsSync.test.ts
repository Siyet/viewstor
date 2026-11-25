import { describe, expect, it, vi } from 'vitest';
import { createStandaloneMcpSettingsSync, type StandaloneMcpSettingsState } from '../utils/standaloneMcpSettingsSync';

function createState(): StandaloneMcpSettingsState {
  const values = new Map<string, unknown>();
  return {
    get: key => values.get(key),
    update: async (key, value) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

describe('createStandaloneMcpSettingsSync', () => {
  it('does not touch standalone JSON when no explicit global value exists', async () => {
    const write = vi.fn(() => true);
    const sync = createStandaloneMcpSettingsSync(write, createState());

    await sync(undefined);
    await sync(undefined);

    expect(write).not.toHaveBeenCalled();
  });

  it.each(['off', 'restricted', 'unrestricted'] as const)('writes an explicit %s value', async value => {
    const write = vi.fn(() => true);
    const sync = createStandaloneMcpSettingsSync(write, createState());

    await sync(value);

    expect(write.mock.calls).toEqual([[value]]);
  });

  it.each(['off', 'unrestricted'] as const)('restores restricted after resetting explicit %s across a reload', async value => {
    const write = vi.fn(() => true);
    const state = createState();
    const firstActivation = createStandaloneMcpSettingsSync(write, state);
    await firstActivation(value);

    const secondActivation = createStandaloneMcpSettingsSync(write, state);
    await secondActivation(undefined);
    await secondActivation(undefined);

    expect(write.mock.calls).toEqual([[value], ['restricted']]);
  });

  it('retains the reset marker after a failed write and retries on the next activation', async () => {
    const write = vi.fn(() => true);
    const state = createState();
    await createStandaloneMcpSettingsSync(write, state)('unrestricted');

    write.mockReturnValue(false);
    await createStandaloneMcpSettingsSync(write, state)(undefined);
    write.mockReturnValue(true);
    const retry = createStandaloneMcpSettingsSync(write, state);
    await retry(undefined);
    await retry(undefined);

    expect(write.mock.calls).toEqual([
      ['unrestricted'],
      ['restricted'],
      ['restricted'],
    ]);
  });
});
