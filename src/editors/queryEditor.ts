import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { QueryFileManager } from '../services/queryFileManager';

const SCHEME = 'viewstor';

interface QueryEditorContext {
  connectionId: string;
  databaseName?: string;
}

// Map to track connectionId + databaseName for open documents
const connectionMap = new Map<string, QueryEditorContext>();

export class QueryEditorProvider {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly queryFileManager: QueryFileManager,
  ) {}

  async openNewQuery(connectionId: string, databaseName?: string) {
    const state = this.connectionManager.get(connectionId);
    if (!state) {
      throw new Error('Connection not found');
    }

    const uri = await this.queryFileManager.createTempQuery(connectionId, databaseName);
    connectionMap.set(uri.toString(), { connectionId, databaseName });
  }

  getConnectionIdFromUri(uri: vscode.Uri): string | undefined {
    const mapped = connectionMap.get(uri.toString());
    if (mapped) return mapped.connectionId;

    const meta = this.resolveMetadata(uri);
    return meta?.connectionId;
  }

  getDatabaseNameFromUri(uri: vscode.Uri): string | undefined {
    const mapped = connectionMap.get(uri.toString());
    if (mapped) return mapped.databaseName;

    const meta = this.resolveMetadata(uri);
    return meta?.databaseName;
  }

  /**
   * Resolve metadata from an open document or from disk.
   * Works for viewstor query files AND any .sql file with a viewstor metadata header.
   * Caches the result in connectionMap for subsequent lookups.
   */
  private resolveMetadata(uri: vscode.Uri): { connectionId: string; databaseName?: string } | undefined {
    // Try open document first (covers the active editor case)
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc && doc.lineCount > 0) {
      const meta = this.queryFileManager.parseMetadata(doc);
      if (meta) {
        connectionMap.set(uri.toString(), meta);
        return meta;
      }
    }

    // Try reading from disk (covers reopened files not yet in textDocuments)
    if (uri.scheme === 'file') {
      const meta = this.queryFileManager.parseMetadataFromFile(uri.fsPath);
      if (meta) {
        connectionMap.set(uri.toString(), meta);
        return meta;
      }
    }

    // Legacy: check viewstor: scheme query params
    if (uri.scheme === SCHEME) {
      const params = new URLSearchParams(uri.query);
      const connectionId = params.get('connectionId');
      if (connectionId) return { connectionId };
    }
    return undefined;
  }

  /** Register a URI in the connection map (used by external callers) */
  setConnectionForUri(uri: vscode.Uri, connectionId: string, databaseName?: string) {
    connectionMap.set(uri.toString(), { connectionId, databaseName });
  }

  /** Remove a URI from the connection map */
  removeConnectionForUri(uri: vscode.Uri) {
    connectionMap.delete(uri.toString());
  }

  /** Update connection map when a file is renamed (pinned) */
  handleFileRenamed(oldUri: vscode.Uri, newUri: vscode.Uri) {
    const ctx = connectionMap.get(oldUri.toString());
    if (ctx) {
      connectionMap.delete(oldUri.toString());
      connectionMap.set(newUri.toString(), ctx);
    }
  }
}

export class QueryDocumentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(_uri: vscode.Uri): string {
    return '-- Write your query here\n';
  }
}
