import * as fs from 'fs';
import * as path from 'path';

export const METADATA_PREFIX = '-- viewstor:';

export interface QueryFileMetadata {
  connectionId: string;
  databaseName?: string;
}

/** Build a metadata comment line for embedding in .sql files */
export function buildMetadataComment(connectionId: string, databaseName?: string): string {
  const params = new URLSearchParams();
  params.set('connectionId', connectionId);
  if (databaseName) params.set('database', databaseName);
  return `${METADATA_PREFIX}${params.toString()}`;
}

/** Parse metadata from a comment line string */
export function parseMetadataFromLine(line: string): QueryFileMetadata | undefined {
  if (!line.startsWith(METADATA_PREFIX)) return undefined;
  const paramStr = line.substring(METADATA_PREFIX.length);
  const params = new URLSearchParams(paramStr);
  const connectionId = params.get('connectionId');
  if (!connectionId) return undefined;
  return {
    connectionId,
    databaseName: params.get('database') || undefined,
  };
}

/** Parse metadata from a file on disk (sync, reads only first line) */
export function parseMetadataFromFile(filePath: string): QueryFileMetadata | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf-8').split('\n')[0];
    return parseMetadataFromLine(firstLine);
  } catch {
    return undefined;
  }
}

/** Strip the metadata comment from full file content, returning only query text */
export function stripMetadataFromContent(content: string): string {
  const newlineIdx = content.indexOf('\n');
  if (newlineIdx === -1) {
    return content.startsWith(METADATA_PREFIX) ? '' : content;
  }
  const firstLine = content.substring(0, newlineIdx);
  if (firstLine.startsWith(METADATA_PREFIX)) {
    return content.substring(newlineIdx + 1);
  }
  return content;
}

/** Check if a file path is under a given directory (cross-platform) */
export function isUnderDir(filePath: string, dir: string): boolean {
  let normalized = filePath.replace(/\\/g, '/');
  let dirNormalized = dir.replace(/\\/g, '/');
  if (!dirNormalized.endsWith('/')) dirNormalized += '/';
  // Windows: vscode.Uri.file() lowercases the drive letter, os.homedir() uppercases it
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
    dirNormalized = dirNormalized.toLowerCase();
  }
  return normalized.startsWith(dirNormalized);
}

/** Build a query file content with metadata header */
export function buildQueryFileContent(connectionId: string, databaseName: string | undefined, sql: string): string {
  return buildMetadataComment(connectionId, databaseName) + '\n' + sql;
}

/** List .sql files in a directory with their parsed metadata */
export function listSqlFiles(dir: string): { name: string; filePath: string; metadata?: QueryFileMetadata }[] {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
    return files.map(f => {
      const filePath = path.join(dir, f);
      return {
        name: f,
        filePath,
        metadata: parseMetadataFromFile(filePath),
      };
    });
  } catch {
    return [];
  }
}
