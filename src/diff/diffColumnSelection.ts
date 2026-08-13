import type { DiffColumnMapping } from './diffTypes';
import type { ColumnInfo, TableInfo } from '../types/schema';

export type CompareColumnCandidateKind = 'exact' | 'similar' | 'leftOnly' | 'rightOnly';

export interface CompareColumnCandidate {
  id: string;
  label: string;
  description: string;
  kind: CompareColumnCandidateKind;
  picked: boolean;
  mapping: DiffColumnMapping;
}

export interface CompareColumnPlan {
  /** True when the user should confirm/select mappings in QuickPick. */
  requiresSelection: boolean;
  /** Matching keys remain present even when the corresponding item is unchecked. */
  fixedMappings: DiffColumnMapping[];
  candidates: CompareColumnCandidate[];
}

/** Return a complete primary key from either side when every key exists on both sides. */
export function findCompatiblePrimaryKey(left: TableInfo, right: TableInfo): string[] | undefined {
  const rightNames = new Set(right.columns.map(column => column.name));
  const leftNames = new Set(left.columns.map(column => column.name));
  const leftPk = primaryKeyColumns(left.columns);
  const rightPk = primaryKeyColumns(right.columns);

  if (leftPk.length > 0 && leftPk.every(column => rightNames.has(column))) return leftPk;
  if (rightPk.length > 0 && rightPk.every(column => leftNames.has(column))) return rightPk;
  return undefined;
}

/**
 * Build the exact selection model consumed by the VS Code QuickPick and E2E tests.
 * Exact pairs are safe defaults; similar-name and one-sided candidates stay visible
 * but unchecked until the user explicitly includes them.
 */
export function createCompareColumnPlan(
  left: TableInfo,
  right: TableInfo,
  keyColumns: string[],
): CompareColumnPlan {
  const leftByName = new Map(left.columns.map(column => [column.name, column]));
  const rightByName = new Map(right.columns.map(column => [column.name, column]));
  const sameColumnSet = leftByName.size === rightByName.size
    && [...leftByName.keys()].every(name => rightByName.has(name));
  const keySet = new Set(keyColumns);
  const candidates: CompareColumnCandidate[] = [];
  const matchedLeft = new Set<string>();
  const matchedRight = new Set<string>();

  for (const leftColumn of left.columns) {
    const rightColumn = rightByName.get(leftColumn.name);
    if (!rightColumn) continue;
    matchedLeft.add(leftColumn.name);
    matchedRight.add(rightColumn.name);
    const isKey = keySet.has(leftColumn.name);
    candidates.push(candidate(
      `exact:${leftColumn.name}`,
      `${leftColumn.name} ↔ ${rightColumn.name}`,
      isKey
        ? `Exact · matching key (always included) · ${typePair(leftColumn, rightColumn)}`
        : `Exact · ${typePair(leftColumn, rightColumn)}`,
      'exact',
      true,
      { label: leftColumn.name, left: leftColumn.name, right: rightColumn.name },
    ));
  }

  const unmatchedLeft = left.columns.filter(column => !matchedLeft.has(column.name));
  const unmatchedRight = right.columns.filter(column => !matchedRight.has(column.name));
  const similarPairs = findSimilarPairs(unmatchedLeft, unmatchedRight);

  for (const pair of similarPairs) {
    matchedLeft.add(pair.left.name);
    matchedRight.add(pair.right.name);
    candidates.push(candidate(
      `similar:${pair.left.name}:${pair.right.name}`,
      `${pair.left.name} ↔ ${pair.right.name}`,
      `Similar name · ${typePair(pair.left, pair.right)}`,
      'similar',
      false,
      {
        label: `${pair.left.name} ↔ ${pair.right.name}`,
        left: pair.left.name,
        right: pair.right.name,
      },
    ));
  }

  for (const column of left.columns.filter(item => !matchedLeft.has(item.name))) {
    candidates.push(candidate(
      `left:${column.name}`,
      column.name,
      `Left only · ${column.dataType}`,
      'leftOnly',
      false,
      { label: column.name, left: column.name },
    ));
  }
  for (const column of right.columns.filter(item => !matchedRight.has(item.name))) {
    candidates.push(candidate(
      `right:${column.name}`,
      column.name,
      `Right only · ${column.dataType}`,
      'rightOnly',
      false,
      { label: column.name, right: column.name },
    ));
  }

  const fixedMappings = keyColumns.map(name => ({ label: name, left: name, right: name }));
  return {
    requiresSelection: !sameColumnSet,
    fixedMappings: sameColumnSet
      ? candidates.filter(item => item.kind === 'exact').map(item => item.mapping)
      : fixedMappings,
    candidates,
  };
}

/** Apply selected candidate IDs while retaining every fixed matching key. */
export function completeCompareColumnSelection(
  plan: CompareColumnPlan,
  selectedCandidateIds: string[],
): DiffColumnMapping[] {
  const selected = new Set(selectedCandidateIds);
  const mappings = [
    ...plan.fixedMappings,
    ...plan.candidates.filter(item => selected.has(item.id)).map(item => item.mapping),
  ];
  const seen = new Set<string>();
  return mappings.filter(mapping => {
    const key = `${mapping.left ?? ''}\0${mapping.right ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidate(
  id: string,
  label: string,
  description: string,
  kind: CompareColumnCandidateKind,
  picked: boolean,
  mapping: DiffColumnMapping,
): CompareColumnCandidate {
  return { id, label, description, kind, picked, mapping };
}

function typePair(left: ColumnInfo, right: ColumnInfo): string {
  return left.dataType === right.dataType
    ? left.dataType
    : `${left.dataType} ↔ ${right.dataType}`;
}

function findSimilarPairs(
  left: ColumnInfo[],
  right: ColumnInfo[],
): Array<{ left: ColumnInfo; right: ColumnInfo; score: number }> {
  const possible = left.flatMap(leftColumn => right.map(rightColumn => ({
    left: leftColumn,
    right: rightColumn,
    score: nameSimilarity(leftColumn.name, rightColumn.name),
  }))).filter(pair => pair.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  return possible.filter(pair => {
    if (usedLeft.has(pair.left.name) || usedRight.has(pair.right.name)) return false;
    usedLeft.add(pair.left.name);
    usedRight.add(pair.right.name);
    return true;
  });
}

function nameSimilarity(left: string, right: string): number {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  const editScore = maxLength === 0 ? 1 : 1 - levenshtein(a, b) / maxLength;
  const aTokens = new Set(tokenizeName(left));
  const bTokens = new Set(tokenizeName(right));
  const intersection = [...aTokens].filter(token => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  const tokenScore = union === 0 ? 0 : intersection / union;
  return Math.max(editScore, tokenScore);
}

function normalizeName(value: string): string {
  return tokenizeName(value).join('');
}

function tokenizeName(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function primaryKeyColumns(columns: ColumnInfo[]): string[] {
  return [...new Set(columns.filter(column => column.isPrimaryKey).map(column => column.name))];
}
