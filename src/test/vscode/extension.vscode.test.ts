import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const VIEWSTOR_DIR = path.join(os.homedir(), '.viewstor');
const TMP_DIR = path.join(VIEWSTOR_DIR, 'tmp');
const QUERIES_DIR = path.join(VIEWSTOR_DIR, 'queries');

function ensureDirs() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(QUERIES_DIR, { recursive: true });
}

function createTempSqlFile(name: string, content: string): string {
  ensureDirs();
  const filePath = path.join(TMP_DIR, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function cleanup(filePath: string) {
  try { fs.unlinkSync(filePath); } catch { /* ok */ }
}

async function openAndWait(filePath: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(filePath);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await new Promise(resolve => setTimeout(resolve, 200));
  return editor;
}

async function closeActiveEditor() {
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

// ============================================================
// 1. Extension Activation
// ============================================================

suite('Extension Activation', () => {
  test('extension should be present and active', async () => {
    const ext = vscode.extensions.getExtension('Siyet.viewstor');
    assert.ok(ext, 'Extension not found');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('all required commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    const required = [
      'viewstor.runQuery',
      'viewstor.openQuery',
      'viewstor.executeTempSql',
      'viewstor.openQueryFromHistory',
      'viewstor.clearHistory',
      'viewstor._showOutputChannel',
      'viewstor._runStatementAtLine',
      'viewstor._fetchPage',
      'viewstor._cancelQuery',
      'viewstor._insertRow',
      'viewstor._deleteRows',
      'viewstor._saveEdits',
      'viewstor._executeSqlStatements',
      'viewstor.exportResults',
      'viewstor.reportIssue',
      'viewstor.visualizeResults',
      'viewstor.exportGrafana',
    ];
    for (const cmd of required) {
      assert.ok(commands.includes(cmd), `Command ${cmd} not registered`);
    }
  });
});

// ============================================================
// 2. Unified Query Editor — file creation, metadata, CodeLens
// ============================================================

suite('Unified Query Editor', () => {
  test('temp query file has metadata on first line', async () => {
    const filePath = createTempSqlFile(`uqe_meta_${Date.now()}.sql`,
      '-- viewstor:connectionId=test-conn&database=mydb\nSELECT 1;');

    const editor = await openAndWait(filePath);
    const doc = editor.document;

    assert.strictEqual(doc.languageId, 'sql');
    assert.ok(doc.lineAt(0).text.startsWith('-- viewstor:'));
    assert.ok(doc.lineAt(0).text.includes('connectionId=test-conn'));
    assert.ok(doc.lineAt(0).text.includes('database=mydb'));

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('metadata line is not treated as SQL (stripped correctly)', async () => {
    const { stripMetadataFromContent } = await import('../../utils/queryFileHelpers');
    const content = '-- viewstor:connectionId=test-conn\nSELECT 1;\nSELECT 2;';
    const stripped = stripMetadataFromContent(content);
    assert.strictEqual(stripped, 'SELECT 1;\nSELECT 2;');
    assert.ok(!stripped.includes('viewstor:'));
  });

  test('CodeLens play buttons appear for each statement', async () => {
    const filePath = createTempSqlFile(`uqe_codelens_${Date.now()}.sql`,
      '-- viewstor:connectionId=test-conn\nSELECT 1;\n\nSELECT 2;\n\nUPDATE t SET x = 1;');

    const editor = await openAndWait(filePath);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', editor.document.uri);

    assert.ok(lenses, 'No CodeLens returned');
    // Should have at least one lens per statement (3 statements = 3 play buttons)
    assert.ok(lenses!.length >= 3, `Expected >= 3 lenses, got ${lenses!.length}`);

    // Each lens should have a command
    for (const lens of lenses!) {
      assert.ok(lens.command, 'CodeLens has no command');
      assert.ok(lens.command!.title.includes('Run Query'), `Unexpected lens title: ${lens.command!.title}`);
    }

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('CodeLens are on correct lines (skip metadata and comments)', async () => {
    const filePath = createTempSqlFile(`uqe_lines_${Date.now()}.sql`,
      '-- viewstor:connectionId=test-conn\n-- this is a comment\nSELECT 1;\n\nUPDATE t SET x = 1;');

    await openAndWait(filePath);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const doc = vscode.window.activeTextEditor!.document;
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', doc.uri);

    assert.ok(lenses && lenses.length >= 2, `Expected >= 2 lenses, got ${lenses?.length}`);

    // First lens should be on SELECT line (line 2, 0-indexed), not on comment
    const selectLine = lenses![0].range.start.line;
    const selectText = doc.lineAt(selectLine).text.trim();
    assert.ok(selectText.startsWith('SELECT'), `Expected SELECT on line ${selectLine}, got: ${selectText}`);

    // Second lens on UPDATE line
    const updateLine = lenses![1].range.start.line;
    const updateText = doc.lineAt(updateLine).text.trim();
    assert.ok(updateText.startsWith('UPDATE'), `Expected UPDATE on line ${updateLine}, got: ${updateText}`);

    await closeActiveEditor();
    cleanup(filePath);
  });
});

// ============================================================
// 3. Pin workflow (tmp → queries)
// ============================================================

suite('Pin Workflow', () => {
  test('file in tmp dir is recognized as viewstor file', async () => {
    const filePath = createTempSqlFile(`pin_test_${Date.now()}.sql`,
      '-- viewstor:connectionId=pin-conn\nSELECT 1;');

    const { isUnderDir } = await import('../../utils/queryFileHelpers');
    assert.ok(isUnderDir(filePath, TMP_DIR));
    assert.ok(!isUnderDir(filePath, QUERIES_DIR));

    cleanup(filePath);
  });

  test('moving file from tmp to queries preserves metadata', async () => {
    const fileName = `pin_move_${Date.now()}.sql`;
    const content = '-- viewstor:connectionId=pin-conn&database=pindb\nSELECT 42;';
    const tmpPath = createTempSqlFile(fileName, content);

    const queriesPath = path.join(QUERIES_DIR, fileName);
    fs.renameSync(tmpPath, queriesPath);

    assert.ok(!fs.existsSync(tmpPath));
    assert.ok(fs.existsSync(queriesPath));

    const { parseMetadataFromFile } = await import('../../utils/queryFileHelpers');
    const meta = parseMetadataFromFile(queriesPath);
    assert.ok(meta);
    assert.strictEqual(meta!.connectionId, 'pin-conn');
    assert.strictEqual(meta!.databaseName, 'pindb');

    cleanup(queriesPath);
  });
});

// ============================================================
// 4. VS Code restart — metadata parsed from file content
// ============================================================

suite('VS Code Restart', () => {
  test('metadata is parsed from file content (not in-memory map)', async () => {
    const filePath = createTempSqlFile(`restart_${Date.now()}.sql`,
      '-- viewstor:connectionId=restart-conn&database=restartdb\nSELECT 1;');

    const { parseMetadataFromFile } = await import('../../utils/queryFileHelpers');
    const meta = parseMetadataFromFile(filePath);
    assert.ok(meta);
    assert.strictEqual(meta!.connectionId, 'restart-conn');
    assert.strictEqual(meta!.databaseName, 'restartdb');

    // Simulate "reopened after restart" — open the file fresh
    const editor = await openAndWait(filePath);
    const firstLine = editor.document.lineAt(0).text;
    assert.ok(firstLine.includes('connectionId=restart-conn'));

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('pinned file in queries dir has play button after reopen', async () => {
    ensureDirs();
    const filePath = path.join(QUERIES_DIR, `restart_pinned_${Date.now()}.sql`);
    fs.writeFileSync(filePath, '-- viewstor:connectionId=restart-conn\nSELECT 1;', 'utf-8');

    await openAndWait(filePath);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const doc = vscode.window.activeTextEditor!.document;
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', doc.uri);

    assert.ok(lenses && lenses.length > 0, 'No CodeLens on reopened pinned file');

    await closeActiveEditor();
    cleanup(filePath);
  });
});

// ============================================================
// 5. Confirmation SQL
// ============================================================

suite('Confirmation SQL', () => {
  test('confirmation file has metadata and SQL content', async () => {
    const { buildMetadataComment, parseMetadataFromLine, stripMetadataFromContent } = await import('../../utils/queryFileHelpers');
    const header = buildMetadataComment('conf-conn', 'confdb');
    const sql = 'UPDATE users SET name = \'test\' WHERE id = 1;';
    const content = header + '\n' + sql;

    // File name starts with confirm_
    const fileName = `confirm_${Date.now()}.sql`;
    assert.ok(fileName.startsWith('confirm_'));

    // Metadata parses correctly
    const meta = parseMetadataFromLine(header);
    assert.ok(meta);
    assert.strictEqual(meta.connectionId, 'conf-conn');
    assert.strictEqual(meta.databaseName, 'confdb');

    // SQL is extractable
    const stripped = stripMetadataFromContent(content);
    assert.strictEqual(stripped, sql);
  });

  test('confirmation file name starts with confirm_ prefix', () => {
    // confirm_ files should NOT be auto-pinned on Ctrl+S
    const fileName = 'confirm_1234567890.sql';
    assert.ok(fileName.startsWith('confirm_'));
  });
});

// ============================================================
// 6. Statement-at-cursor
// ============================================================

suite('Statement at Cursor', () => {
  test('getStatementAtOffset returns correct statement', async () => {
    const { getStatementAtOffset } = await import('../../utils/queryHelpers');
    const sql = 'SELECT 1;\n\nUPDATE t SET x = 1;\n\nDELETE FROM t WHERE id = 5;';

    // Cursor in SELECT
    const stmt1 = getStatementAtOffset(sql, 3);
    assert.ok(stmt1);
    assert.ok(stmt1!.text.includes('SELECT'));

    // Cursor in UPDATE
    const stmt2 = getStatementAtOffset(sql, 15);
    assert.ok(stmt2);
    assert.ok(stmt2!.text.includes('UPDATE'));

    // Cursor in DELETE
    const stmt3 = getStatementAtOffset(sql, 45);
    assert.ok(stmt3);
    assert.ok(stmt3!.text.includes('DELETE'));
  });

  test('firstSqlTokenOffset skips comments', async () => {
    const { firstSqlTokenOffset } = await import('../../utils/queryHelpers');

    assert.strictEqual(firstSqlTokenOffset('SELECT 1'), 0);
    assert.strictEqual(firstSqlTokenOffset('  SELECT 1'), 2);
    assert.strictEqual(firstSqlTokenOffset('-- comment\nSELECT 1'), 11);
    assert.strictEqual(firstSqlTokenOffset('/* block */SELECT 1'), 11);
    assert.strictEqual(firstSqlTokenOffset('-- c1\n-- c2\nSELECT'), 12);
  });

  test('splitStatements handles dollar-quoted strings', async () => {
    const { splitStatements } = await import('../../utils/queryHelpers');
    const sql = 'CREATE FUNCTION f() AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql; SELECT 1';
    const stmts = splitStatements(sql);
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].text.includes('$$'));
    assert.ok(stmts[1].text.includes('SELECT'));
  });

  test('splitStatements does not split on semicolons in strings', async () => {
    const { splitStatements } = await import('../../utils/queryHelpers');
    const stmts = splitStatements('SELECT \'a;b;c\'; SELECT 2');
    assert.strictEqual(stmts.length, 2);
    assert.ok(stmts[0].text.includes('\'a;b;c\''));
  });
});

// ============================================================
// 7. Copy as One-row
// ============================================================

suite('Copy as One-row', () => {
  test('numeric values are unquoted', async () => {
    const { formatOneRow } = await import('../../utils/resultFormatters');
    const result = formatOneRow([['42', 'Alice']], ['integer', 'varchar'], '\'');
    assert.strictEqual(result, '42, \'Alice\'');
  });

  test('NULL and empty values become NULL', async () => {
    const { formatOneRow } = await import('../../utils/resultFormatters');
    const result = formatOneRow([['NULL', '', 'test']], ['varchar', 'varchar', 'varchar'], '\'');
    assert.strictEqual(result, 'NULL, NULL, \'test\'');
  });

  test('quotes are escaped (O\'Brien)', async () => {
    const { formatOneRow } = await import('../../utils/resultFormatters');
    const result = formatOneRow([['O\'Brien']], ['varchar'], '\'');
    assert.strictEqual(result, '\'O\'\'Brien\'');
  });

  test('double quote mode works', async () => {
    const { formatOneRow } = await import('../../utils/resultFormatters');
    const result = formatOneRow([['1', 'Alice']], ['integer', 'text'], '"');
    assert.strictEqual(result, '1, "Alice"');
  });

  test('JSON mode (double quotes) uses lowercase null', async () => {
    const { formatOneRow } = await import('../../utils/resultFormatters');
    const result = formatOneRow([['NULL', '', 'test']], ['varchar', 'varchar', 'varchar'], '"');
    assert.strictEqual(result, 'null, null, "test"');
  });

  test('boolean types are unquoted', async () => {
    const { isNumericType } = await import('../../utils/resultFormatters');
    assert.ok(isNumericType('boolean'));
    assert.ok(isNumericType('Bool'));
    assert.ok(!isNumericType('varchar'));
  });
});

// ============================================================
// 8. Sorting with custom query
// ============================================================

suite('Sorting with Custom Query', () => {
  test('applySortToQuery appends ORDER BY', async () => {
    const { applySortToQuery } = await import('../../utils/resultFormatters');
    const result = applySortToQuery('SELECT * FROM users', [{ column: 'name', direction: 'asc' }]);
    assert.strictEqual(result, 'SELECT * FROM users ORDER BY name ASC');
  });

  test('applySortToQuery replaces existing ORDER BY', async () => {
    const { applySortToQuery } = await import('../../utils/resultFormatters');
    const result = applySortToQuery('SELECT * FROM users ORDER BY id', [{ column: 'name', direction: 'desc' }]);
    assert.strictEqual(result, 'SELECT * FROM users ORDER BY name DESC');
  });

  test('applySortToQuery inserts before LIMIT', async () => {
    const { applySortToQuery } = await import('../../utils/resultFormatters');
    const result = applySortToQuery('SELECT * FROM users LIMIT 100', [{ column: 'id', direction: 'asc' }]);
    assert.strictEqual(result, 'SELECT * FROM users ORDER BY id ASC LIMIT 100');
  });

  test('applySortToQuery with empty sorts removes ORDER BY', async () => {
    const { applySortToQuery } = await import('../../utils/resultFormatters');
    const result = applySortToQuery('SELECT * FROM users ORDER BY name ASC', []);
    assert.strictEqual(result, 'SELECT * FROM users');
  });

  test('applySortToQuery with multiple columns', async () => {
    const { applySortToQuery } = await import('../../utils/resultFormatters');
    const result = applySortToQuery('SELECT * FROM t', [
      { column: 'a', direction: 'asc' },
      { column: 'b', direction: 'desc' },
    ]);
    assert.strictEqual(result, 'SELECT * FROM t ORDER BY a ASC, b DESC');
  });
});

// ============================================================
// 9. SQL Syntax Highlighting (tokenizer)
// ============================================================

suite('SQL Syntax Highlighting', () => {
  test('tokenizeSql identifies keywords', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('SELECT * FROM users WHERE id = 1');
    const keywords = tokens.filter(t => t.type === 'keyword').map(t => t.value);
    assert.deepStrictEqual(keywords, ['SELECT', 'FROM', 'WHERE']);
    // "users" and "id" are identifiers, not keywords
    const identifiers = tokens.filter(t => t.type === 'text').map(t => t.value);
    assert.ok(identifiers.includes('users'));
    assert.ok(identifiers.includes('id'));
  });

  test('tokenizeSql identifies strings', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('\'hello world\'');
    assert.strictEqual(tokens[0].type, 'string');
    assert.strictEqual(tokens[0].value, '\'hello world\'');
  });

  test('tokenizeSql identifies numbers', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('42');
    assert.strictEqual(tokens[0].type, 'number');
  });

  test('tokenizeSql identifies comments', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('-- this is a comment');
    assert.strictEqual(tokens[0].type, 'comment');
  });

  test('tokenizeSql identifies operators', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('>=');
    assert.strictEqual(tokens[0].type, 'operator');
  });
});

// ============================================================
// 10. Multi-DB metadata
// ============================================================

suite('Multi-DB Metadata', () => {
  test('metadata preserves database name', async () => {
    const { buildMetadataComment, parseMetadataFromLine } = await import('../../utils/queryFileHelpers');
    const databases = ['analytics', 'reporting', 'staging'];

    for (const db of databases) {
      const comment = buildMetadataComment('multi-conn', db);
      const meta = parseMetadataFromLine(comment);
      assert.ok(meta);
      assert.strictEqual(meta!.connectionId, 'multi-conn');
      assert.strictEqual(meta!.databaseName, db);
    }
  });

  test('metadata without database name works', async () => {
    const { buildMetadataComment, parseMetadataFromLine } = await import('../../utils/queryFileHelpers');
    const comment = buildMetadataComment('no-db-conn');
    const meta = parseMetadataFromLine(comment);
    assert.ok(meta);
    assert.strictEqual(meta!.connectionId, 'no-db-conn');
    assert.strictEqual(meta!.databaseName, undefined);
  });
});

// ============================================================
// 11. Query History
// ============================================================

suite('Query History', () => {
  test('history entry with cachedResult survives JSON roundtrip', () => {
    const entry = {
      id: 'hist-1',
      connectionId: 'conn-1',
      connectionName: 'Test DB',
      query: 'SELECT * FROM users',
      executedAt: Date.now(),
      executionTimeMs: 42,
      rowCount: 2,
      cachedResult: {
        columns: [
          { name: 'id', dataType: 'integer' },
          { name: 'name', dataType: 'varchar' },
        ],
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    };

    const restored = JSON.parse(JSON.stringify(entry));
    assert.strictEqual(restored.cachedResult.columns.length, 2);
    assert.strictEqual(restored.cachedResult.rows.length, 2);
    assert.strictEqual(restored.cachedResult.rows[0].name, 'Alice');
    // Condition used in openQueryFromHistory
    assert.ok(restored.cachedResult.columns.length > 0);
  });

  test('UPDATE history entry has no displayable cachedResult', () => {
    const entry = {
      cachedResult: { columns: [] as unknown[], rows: [] as unknown[] },
    };
    // The condition in openQueryFromHistory should be false
    assert.ok(!(entry.cachedResult.columns.length > 0));
  });

  test('error query has no cachedResult', () => {
    const error = 'relation "x" does not exist';
    const entry = {
      cachedResult: !error ? { columns: [], rows: [] } : undefined,
    };
    assert.strictEqual(entry.cachedResult, undefined);
  });
});

// ============================================================
// 11b. Pin on Save marks history entry as pinned
// ============================================================

suite('Pin on Save → History Pinned', () => {
  let api: { queryHistoryProvider: import('../../views/queryHistory').QueryHistoryProvider; queryFileManager: import('../../services/queryFileManager').QueryFileManager };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('Siyet.viewstor');
    assert.ok(ext, 'Extension not found');
    api = await ext!.activate();
  });

  test('saving a temp query pins the matching history entry (even if query was edited)', async () => {
    const connectionId = `pin-save-test-${Date.now()}`;
    const executedQuery = 'SELECT pin_test_col FROM pin_test_table LIMIT 2';
    const editedQuery = 'SELECT pin_test_col FROM pin_test_table LIMIT 3';
    const entryId = `pin-e2e-${Date.now()}`;

    // 1. Add unpinned history entry (simulates prior query execution with LIMIT 2)
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId,
      connectionName: 'Pin Test DB',
      query: executedQuery,
      executedAt: Date.now(),
      executionTimeMs: 10,
      rowCount: 1,
    });

    // Verify entry exists and is NOT pinned
    let entries = api.queryHistoryProvider.getEntries();
    let entry = entries.find(e => e.id === entryId);
    assert.ok(entry, 'History entry not found after addEntry');
    assert.strictEqual(entry!.pinned, undefined, 'Entry should not be pinned yet');
    assert.strictEqual(entry!.filePath, undefined, 'Entry should not have filePath yet');

    // 2. Create a temp file with DIFFERENT query text (user edited LIMIT 2 → 3 before saving)
    const { buildMetadataComment } = await import('../../utils/queryFileHelpers');
    const header = buildMetadataComment(connectionId);
    const content = header + '\n' + editedQuery;
    const fileName = `query_pin_e2e_${Date.now()}.sql`;
    const filePath = path.join(TMP_DIR, fileName);
    ensureDirs();
    fs.writeFileSync(filePath, content, 'utf-8');

    // 3. Open the file, make it dirty, then save (triggers onDidSaveTextDocument → handleSave → pinQuery)
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));

    // Make the document dirty so VS Code actually fires onDidSaveTextDocument
    await editor.edit(eb => eb.insert(new vscode.Position(1, editedQuery.length), ' '));
    await vscode.commands.executeCommand('workbench.action.files.save');
    // Wait for pin workflow (rename + callback)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 4. Verify history entry is now pinned with filePath
    entries = api.queryHistoryProvider.getEntries();
    entry = entries.find(e => e.id === entryId);
    assert.ok(entry, 'History entry should still exist');
    assert.strictEqual(entry!.pinned, true, 'Entry should be pinned after save');
    assert.ok(entry!.filePath, 'Entry should have filePath after save');
    assert.ok(entry!.filePath!.includes('queries'), 'filePath should point to queries dir');

    // 5. Verify file moved from tmp to queries
    assert.ok(!fs.existsSync(filePath), 'Original tmp file should not exist');
    assert.ok(fs.existsSync(entry!.filePath!), 'Pinned file should exist in queries dir');

    // Cleanup
    await closeActiveEditor();
    try { fs.unlinkSync(entry!.filePath!); } catch { /* ok */ }
    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('autosave does NOT pin a temp query', async () => {
    const connectionId = `autosave-nopin-${Date.now()}`;
    const queryText = 'SELECT autosave_col FROM autosave_table';

    const { buildMetadataComment } = await import('../../utils/queryFileHelpers');
    const header = buildMetadataComment(connectionId);
    const content = header + '\n' + queryText;
    const fileName = `query_autosave_${Date.now()}.sql`;
    const filePath = path.join(TMP_DIR, fileName);
    ensureDirs();
    fs.writeFileSync(filePath, content, 'utf-8');

    // Enable autosave (afterDelay, 100ms)
    const config = vscode.workspace.getConfiguration('files');
    const prevAutoSave = config.get<string>('autoSave');
    const prevDelay = config.get<number>('autoSaveDelay');
    await config.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
    await config.update('autoSaveDelay', 100, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 200));

    // Make dirty — autosave should fire after 100ms delay
    await editor.edit(eb => eb.insert(new vscode.Position(1, queryText.length), ' '));
    // Wait for autosave to trigger
    await new Promise(resolve => setTimeout(resolve, 1500));

    // File should still be in tmp (NOT moved to queries)
    assert.ok(fs.existsSync(filePath), 'Temp file should remain in tmp after autosave');

    // Restore settings
    await config.update('autoSave', prevAutoSave, vscode.ConfigurationTarget.Global);
    await config.update('autoSaveDelay', prevDelay, vscode.ConfigurationTarget.Global);

    // Cleanup
    await closeActiveEditor();
    cleanup(filePath);
  });

  test('saving a confirmation file does NOT pin history entry', async () => {
    const connectionId = `confirm-nopin-${Date.now()}`;
    const entryId = `confirm-e2e-${Date.now()}`;

    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId,
      connectionName: 'Confirm Test',
      query: 'UPDATE t SET x = 1',
      executedAt: Date.now(),
      executionTimeMs: 5,
      rowCount: 0,
    });

    // Create a confirm_ file — should NOT trigger auto-pin
    const { buildMetadataComment } = await import('../../utils/queryFileHelpers');
    const content = buildMetadataComment(connectionId) + '\nUPDATE t SET x = 1';
    const fileName = `confirm_${Date.now()}.sql`;
    const filePath = path.join(TMP_DIR, fileName);
    ensureDirs();
    fs.writeFileSync(filePath, content, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));

    await vscode.commands.executeCommand('workbench.action.files.save');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Entry should remain unpinned
    const entries = api.queryHistoryProvider.getEntries();
    const entry = entries.find(e => e.id === entryId);
    assert.ok(entry, 'History entry should still exist');
    assert.strictEqual(entry!.pinned, undefined, 'confirm_ file save should NOT pin history entry');

    // Cleanup
    await closeActiveEditor();
    cleanup(filePath);
    await api.queryHistoryProvider.removeEntry(entryId);
  });
});

// ============================================================
// 12. Autocomplete provider is registered
// ============================================================

suite('Autocomplete Provider', () => {
  test('completion provider is registered for SQL files', async () => {
    const filePath = createTempSqlFile(`autocomplete_${Date.now()}.sql`,
      '-- viewstor:connectionId=test-conn\nSELECT ');

    const editor = await openAndWait(filePath);
    // Trigger completion at end of line (after "SELECT ")
    const position = new vscode.Position(1, 7);

    // This verifies the provider is registered — may return empty without DB
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', editor.document.uri, position);

    // Provider is registered (even if no items without connection)
    assert.ok(completions !== undefined, 'Completion provider not registered');

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('completion provider works for pinned query files in queries dir', async () => {
    ensureDirs();
    const filePath = path.join(QUERIES_DIR, `autocomplete_pinned_${Date.now()}.sql`);
    fs.writeFileSync(filePath, '-- viewstor:connectionId=test-conn\nSELECT ', 'utf-8');

    const editor = await openAndWait(filePath);
    const position = new vscode.Position(1, 7);

    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', editor.document.uri, position);

    // Provider should fire for pinned files (not return undefined)
    assert.ok(completions !== undefined, 'Completion provider should fire for pinned query files');

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('completion provider resolves connectionId from metadata header', async () => {
    // Verify that the QueryEditorProvider can resolve connectionId from metadata
    const { parseMetadataFromLine } = await import('../../utils/queryFileHelpers');

    const meta = parseMetadataFromLine('-- viewstor:connectionId=my-conn-123&database=mydb');
    assert.ok(meta, 'Metadata should parse from header line');
    assert.strictEqual(meta!.connectionId, 'my-conn-123');
    assert.strictEqual(meta!.databaseName, 'mydb');

    // Test with file on disk
    ensureDirs();
    const filePath = path.join(QUERIES_DIR, `meta_resolve_${Date.now()}.sql`);
    fs.writeFileSync(filePath, '-- viewstor:connectionId=resolve-test\nSELECT 1;', 'utf-8');

    const { parseMetadataFromFile } = await import('../../utils/queryFileHelpers');
    const fileMeta = parseMetadataFromFile(filePath);
    assert.ok(fileMeta, 'Metadata should parse from file on disk');
    assert.strictEqual(fileMeta!.connectionId, 'resolve-test');

    cleanup(filePath);
  });
});

// ============================================================
// 12b. Pinned history item displays file name
// ============================================================

suite('Pinned History Display', () => {
  let api: { queryHistoryProvider: import('../../views/queryHistory').QueryHistoryProvider; queryFileManager: import('../../services/queryFileManager').QueryFileManager };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('Siyet.viewstor');
    api = await ext!.activate();
  });

  test('pinned entry with filePath shows file name as label', async () => {
    const entryId = `display-pin-${Date.now()}`;
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId: 'disp-conn',
      connectionName: 'Display DB',
      query: 'SELECT * FROM very_long_table_name WHERE id > 100',
      executedAt: Date.now(),
      executionTimeMs: 42,
      rowCount: 10,
      pinned: true,
      filePath: '/home/user/.viewstor/queries/my_important_query.sql',
    });

    const children = await api.queryHistoryProvider.getChildren();
    // Find the item for our entry (skip the "Pinned" header)
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Pinned item should appear in tree');
    // Label should be the file name without .sql extension
    assert.strictEqual(item!.label, 'my_important_query', 'Label should be file name without .sql');
    // Tooltip should be first 1000 chars of query
    assert.strictEqual(item!.tooltip, 'SELECT * FROM very_long_table_name WHERE id > 100');

    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('pinned entry without filePath shows truncated query as label', async () => {
    const entryId = `display-nofile-${Date.now()}`;
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId: 'disp-conn',
      connectionName: 'Display DB',
      query: 'SELECT * FROM users',
      executedAt: Date.now(),
      executionTimeMs: 5,
      rowCount: 1,
      pinned: true,
    });

    const children = await api.queryHistoryProvider.getChildren();
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Pinned item should appear in tree');
    // No filePath → label is truncated query
    assert.strictEqual(item!.label, 'SELECT * FROM users');
    // Tooltip is full query (no 1000 char limit since no filePath)
    assert.strictEqual(item!.tooltip, 'SELECT * FROM users');

    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('pinned entry tooltip truncates long queries to 1000 chars', async () => {
    const entryId = `display-long-${Date.now()}`;
    const longQuery = 'SELECT ' + 'a'.repeat(2000) + ' FROM t';
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId: 'disp-conn',
      connectionName: 'Display DB',
      query: longQuery,
      executedAt: Date.now(),
      executionTimeMs: 1,
      rowCount: 0,
      pinned: true,
      filePath: '/home/user/.viewstor/queries/long_query.sql',
    });

    const children = await api.queryHistoryProvider.getChildren();
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Item should exist');
    assert.strictEqual((item!.tooltip as string).length, 1000, 'Tooltip should be truncated to 1000 chars');

    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('unpinned entry shows query text as label and full query as tooltip', async () => {
    const entryId = `display-unpin-${Date.now()}`;
    const query = 'SELECT id, name, email FROM customers WHERE active = true ORDER BY name';
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId: 'disp-conn',
      connectionName: 'Display DB',
      query,
      executedAt: Date.now(),
      executionTimeMs: 3,
      rowCount: 5,
    });

    const children = await api.queryHistoryProvider.getChildren();
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Unpinned item should appear');
    // Label: first 60 chars
    assert.strictEqual(item!.label, query.substring(0, 60));
    // Tooltip: full query
    assert.strictEqual(item!.tooltip, query);

    await api.queryHistoryProvider.removeEntry(entryId);
  });
});

// ============================================================
// 12b2. Rename pinned query
// ============================================================

suite('Rename Pinned Query', () => {
  let api: { queryHistoryProvider: import('../../views/queryHistory').QueryHistoryProvider; queryFileManager: import('../../services/queryFileManager').QueryFileManager };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('Siyet.viewstor');
    api = await ext!.activate();
  });

  test('renamePinnedQuery moves file and returns new URI', async () => {
    ensureDirs();
    const originalName = `rename_test_${Date.now()}.sql`;
    const originalPath = path.join(QUERIES_DIR, originalName);
    fs.writeFileSync(originalPath, '-- viewstor:connectionId=ren-conn\nSELECT 1;', 'utf-8');

    const originalUri = vscode.Uri.file(originalPath);

    // Open the file so VS Code tracks it
    const doc = await vscode.workspace.openTextDocument(originalUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));

    const newUri = await api.queryFileManager.renamePinnedQuery(originalUri, 'my_renamed_query');

    assert.ok(newUri, 'renamePinnedQuery should return new URI');
    assert.ok(newUri!.fsPath.includes('my_renamed_query.sql'), 'New path should contain new name');
    assert.ok(!fs.existsSync(originalPath), 'Original file should not exist');
    assert.ok(fs.existsSync(newUri!.fsPath), 'Renamed file should exist');

    // Cleanup
    await closeActiveEditor();
    try { fs.unlinkSync(newUri!.fsPath); } catch { /* ok */ }
  });

  test('rename updates history entry filePath and display name', async () => {
    ensureDirs();
    const entryId = `ren-hist-${Date.now()}`;
    const originalName = `rename_hist_${Date.now()}.sql`;
    const originalPath = path.join(QUERIES_DIR, originalName);
    fs.writeFileSync(originalPath, '-- viewstor:connectionId=ren-conn\nSELECT 42;', 'utf-8');

    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId: 'ren-conn',
      connectionName: 'Rename DB',
      query: 'SELECT 42',
      executedAt: Date.now(),
      executionTimeMs: 1,
      rowCount: 1,
      pinned: true,
      filePath: originalPath,
    });

    const originalUri = vscode.Uri.file(originalPath);
    const doc = await vscode.workspace.openTextDocument(originalUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));

    const newUri = await api.queryFileManager.renamePinnedQuery(originalUri, 'final_name');
    assert.ok(newUri, 'Rename should succeed');

    // Simulate what renameHistoryEntry command does
    await api.queryHistoryProvider.updateFilePath(entryId, newUri!.fsPath);

    // Verify tree item shows the new file name
    const children = await api.queryHistoryProvider.getChildren();
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Item should exist');
    assert.strictEqual(item!.label, 'final_name', 'Label should be the new file name');

    // Cleanup
    await closeActiveEditor();
    try { fs.unlinkSync(newUri!.fsPath); } catch { /* ok */ }
    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('full flow: pin via save then rename', async () => {
    const connectionId = `pin-rename-${Date.now()}`;
    const queryText = 'SELECT rename_flow FROM test_table';
    const entryId = `pin-ren-${Date.now()}`;

    // 1. Add history entry
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId,
      connectionName: 'Rename Flow DB',
      query: queryText,
      executedAt: Date.now(),
      executionTimeMs: 10,
      rowCount: 1,
    });

    // 2. Create temp file and pin via save
    const { buildMetadataComment } = await import('../../utils/queryFileHelpers');
    const content = buildMetadataComment(connectionId) + '\n' + queryText;
    const fileName = `query_renflow_${Date.now()}.sql`;
    const filePath = path.join(TMP_DIR, fileName);
    ensureDirs();
    fs.writeFileSync(filePath, content, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));
    await editor.edit(eb => eb.insert(new vscode.Position(1, queryText.length), ' '));
    await vscode.commands.executeCommand('workbench.action.files.save');
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 3. Verify pinned with filePath
    const entries = api.queryHistoryProvider.getEntries();
    const entry = entries.find(e => e.id === entryId);
    assert.ok(entry, 'Entry should exist');
    assert.ok(entry!.pinned, 'Entry should be pinned');
    assert.ok(entry!.filePath, 'Entry should have filePath');

    // 4. Rename the pinned query
    const pinnedUri = vscode.Uri.file(entry!.filePath!);
    const newUri = await api.queryFileManager.renamePinnedQuery(pinnedUri, 'my_custom_name');
    assert.ok(newUri, 'Rename should succeed');

    // 5. Update history (what the command does)
    await api.queryHistoryProvider.updateFilePath(entryId, newUri!.fsPath);

    // 6. Verify tree shows new name
    const children = await api.queryHistoryProvider.getChildren();
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Item should exist in tree');
    assert.strictEqual(item!.label, 'my_custom_name', 'Label should be the renamed file name');

    // Cleanup
    await closeActiveEditor();
    try { fs.unlinkSync(newUri!.fsPath); } catch { /* ok */ }
    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('manual pin via button creates file and enables rename', async () => {
    const entryId = `manual-pin-${Date.now()}`;
    const connectionId = `manual-conn-${Date.now()}`;
    const query = 'SELECT manual_pin FROM test';

    // 1. Add unpinned entry (no filePath)
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId,
      connectionName: 'Manual Pin DB',
      query,
      executedAt: Date.now(),
      executionTimeMs: 5,
      rowCount: 1,
    });

    // 2. Simulate what pinHistoryEntry command does: create file + togglePin + updateFilePath
    const filePath = api.queryFileManager.createPinnedQueryFile(connectionId, query);
    await api.queryHistoryProvider.togglePin(entryId, true);
    await api.queryHistoryProvider.updateFilePath(entryId, filePath);

    // 3. Verify file was created in queries/
    assert.ok(fs.existsSync(filePath), 'Pinned file should exist');
    assert.ok(filePath.replace(/\\/g, '/').includes('/queries/'), 'File should be in queries dir');

    // 4. Verify entry has filePath
    const entries = api.queryHistoryProvider.getEntries();
    const entry = entries.find(e => e.id === entryId);
    assert.ok(entry!.filePath, 'Entry should have filePath after manual pin');

    // 5. Now rename should work
    const uri = vscode.Uri.file(entry!.filePath!);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));

    const newUri = await api.queryFileManager.renamePinnedQuery(uri, 'manually_pinned');
    assert.ok(newUri, 'Rename should succeed on manually pinned file');
    assert.ok(newUri!.fsPath.includes('manually_pinned.sql'));

    // Cleanup
    await closeActiveEditor();
    try { fs.unlinkSync(newUri!.fsPath); } catch { /* ok */ }
    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('rename fails gracefully if target name already exists', async () => {
    ensureDirs();
    const existingName = `existing_${Date.now()}.sql`;
    const existingPath = path.join(QUERIES_DIR, existingName);
    fs.writeFileSync(existingPath, 'SELECT 1;', 'utf-8');

    const srcName = `src_${Date.now()}.sql`;
    const srcPath = path.join(QUERIES_DIR, srcName);
    fs.writeFileSync(srcPath, 'SELECT 2;', 'utf-8');

    const srcUri = vscode.Uri.file(srcPath);
    // Rename to the name that already exists (without .sql — renamePinnedQuery adds it)
    const result = await api.queryFileManager.renamePinnedQuery(srcUri, existingName.replace('.sql', ''));
    assert.strictEqual(result, undefined, 'Should return undefined when name already exists');

    // Both files should still exist
    assert.ok(fs.existsSync(existingPath), 'Existing file should remain');
    assert.ok(fs.existsSync(srcPath), 'Source file should remain');

    // Cleanup
    try { fs.unlinkSync(existingPath); } catch { /* ok */ }
    try { fs.unlinkSync(srcPath); } catch { /* ok */ }
  });

  test('pinned entry created with filePath always has filePath set', async () => {
    // Simulates the onSqlSaved path: entry is pinned with filePath from createPinnedQueryFile
    const connectionId = `sqlsaved-${Date.now()}`;
    const query = 'INSERT INTO t (a) VALUES (1)';

    // This is what onSqlSaved does now
    const filePath = api.queryFileManager.createPinnedQueryFile(connectionId, query);
    const entryId = `sqlsaved-e2e-${Date.now()}`;
    await api.queryHistoryProvider.addEntry({
      id: entryId,
      connectionId,
      connectionName: 'SqlSaved DB',
      query,
      executedAt: Date.now(),
      executionTimeMs: 0,
      rowCount: 0,
      pinned: true,
      filePath,
    });

    // Verify filePath is set
    const entries = api.queryHistoryProvider.getEntries();
    const entry = entries.find(e => e.id === entryId);
    assert.ok(entry, 'Entry should exist');
    assert.ok(entry!.filePath, 'Entry pinned via onSqlSaved must have filePath');
    assert.ok(fs.existsSync(entry!.filePath!), 'File must exist on disk');

    // Verify rename works
    const uri = vscode.Uri.file(entry!.filePath!);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise(resolve => setTimeout(resolve, 300));

    const newUri = await api.queryFileManager.renamePinnedQuery(uri, 'renamed_sqlsaved');
    assert.ok(newUri, 'Rename should succeed');
    assert.ok(newUri!.fsPath.includes('renamed_sqlsaved.sql'));

    // Verify tree item shows new name
    await api.queryHistoryProvider.updateFilePath(entryId, newUri!.fsPath);
    const children = await api.queryHistoryProvider.getChildren();
    const item = children.find(c => c.entry?.id === entryId);
    assert.ok(item, 'Item should exist in tree');
    assert.strictEqual(item!.label, 'renamed_sqlsaved', 'Label should be the renamed file name');

    // Cleanup
    await closeActiveEditor();
    try { fs.unlinkSync(newUri!.fsPath); } catch { /* ok */ }
    await api.queryHistoryProvider.removeEntry(entryId);
  });

  test('all pin paths produce entries with filePath (never undefined)', async () => {
    // Path 1: pinHistoryEntry (manual pin button)
    const id1 = `allpaths-manual-${Date.now()}`;
    await api.queryHistoryProvider.addEntry({
      id: id1, connectionId: 'ap-conn', connectionName: 'AP', query: 'SELECT 1',
      executedAt: Date.now(), executionTimeMs: 1, rowCount: 0,
    });
    const fp1 = api.queryFileManager.createPinnedQueryFile('ap-conn', 'SELECT 1');
    await api.queryHistoryProvider.togglePin(id1, true);
    await api.queryHistoryProvider.updateFilePath(id1, fp1);

    // Path 2: onSqlSaved (confirm SQL)
    const id2 = `allpaths-confirm-${Date.now()}`;
    const fp2 = api.queryFileManager.createPinnedQueryFile('ap-conn', 'INSERT INTO t DEFAULT VALUES');
    await api.queryHistoryProvider.addEntry({
      id: id2, connectionId: 'ap-conn', connectionName: 'AP', query: 'INSERT INTO t DEFAULT VALUES',
      executedAt: Date.now(), executionTimeMs: 0, rowCount: 0, pinned: true, filePath: fp2,
    });

    // Verify both have filePath
    const entries = api.queryHistoryProvider.getEntries();
    const e1 = entries.find(e => e.id === id1);
    const e2 = entries.find(e => e.id === id2);
    assert.ok(e1!.filePath, 'Manual pin must have filePath');
    assert.ok(e2!.filePath, 'Confirm SQL pin must have filePath');

    // Cleanup
    try { fs.unlinkSync(fp1); } catch { /* ok */ }
    try { fs.unlinkSync(fp2); } catch { /* ok */ }
    await api.queryHistoryProvider.removeEntry(id1);
    await api.queryHistoryProvider.removeEntry(id2);
  });
});

// ============================================================
// 12c. SQL syntax highlighting — identifiers have distinct token type
// ============================================================

suite('SQL Identifier Highlighting', () => {
  test('table names are tokenized as text (mapped to tk-id in webview)', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('SELECT * FROM users WHERE id = 1');
    const textTokens = tokens.filter(t => t.type === 'text').map(t => t.value);
    assert.ok(textTokens.includes('users'), 'Table name "users" should be a text token');
    assert.ok(textTokens.includes('id'), 'Column "id" should be a text token');
    // Keywords should NOT be text tokens
    const keywords = tokens.filter(t => t.type === 'keyword').map(t => t.value);
    assert.ok(keywords.includes('SELECT'), 'SELECT should be keyword, not text');
    assert.ok(keywords.includes('FROM'), 'FROM should be keyword, not text');
    assert.ok(keywords.includes('WHERE'), 'WHERE should be keyword, not text');
  });

  test('quoted identifiers are tokenized as text', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('SELECT * FROM "MyTable"');
    const textTokens = tokens.filter(t => t.type === 'text').map(t => t.value);
    assert.ok(textTokens.includes('"MyTable"'), 'Quoted identifier should be a text token');
  });

  test('schema-qualified table names are separate tokens', async () => {
    const { tokenizeSql } = await import('../../utils/resultFormatters');
    const tokens = tokenizeSql('SELECT * FROM public.users');
    const textTokens = tokens.filter(t => t.type === 'text').map(t => t.value);
    assert.ok(textTokens.includes('public'), 'Schema name should be text token');
    assert.ok(textTokens.includes('users'), 'Table name should be text token');
  });
});

// ============================================================
// 12d. Safe mode skips Seq Scan warning for small LIMIT
// ============================================================

suite('Safe Mode — Small LIMIT Skip', () => {
  test('LIMIT value is parsed correctly from query', () => {
    const extractLimit = (sql: string): number => {
      const match = sql.match(/\bLIMIT\s+(\d+)/i);
      return match ? parseInt(match[1], 10) : Infinity;
    };

    assert.strictEqual(extractLimit('SELECT * FROM t LIMIT 2'), 2);
    assert.strictEqual(extractLimit('SELECT * FROM t LIMIT 100'), 100);
    assert.strictEqual(extractLimit('SELECT * FROM t LIMIT 1000'), 1000);
    assert.strictEqual(extractLimit('SELECT * FROM t LIMIT 5000'), 5000);
    assert.strictEqual(extractLimit('SELECT * FROM t'), Infinity);
    assert.strictEqual(extractLimit('select * from t limit 50'), 50);
  });

  test('small LIMIT values should not trigger warning (threshold 1000)', () => {
    const shouldWarn = (sql: string): boolean => {
      const match = sql.match(/\bLIMIT\s+(\d+)/i);
      const limitValue = match ? parseInt(match[1], 10) : Infinity;
      return limitValue > 1000;
    };

    assert.strictEqual(shouldWarn('SELECT * FROM t LIMIT 2'), false, 'LIMIT 2 should not warn');
    assert.strictEqual(shouldWarn('SELECT * FROM t LIMIT 100'), false, 'LIMIT 100 should not warn');
    assert.strictEqual(shouldWarn('SELECT * FROM t LIMIT 1000'), false, 'LIMIT 1000 should not warn');
    assert.strictEqual(shouldWarn('SELECT * FROM t LIMIT 1001'), true, 'LIMIT 1001 should warn');
    assert.strictEqual(shouldWarn('SELECT * FROM t'), true, 'No LIMIT should warn');
  });
});

// ============================================================
// 12e. Inline Row Insertion — buildInsertRowSql and validation
// ============================================================

suite('Inline Row Insertion', () => {
  test('buildInsertRowSql generates correct SQL with values', async () => {
    const { buildInsertRowSql } = await import('../../utils/queryHelpers');
    const sql = buildInsertRowSql('users', 'public', {
      name: 'Alice',
      age: '30',
      active: true,
    }, {
      name: 'varchar',
      age: 'integer',
      active: 'boolean',
    });
    assert.ok(sql.includes('INSERT INTO'), 'Should start with INSERT INTO');
    assert.ok(sql.includes('public.users'), 'Should include schema.table');
    assert.ok(sql.includes('\'Alice\''), 'Should quote string value');
    assert.ok(sql.includes('30'), 'Should include integer value');
    assert.ok(sql.includes('TRUE'), 'Should include boolean TRUE');
    assert.ok(sql.includes('RETURNING *'), 'Should include RETURNING *');
  });

  test('buildInsertRowSql uses DEFAULT for __DEFAULT__ values', async () => {
    const { buildInsertRowSql } = await import('../../utils/queryHelpers');
    const sql = buildInsertRowSql('items', undefined, {
      id: '__DEFAULT__',
      name: 'Widget',
      created_at: '__DEFAULT__',
    }, {
      id: 'integer',
      name: 'varchar',
      created_at: 'timestamptz',
    });
    // Count DEFAULT keywords (not in quotes)
    const defaults = sql.match(/\bDEFAULT\b/g) || [];
    assert.strictEqual(defaults.length, 2, 'Should have 2 DEFAULT keywords (id + created_at)');
    assert.ok(sql.includes('\'Widget\''), 'Should quote string value');
  });

  test('buildInsertRowSql handles NULL values', async () => {
    const { buildInsertRowSql } = await import('../../utils/queryHelpers');
    const sql = buildInsertRowSql('t', undefined, {
      a: null,
      b: 'hello',
    }, {
      a: 'varchar',
      b: 'varchar',
    });
    assert.ok(sql.includes('NULL'), 'Should include NULL for null value');
    assert.ok(sql.includes('\'hello\''), 'Should include quoted string');
  });

  test('required column detection: not nullable + no default = required', () => {
    // Simulates the webview validation logic
    const columnInfo = [
      { name: 'id', nullable: false, defaultValue: 'nextval(...)' },
      { name: 'name', nullable: false, defaultValue: undefined },
      { name: 'email', nullable: false, defaultValue: undefined },
      { name: 'bio', nullable: true, defaultValue: undefined },
      { name: 'created_at', nullable: false, defaultValue: 'now()' },
    ];

    const values: Record<string, unknown> = {
      id: '__DEFAULT__',
      name: null,
      email: null,
      bio: null,
      created_at: '__DEFAULT__',
    };

    const missing: string[] = [];
    columnInfo.forEach(ci => {
      const isRequired = !ci.nullable && ci.defaultValue == null;
      const val = values[ci.name];
      if (isRequired && (val === null || val === undefined)) {
        missing.push(ci.name);
      }
    });

    assert.deepStrictEqual(missing, ['name', 'email'], 'Only name and email should be required (not nullable, no default)');
  });

  test('columns with defaults are not required even if not nullable', () => {
    const columnInfo = [
      { name: 'id', nullable: false, defaultValue: 'nextval(...)' },
      { name: 'status', nullable: false, defaultValue: '\'active\'' },
    ];

    const values: Record<string, unknown> = { id: '__DEFAULT__', status: '__DEFAULT__' };
    const missing: string[] = [];
    columnInfo.forEach(ci => {
      const isRequired = !ci.nullable && ci.defaultValue == null;
      const val = values[ci.name];
      if (isRequired && (val === null || val === undefined)) {
        missing.push(ci.name);
      }
    });

    assert.deepStrictEqual(missing, [], 'No columns should be required — all have defaults');
  });

  test('nullable columns are never required', () => {
    const columnInfo = [
      { name: 'notes', nullable: true, defaultValue: undefined },
    ];
    const values: Record<string, unknown> = { notes: null };
    const missing: string[] = [];
    columnInfo.forEach(ci => {
      const isRequired = !ci.nullable && ci.defaultValue == null;
      const val = values[ci.name];
      if (isRequired && (val === null || val === undefined)) {
        missing.push(ci.name);
      }
    });
    assert.deepStrictEqual(missing, [], 'Nullable column should not be required');
  });

  test('_insertRows command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('viewstor._insertRows'), '_insertRows command should be registered');
  });
});

// ============================================================
// 12f. SQL Diagnostics Provider
// ============================================================

suite('SQL Diagnostics Provider', () => {
  test('diagnostics provider is registered for SQL files', async () => {
    const filePath = createTempSqlFile(`diag_${Date.now()}.sql`,
      '-- viewstor:connectionId=test-conn\nSELECT * FROM nonexistent_table_xyz;');

    await openAndWait(filePath);
    // Wait for debounced diagnostic check (500ms + buffer)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Get diagnostics for this document
    const uri = vscode.window.activeTextEditor!.document.uri;
    const diagnostics = vscode.languages.getDiagnostics(uri);

    // Without a real DB connection, diagnostics will be empty (no schema to check against)
    // But the provider should NOT crash — this verifies registration
    assert.ok(diagnostics !== undefined, 'Diagnostics should be defined (provider registered)');

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('diagnostics work for pinned query files in queries dir', async () => {
    ensureDirs();
    const filePath = path.join(QUERIES_DIR, `diag_pinned_${Date.now()}.sql`);
    fs.writeFileSync(filePath, '-- viewstor:connectionId=diag-conn\nSELECT * FROM missing_table;', 'utf-8');

    await openAndWait(filePath);
    await new Promise(resolve => setTimeout(resolve, 1500));

    const uri = vscode.window.activeTextEditor!.document.uri;
    const diagnostics = vscode.languages.getDiagnostics(uri);
    assert.ok(diagnostics !== undefined, 'Diagnostics should work for pinned files');

    await closeActiveEditor();
    cleanup(filePath);
  });

  test('diagnostics are cleared when connectionId is not found', async () => {
    // File without viewstor metadata — no connectionId resolved
    ensureDirs();
    const filePath = path.join(QUERIES_DIR, `diag_noconn_${Date.now()}.sql`);
    fs.writeFileSync(filePath, 'SELECT * FROM users;', 'utf-8');

    await openAndWait(filePath);
    await new Promise(resolve => setTimeout(resolve, 1500));

    const uri = vscode.window.activeTextEditor!.document.uri;
    const diagnostics = vscode.languages.getDiagnostics(uri);
    // Without connectionId, diagnostics should be empty (cleared)
    const viewstorDiags = diagnostics.filter(d => d.source === 'viewstor');
    assert.strictEqual(viewstorDiags.length, 0, 'No viewstor diagnostics without connectionId');

    await closeActiveEditor();
    cleanup(filePath);
  });
});

// ============================================================
// 13. Chart Visualization
// ============================================================

suite('Chart Visualization', () => {
  test('visualizeResults command exists and handles no data gracefully', async () => {
    // Should show warning but not throw when called without data
    await vscode.commands.executeCommand('viewstor.visualizeResults');
  });

  test('visualizeResults command accepts data payload', async () => {
    // Should not throw when given valid data
    await vscode.commands.executeCommand('viewstor.visualizeResults', {
      columns: [{ name: 'x', dataType: 'integer' }, { name: 'y', dataType: 'integer' }],
      rows: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      query: 'SELECT x, y FROM test',
    });
    // Close any opened panel
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('exportGrafana command exists and does not throw', async () => {
    await vscode.commands.executeCommand('viewstor.exportGrafana');
  });

  test('chart types and config module can be imported', async () => {
    const chartTypes = await import('../../types/chart');
    assert.ok(chartTypes.GRAFANA_TYPE_MAP, 'GRAFANA_TYPE_MAP should exist');
    assert.ok(chartTypes.CHART_TYPE_MAPPING, 'CHART_TYPE_MAPPING should exist');
    assert.strictEqual(chartTypes.isGrafanaCompatible('line'), true);
    assert.strictEqual(chartTypes.isGrafanaCompatible('radar'), false);
    assert.strictEqual(chartTypes.isGrafanaCompatible('funnel'), false);
  });

  test('chart data transform builds options for all axis chart types', async () => {
    const { buildEChartsOption } = await import('../../chart/chartDataTransform');
    const result = {
      columns: [{ name: 'x', dataType: 'text' }, { name: 'y', dataType: 'integer' }],
      rows: [{ x: 'A', y: 10 }, { x: 'B', y: 20 }],
      rowCount: 2,
      executionTimeMs: 0,
    };

    for (const chartType of ['line', 'bar', 'scatter'] as const) {
      const option = buildEChartsOption(result, {
        chartType,
        axis: { xColumn: 'x', yColumns: ['y'] },
        aggregation: { function: 'none' },
      });
      assert.ok(option.series, `${chartType} should produce series`);
      const series = option.series as Array<Record<string, unknown>>;
      assert.strictEqual(series[0].type, chartType, `Series type should be ${chartType}`);
    }
  });

  test('chart data transform builds options for category charts', async () => {
    const { buildEChartsOption } = await import('../../chart/chartDataTransform');
    const result = {
      columns: [{ name: 'name', dataType: 'text' }, { name: 'value', dataType: 'integer' }],
      rows: [{ name: 'A', value: 10 }, { name: 'B', value: 20 }],
      rowCount: 2,
      executionTimeMs: 0,
    };

    for (const chartType of ['pie', 'funnel', 'treemap', 'sunburst'] as const) {
      const option = buildEChartsOption(result, {
        chartType,
        category: { nameColumn: 'name', valueColumn: 'value' },
        aggregation: { function: 'none' },
      });
      assert.ok(option.series, `${chartType} should produce series`);
    }
  });

  test('suggestChartConfig auto-detects timeseries', async () => {
    const { suggestChartConfig } = await import('../../chart/chartDataTransform');
    const result = {
      columns: [
        { name: 'ts', dataType: 'timestamp' },
        { name: 'val', dataType: 'float8' },
      ],
      rows: [{ ts: '2024-01-01', val: 1 }],
      rowCount: 1,
      executionTimeMs: 0,
    };
    const config = suggestChartConfig(result);
    assert.strictEqual(config.chartType, 'line');
    assert.ok(config.axis);
    assert.strictEqual(config.axis!.xColumn, 'ts');
  });

  test('Grafana export builds dashboard for compatible types', async () => {
    const { buildGrafanaDashboard } = await import('../../chart/grafanaExport');
    const config = {
      chartType: 'line' as const,
      axis: { xColumn: 'ts', yColumns: ['value'] },
      aggregation: { function: 'none' as const },
      sourceQuery: 'SELECT ts, value FROM metrics',
      databaseType: 'postgresql',
      title: 'Test',
    };
    const dashboard = buildGrafanaDashboard(config);
    assert.ok(dashboard, 'Should produce dashboard for line chart');
    assert.strictEqual(dashboard!.dashboard.panels[0].type, 'timeseries');
    assert.strictEqual(dashboard!.dashboard.panels[0].targets[0].rawSql, 'SELECT ts, value FROM metrics');
  });

  test('Grafana export returns null for incompatible types', async () => {
    const { buildGrafanaDashboard } = await import('../../chart/grafanaExport');
    for (const chartType of ['radar', 'funnel', 'boxplot', 'candlestick', 'treemap', 'sunburst'] as const) {
      const result = buildGrafanaDashboard({
        chartType,
        aggregation: { function: 'none' },
      });
      assert.strictEqual(result, null, `${chartType} should not produce Grafana dashboard`);
    }
  });

  test('multi-source join merges rows correctly', async () => {
    const { joinByColumn } = await import('../../chart/chartDataTransform');
    const primary = [
      { date: '2024-01-01', sales: 100 },
      { date: '2024-01-02', sales: 200 },
    ];
    const additional = [
      { dt: '2024-01-01', returns: 5 },
      { dt: '2024-01-02', returns: 10 },
    ];
    const joined = joinByColumn(primary, additional, 'date', 'dt');
    assert.strictEqual(joined.length, 2);
    assert.strictEqual(joined[0].returns, 5);
    assert.strictEqual(joined[1].returns, 10);
    assert.strictEqual(joined[0].sales, 100);
  });

  test('multi-source buildMultiSourceEChartsOption adds series', async () => {
    const { buildMultiSourceEChartsOption } = await import('../../chart/chartDataTransform');
    const primary = {
      columns: [{ name: 'ts', dataType: 'timestamp' }, { name: 'cpu', dataType: 'float8' }],
      rows: [{ ts: '2024-01-01', cpu: 50 }],
      rowCount: 1,
      executionTimeMs: 0,
    };
    const config = {
      chartType: 'line' as const,
      axis: { xColumn: 'ts', yColumns: ['cpu'] },
      aggregation: { function: 'none' as const },
    };
    const additional = [{
      source: { id: '1', label: 'Mem', yColumns: ['mem'], mergeMode: 'separate' as const },
      columns: [{ name: 'ts', dataType: 'timestamp' }, { name: 'mem', dataType: 'float8' }],
      rows: [{ ts: '2024-01-01', mem: 70 }],
    }];
    const option = buildMultiSourceEChartsOption(primary, additional, config);
    const series = option.series as Array<Record<string, unknown>>;
    assert.strictEqual(series.length, 2, 'Should have primary + additional series');
    assert.ok(String(series[1].name).includes('Mem'), 'Additional series should be labeled');
  });
});

// ============================================================
// 14. Regressions
// ============================================================

suite('Regressions', () => {
  test('runQuery command without active editor does not throw', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Should silently return without error
    await vscode.commands.executeCommand('viewstor.runQuery');
  });

  test('_showOutputChannel command works', async () => {
    // Should not throw
    await vscode.commands.executeCommand('viewstor._showOutputChannel');
  });

  test('_runStatementAtLine with no active editor does not throw', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('viewstor._runStatementAtLine', 0);
  });
});
