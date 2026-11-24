export type TableContextKind = 'table' | 'view';

export interface TableContextAction {
  command: string;
  label: string;
  group: '1_query' | '2_data' | '4_danger';
  kinds: readonly TableContextKind[];
  destructive?: boolean;
}

/**
 * Canonical table/view action list shared by the Connections tree contract and
 * table-like webviews. package.json remains declarative, while a regression
 * test guarantees its contributed tree menu stays in sync with this registry.
 */
export const TABLE_CONTEXT_ACTIONS: readonly TableContextAction[] = [
  { command: 'viewstor.openQuery', label: 'New Query', group: '1_query', kinds: ['table', 'view'] },
  { command: 'viewstor.showTableData', label: 'Show Table Data', group: '2_data', kinds: ['table', 'view'] },
  { command: 'viewstor.showDDL', label: 'Show DDL', group: '2_data', kinds: ['table', 'view'] },
  { command: 'viewstor.compareWith', label: 'Compare With...', group: '2_data', kinds: ['table', 'view'] },
  { command: 'viewstor.copyName', label: 'Copy Name', group: '2_data', kinds: ['table', 'view'] },
  { command: 'viewstor.renameObject', label: 'Rename...', group: '2_data', kinds: ['table', 'view'] },
  { command: 'viewstor.createObject', label: 'Create...', group: '2_data', kinds: ['table'] },
  { command: 'viewstor.dropObject', label: 'Drop...', group: '4_danger', kinds: ['table', 'view'], destructive: true },
];

export function tableContextActions(kind: TableContextKind): readonly TableContextAction[] {
  return TABLE_CONTEXT_ACTIONS.filter(action => action.kinds.includes(kind));
}

export function findTableContextAction(command: string, kind: TableContextKind): TableContextAction | undefined {
  return tableContextActions(kind).find(action => action.command === command);
}
