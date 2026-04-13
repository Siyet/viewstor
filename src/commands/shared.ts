import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { ConnectionTreeProvider } from '../views/connectionTree';
import { QueryHistoryProvider } from '../views/queryHistory';
import { QueryEditorProvider } from '../editors/queryEditor';
import { ResultPanelManager } from '../views/resultPanel';
import { ChartPanelManager } from '../chart/chartPanel';
import { ConnectionFormPanel } from '../views/connectionForm';
import { FolderFormPanel } from '../views/folderForm';
import { TempFileManager } from '../services/tempFileManager';
import { QueryFileManager } from '../services/queryFileManager';
import { DiffPanelManager } from '../diff/diffPanel';
import { splitStatements, firstSqlTokenOffset } from '../utils/queryHelpers';

export interface CommandContext {
  connectionManager: ConnectionManager;
  connectionTreeProvider: ConnectionTreeProvider;
  queryHistoryProvider: QueryHistoryProvider;
  queryEditorProvider: QueryEditorProvider;
  resultPanelManager: ResultPanelManager;
  chartPanelManager: ChartPanelManager;
  connectionFormPanel: ConnectionFormPanel;
  folderFormPanel: FolderFormPanel;
  outputChannel: vscode.LogOutputChannel;
  tempFileManager: TempFileManager;
  queryFileManager: QueryFileManager;
  diffPanelManager: DiffPanelManager;
}

// --- Shared mutable state ---

export let queryResultCounter = 0;
export function incrementQueryResultCounter(): number {
  return ++queryResultCounter;
}

export const historyDocMap = new Map<string, string>(); // entry.id -> doc URI

let _outputChannel: vscode.LogOutputChannel;
export function setOutputChannel(channel: vscode.LogOutputChannel) {
  _outputChannel = channel;
}
export function getOutputChannel(): vscode.LogOutputChannel {
  return _outputChannel;
}

// --- Query result CodeLens + gutter icons ---

export interface QueryResultInfo {
  line: number;
  text: string;
  isError: boolean;
  timestamp: string;
}

export const queryResults = new Map<string, QueryResultInfo[]>();
let codeLensEmitter: vscode.EventEmitter<void>;

export function setCodeLensEmitter(emitter: vscode.EventEmitter<void>) {
  codeLensEmitter = emitter;
}
export function fireCodeLens() {
  codeLensEmitter.fire();
}

// --- CodeLens provider ---

export class QueryCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    setCodeLensEmitter(this._onDidChangeCodeLenses);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const results = queryResults.get(document.uri.toString()) || [];

    const fullText = document.getText();
    const firstLine = document.lineAt(0).text;
    const hasMetadata = firstLine.startsWith('-- viewstor:');
    const statementsText = hasMetadata
      ? fullText.substring(fullText.indexOf('\n') + 1)
      : fullText;
    const metadataOffset = fullText.length - statementsText.length;

    const stmts = splitStatements(statementsText);
    for (const stmt of stmts) {
      const rawContent = statementsText.substring(stmt.start, stmt.end);
      const sqlOffset = firstSqlTokenOffset(rawContent);
      const stmtLine = document.positionAt(stmt.start + metadataOffset + sqlOffset).line;
      const range = new vscode.Range(stmtLine, 0, stmtLine, 0);

      const result = results.find(r => r.line === stmtLine);
      if (result) {
        const icon = result.isError ? '$(error)' : '$(check)';
        lenses.push(new vscode.CodeLens(range, {
          title: `${icon} ${result.timestamp}  ${result.text}`,
          command: 'viewstor._showOutputChannel',
          tooltip: vscode.l10n.t('Show query log'),
        }));
        lenses.push(new vscode.CodeLens(range, {
          title: '$(play)  Rerun Query',
          command: 'viewstor._runStatementAtLine',
          arguments: [stmtLine],
          tooltip: vscode.l10n.t('Re-run this statement'),
        }));
      } else {
        lenses.push(new vscode.CodeLens(range, {
          title: '$(play)  Run Query',
          command: 'viewstor._runStatementAtLine',
          arguments: [stmtLine],
          tooltip: vscode.l10n.t('Execute this statement'),
        }));
      }
    }

    return lenses;
  }
}

// --- Gutter decorations ---

export const gutterDecoSuccess = vscode.window.createTextEditorDecorationType({
  gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#4ec9b0" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm3.35 4.65a.5.5 0 0 0-.7 0L7 9.3 5.35 7.65a.5.5 0 1 0-.7.7l2 2a.5.5 0 0 0 .7 0l4-4a.5.5 0 0 0 0-.7z"/></svg>'
  )),
  gutterIconSize: '80%',
});

export const gutterDecoError = vscode.window.createTextEditorDecorationType({
  gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#f44747" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm2.65 3.65a.5.5 0 0 0-.7 0L8 6.59 6.05 4.65a.5.5 0 1 0-.7.7L7.29 7.3 5.35 9.25a.5.5 0 1 0 .7.7L8 8.01l1.95 1.94a.5.5 0 0 0 .7-.7L8.71 7.3l1.94-1.95a.5.5 0 0 0 0-.7z"/></svg>'
  )),
  gutterIconSize: '80%',
});

// --- Helper functions ---

function formatTimestamp(): string {
  const now = new Date();
  const pad = (num: number, len = 2) => String(num).padStart(len, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

export function updateGutterIcons(editor: vscode.TextEditor) {
  const results = queryResults.get(editor.document.uri.toString()) || [];
  const successRanges: vscode.Range[] = [];
  const errorRanges: vscode.Range[] = [];
  for (const result of results) {
    const range = new vscode.Range(result.line, 0, result.line, 0);
    if (result.isError) {
      errorRanges.push(range);
    } else {
      successRanges.push(range);
    }
  }
  editor.setDecorations(gutterDecoSuccess, successRanges);
  editor.setDecorations(gutterDecoError, errorRanges);
}

export function clearQueryDecorations(editor: vscode.TextEditor) {
  editor.setDecorations(gutterDecoSuccess, []);
  editor.setDecorations(gutterDecoError, []);
}

export function showQueryResult(editor: vscode.TextEditor, line: number, resultText: string, isError: boolean) {
  const ts = formatTimestamp();
  const docUri = editor.document.uri.toString();

  let results = queryResults.get(docUri);
  if (!results) {
    results = [];
    queryResults.set(docUri, results);
  }
  const existing = results.findIndex(r => r.line === line);
  const info: QueryResultInfo = { line, text: resultText, isError, timestamp: ts };
  if (existing >= 0) {
    results[existing] = info;
  } else {
    results.push(info);
  }

  updateGutterIcons(editor);
  fireCodeLens();
}

export function logQueryToOutput(sql: string, resultText: string, isError: boolean) {
  const shortSql = sql.replace(/\s+/g, ' ').trim();
  _outputChannel.info(shortSql);
  if (isError) {
    _outputChannel.error(resultText);
  } else {
    _outputChannel.info(resultText);
  }
  _outputChannel.info('────────────────────────────────────────');
}

export function logAndShowError(message: string) {
  _outputChannel.error(message);
  vscode.window.showErrorMessage(message);
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
