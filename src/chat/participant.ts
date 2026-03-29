import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/connectionManager';
import { QueryEditorProvider } from '../editors/queryEditor';
import { SchemaObject } from '../types/schema';

const PARTICIPANT_ID = 'viewstor.chat';

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  queryEditorProvider: QueryEditorProvider,
) {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    const connectionId = resolveConnectionId(connectionManager, queryEditorProvider);

    if (!connectionId) {
      stream.markdown(vscode.l10n.t('No active database connection. Connect to a database first, or open a query tab.'));
      return;
    }

    const state = connectionManager.get(connectionId);
    if (!state) return;

    // Auto-connect if needed
    let driver = connectionManager.getDriver(connectionId);
    if (!driver) {
      try {
        await connectionManager.connect(connectionId);
        driver = connectionManager.getDriver(connectionId);
      } catch (err) {
        stream.markdown(vscode.l10n.t('Connection failed: {0}', err instanceof Error ? err.message : String(err)));
        return;
      }
    }
    if (!driver) return;

    // Build schema context
    const schemaContext = await buildSchemaContext(driver, state.config.database);

    const command = request.command;

    if (command === 'schema') {
      stream.markdown(schemaContext || vscode.l10n.t('No schema information available.'));
      return;
    }

    if (command === 'describe') {
      const tableName = request.prompt.trim();
      if (!tableName) {
        stream.markdown(vscode.l10n.t('Specify a table name. Example: `@viewstor /describe users`'));
        return;
      }
      try {
        const info = await driver.getTableInfo(tableName);
        let md = `### ${tableName}\n\n`;
        md += '| Column | Type | Nullable | PK | Default |\n|---|---|---|---|---|\n';
        for (const col of info.columns) {
          md += `| ${col.name} | ${col.dataType} | ${col.nullable ? 'YES' : 'NO'} | ${col.isPrimaryKey ? 'PK' : ''} | ${col.defaultValue || ''} |\n`;
        }
        stream.markdown(md);
      } catch (err) {
        stream.markdown(vscode.l10n.t('Failed to describe table: {0}', err instanceof Error ? err.message : String(err)));
      }
      return;
    }

    // Default: forward to LLM with schema context as system prompt
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(buildSystemPrompt(state.config.type, state.config.database, schemaContext, state.config.readonly)),
      ...chatContext.history.flatMap(turn => {
        if (turn instanceof vscode.ChatResponseTurn) {
          const parts: string[] = [];
          for (const part of turn.response) {
            if (part instanceof vscode.ChatResponseMarkdownPart) {
              parts.push(part.value.value);
            }
          }
          return parts.length > 0 ? [vscode.LanguageModelChatMessage.Assistant(parts.join(''))] : [];
        } else if (turn instanceof vscode.ChatRequestTurn) {
          return [vscode.LanguageModelChatMessage.User(turn.prompt)];
        }
        return [];
      }),
      vscode.LanguageModelChatMessage.User(request.prompt),
    ];

    try {
      const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      const model = models[0];
      if (!model) {
        // Fallback to any available model
        const allModels = await vscode.lm.selectChatModels();
        if (allModels.length === 0) {
          stream.markdown(vscode.l10n.t('No language model available. Make sure GitHub Copilot is installed and signed in.'));
          return;
        }
        const response = await allModels[0].sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
          stream.markdown(chunk);
        }
        return;
      }
      const response = await model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        stream.markdown(chunk);
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        stream.markdown(vscode.l10n.t('Language model error: {0}', err.message));
      } else {
        throw err;
      }
    }
  });

  participant.iconPath = new vscode.ThemeIcon('database');

  context.subscriptions.push(participant);
}

function resolveConnectionId(
  connectionManager: ConnectionManager,
  queryEditorProvider: QueryEditorProvider,
): string | undefined {
  // 1. Try active editor
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const id = queryEditorProvider.getConnectionIdFromUri(editor.document.uri);
    if (id) return id;
  }

  // 2. Fall back to first connected connection
  const all = connectionManager.getAll();
  const connected = all.find(s => s.connected);
  if (connected) return connected.config.id;

  // 3. Fall back to first connection
  if (all.length > 0) return all[0].config.id;

  return undefined;
}

async function buildSchemaContext(
  driver: { getSchema(): Promise<SchemaObject[]> },
  database?: string,
): Promise<string> {
  try {
    const schema = await driver.getSchema();
    const lines: string[] = [];

    for (const obj of schema) {
      if (obj.type === 'schema' || obj.type === 'database') {
        lines.push(`\n## ${obj.type}: ${obj.name}`);
        if (obj.children) {
          for (const child of obj.children) {
            if (child.type === 'table' || child.type === 'view') {
              const cols = child.children
                ?.filter(c => c.type === 'column')
                .map(c => `${c.name} ${c.detail || ''}`.trim())
                .join(', ');
              lines.push(`- ${child.type} **${child.name}**(${cols || '...'})`);
            }
          }
        }
      } else if (obj.type === 'table' || obj.type === 'view') {
        const cols = obj.children
          ?.filter(c => c.type === 'column')
          .map(c => `${c.name} ${c.detail || ''}`.trim())
          .join(', ');
        lines.push(`- ${obj.type} **${obj.name}**(${cols || '...'})`);
      }
    }

    if (lines.length === 0) return '';
    return `### Database: ${database || 'default'}\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

function buildSystemPrompt(dbType: string, database: string | undefined, schemaContext: string, readonly?: boolean): string {
  return [
    `You are a database assistant for a ${dbType} database${database ? ` "${database}"` : ''}.`,
    readonly ? 'This connection is READ-ONLY. Only generate SELECT/EXPLAIN queries.' : '',
    'Answer questions about the schema, write SQL queries, explain relationships, and suggest optimizations.',
    'Always use the exact table and column names from the schema below.',
    'Format SQL in code blocks with ```sql syntax.',
    '',
    schemaContext || 'No schema loaded.',
  ].filter(Boolean).join('\n');
}
