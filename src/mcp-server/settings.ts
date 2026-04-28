import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type AddConnectionMode = 'off' | 'restricted' | 'unrestricted';

const SETTINGS_FILE = path.join(os.homedir(), '.viewstor', 'settings.json');

interface McpSettings {
  allowAddConnection?: AddConnectionMode;
}

export function isValidMode(val: unknown): val is AddConnectionMode {
  return val === 'off' || val === 'restricted' || val === 'unrestricted';
}

export function resolveMode(envVal: string | undefined, fileContent: string | undefined): AddConnectionMode {
  if (isValidMode(envVal)) return envVal;

  if (fileContent) {
    try {
      const data: McpSettings = JSON.parse(fileContent);
      if (isValidMode(data.allowAddConnection)) return data.allowAddConnection;
    } catch {
      // Invalid JSON — fall through
    }
  }

  return 'restricted';
}

export function getAddConnectionMode(): AddConnectionMode {
  let fileContent: string | undefined;
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      fileContent = fs.readFileSync(SETTINGS_FILE, 'utf8');
    }
  } catch {
    // Missing or unreadable file
  }

  return resolveMode(process.env.VIEWSTOR_ALLOW_ADD_CONNECTION, fileContent);
}
