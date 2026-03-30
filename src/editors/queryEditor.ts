import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';

const SCHEME = 'viewstor';

interface QueryEditorContext {
  connectionId: string;
  databaseName?: string;
}

// Map to track connectionId + databaseName for untitled documents
const connectionMap = new Map<string, QueryEditorContext>();

export class QueryEditorProvider {
  private queryCounter = 0;

  constructor(private readonly connectionManager: ConnectionManager) {}

  async openNewQuery(connectionId: string, databaseName?: string) {
    const state = this.connectionManager.get(connectionId);
    if (!state) {
      throw new Error('Connection not found');
    }

    this.queryCounter++;

    // Use untitled document (editable) instead of virtual scheme (read-only)
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: '-- Write your query here\n',
    });

    // Track connection by document URI
    connectionMap.set(doc.uri.toString(), { connectionId, databaseName });

    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
  }

  getConnectionIdFromUri(uri: vscode.Uri): string | undefined {
    const mapped = connectionMap.get(uri.toString());
    if (mapped) return mapped.connectionId;

    // Legacy: check viewstor: scheme query params
    if (uri.scheme === SCHEME) {
      const params = new URLSearchParams(uri.query);
      return params.get('connectionId') || undefined;
    }
    return undefined;
  }

  getDatabaseNameFromUri(uri: vscode.Uri): string | undefined {
    return connectionMap.get(uri.toString())?.databaseName;
  }
}

export class QueryDocumentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(_uri: vscode.Uri): string {
    return '-- Write your query here\n';
  }
}
