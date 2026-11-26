import type { StandaloneMcpSettings } from '../types/connection';

export type StandaloneMcpSetting = NonNullable<StandaloneMcpSettings['allowAddConnection']>;

export interface StandaloneMcpSettingsState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const EXPLICIT_SETTING_MARKER = 'viewstor.standaloneMcp.allowAddConnectionExplicit';

/**
 * Synchronize explicit VS Code user settings without touching a hand-edited standalone config.
 * A persistent marker distinguishes Reset Setting from a value that was never explicit, including
 * across extension reloads. It is cleared only after the safe default was persisted successfully.
 */
export function createStandaloneMcpSettingsSync(
  write: (value: StandaloneMcpSetting) => boolean,
  state: StandaloneMcpSettingsState,
): (value: StandaloneMcpSetting | undefined) => Promise<void> {
  return async value => {
    if (value !== undefined) {
      if (write(value)) await state.update(EXPLICIT_SETTING_MARKER, true);
      return;
    }
    if (state.get(EXPLICIT_SETTING_MARKER) !== true) return;
    if (!write('restricted')) return;
    await state.update(EXPLICIT_SETTING_MARKER, undefined);
  };
}
