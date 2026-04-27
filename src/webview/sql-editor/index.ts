import { EditorView, keymap, ViewUpdate, placeholder } from '@codemirror/view';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { sql, PostgreSQL, SQLite, MySQL, MSSQL, StandardSQL } from '@codemirror/lang-sql';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const dialectMap: Record<string, typeof PostgreSQL> = {
  postgresql: PostgreSQL,
  sqlite: SQLite,
  mysql: MySQL,
  mssql: MSSQL,
  clickhouse: StandardSQL,
};

const vsCodeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--vscode-debugTokenExpression-name, #569cd6)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--vscode-debugTokenExpression-string, #ce9178)' },
  { tag: tags.number, color: 'var(--vscode-debugTokenExpression-number, #b5cea8)' },
  { tag: tags.bool, color: 'var(--vscode-debugTokenExpression-boolean, #569cd6)' },
  { tag: tags.null, color: 'var(--vscode-descriptionForeground)' },
  { tag: tags.operator, color: 'var(--vscode-descriptionForeground)' },
  { tag: tags.lineComment, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
  { tag: tags.blockComment, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
  { tag: tags.typeName, color: 'var(--vscode-debugTokenExpression-value, #4ec9b0)' },
  { tag: tags.name, color: 'var(--vscode-debugTokenExpression-value, #9cdcfe)' },
  { tag: tags.special(tags.name), color: 'var(--vscode-debugTokenExpression-value, #9cdcfe)' },
  { tag: tags.punctuation, color: 'var(--vscode-descriptionForeground)' },
]);

const vsCodeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    lineHeight: '1.4',
    fontFamily: 'var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace)',
    borderRadius: '2px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'var(--vscode-focusBorder)',
  },
  '.cm-content': {
    caretColor: 'var(--vscode-editorCursor-foreground)',
    padding: '4px 8px',
    fontFamily: 'inherit',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--vscode-editor-selectionBackground, rgba(38, 79, 120, 0.5)) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--vscode-editor-selectionBackground, rgba(38, 79, 120, 0.5)) !important',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--vscode-editorCursor-foreground)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background))',
    color: 'var(--vscode-editorSuggestWidget-foreground, var(--vscode-editor-foreground))',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
  },
  '.cm-tooltip-autocomplete ul li': {
    padding: '2px 8px',
    fontSize: '12px',
    lineHeight: '1.5',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))',
  },
  '.cm-completionIcon': {
    opacity: '0.6',
    width: '1em',
    marginRight: '4px',
  },
  '.cm-diagnostic': {
    padding: '2px 4px',
    marginLeft: '-4px',
  },
  '.cm-diagnostic-error': {
    borderLeft: '3px solid var(--vscode-inputValidation-errorBorder, #f44)',
    backgroundColor: 'var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))',
  },
  '.cm-diagnostic-warning': {
    borderLeft: '3px solid var(--vscode-inputValidation-warningBorder, #cca700)',
    backgroundColor: 'var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.1))',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
});

export interface SchemaInfo {
  tables: Record<string, string[]>;
  tableNames: string[];
}

export interface SqlEditorInstance {
  view: EditorView;
  getValue: () => string;
  setValue: (value: string) => void;
  setSchema: (schema: SchemaInfo) => void;
  focus: () => void;
  destroy: () => void;
}

export interface SqlEditorOptions {
  parent: HTMLElement;
  value?: string;
  dialect?: string;
  schema?: SchemaInfo;
  onRun?: (query: string) => void;
  onChange?: (query: string) => void;
  readonly?: boolean;
  placeholder?: string;
}

function buildTableLinter(schemaRef: { current: SchemaInfo | null }): Extension {
  return linter((view) => {
    const schema = schemaRef.current;
    if (!schema || !schema.tableNames.length) return [];

    const diagnostics: Diagnostic[] = [];
    const text = view.state.doc.toString();
    const tableNamesLower = new Set(schema.tableNames.map(t => t.toLowerCase()));
    const fromJoinPattern = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_.]*))(?:\s|$|,|;|\))/gi;

    let match;
    while ((match = fromJoinPattern.exec(text)) !== null) {
      const tableName = match[1] || match[2];
      if (!tableName) continue;
      const parts = tableName.split('.');
      const shortName = parts[parts.length - 1];
      if (!tableNamesLower.has(shortName.toLowerCase())) {
        const nameStart = match.index + match[0].indexOf(tableName);
        diagnostics.push({
          from: nameStart,
          to: nameStart + tableName.length,
          severity: 'warning',
          message: `Unknown table: ${tableName}`,
        });
      }
    }

    return diagnostics;
  }, { delay: 500 });
}

export function create(opts: SqlEditorOptions): SqlEditorInstance {
  const sqlDialect = dialectMap[opts.dialect || ''] || StandardSQL;
  const sqlCompartment = new Compartment();
  const schemaRef: { current: SchemaInfo | null } = { current: opts.schema || null };

  const cmSchema = schemaRef.current
    ? schemaRef.current.tables
    : undefined;

  const extensions: Extension[] = [
    vsCodeTheme,
    syntaxHighlighting(vsCodeHighlight),
    history(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    sqlCompartment.of(sql({
      dialect: sqlDialect,
      schema: cmSchema,
      upperCaseKeywords: true,
    })),
    autocompletion({
      activateOnTyping: true,
      icons: true,
    }),
    buildTableLinter(schemaRef),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        opts.onChange?.(update.state.doc.toString());
      }
    }),
  ];

  if (opts.onRun) {
    const runFn = opts.onRun;
    extensions.push(keymap.of([{
      key: 'Mod-Enter',
      run: (view) => {
        runFn(view.state.doc.toString());
        return true;
      },
    }]));
  }

  if (opts.placeholder) {
    extensions.push(placeholder(opts.placeholder));
  }

  if (opts.readonly) {
    extensions.push(EditorState.readOnly.of(true));
  }

  const view = new EditorView({
    state: EditorState.create({
      doc: opts.value || '',
      extensions,
    }),
    parent: opts.parent,
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (value: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    },
    setSchema: (schema: SchemaInfo) => {
      schemaRef.current = schema;
      view.dispatch({
        effects: sqlCompartment.reconfigure(sql({
          dialect: sqlDialect,
          schema: schema.tables,
          upperCaseKeywords: true,
        })),
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

(window as any).ViewstorSqlEditor = { create };
