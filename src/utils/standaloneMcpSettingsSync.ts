import type { StandaloneMcpSettings } from '../types/connection';

export type StandaloneMcpSetting = NonNullable<StandaloneMcpSettings['allowAddConnection']>;

/**
 * Synchronize explicit VS Code user settings without touching a hand-edited standalone config.
 * Resetting a previously explicit setting restores the safe default instead of leaving the old
 * `off` / `unrestricted` policy stranded in the standalone JSON file.
 */
export function createStandaloneMcpSettingsSync(
  write: (value: StandaloneMcpSetting) => void,
): (value: StandaloneMcpSetting | undefined) => void {
  let previousExplicit: StandaloneMcpSetting | undefined;

  return value => {
    if (value !== undefined) {
      previousExplicit = value;
      write(value);
      return;
    }
    if (previousExplicit === undefined) return;
    previousExplicit = undefined;
    write('restricted');
  };
}
