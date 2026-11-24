import { describe, expect, it } from 'vitest';
import {
  completeCompareColumnSelection,
  createCompareColumnPlan,
  findCompatiblePrimaryKey,
} from '../diff/diffColumnSelection';
import type { TableInfo } from '../types/schema';

function info(name: string, columns: Array<[string, string, boolean?]>): TableInfo {
  return {
    name,
    columns: columns.map(([columnName, dataType, isPrimaryKey = false]) => ({
      name: columnName,
      dataType,
      nullable: false,
      isPrimaryKey,
    })),
  };
}

describe('diff column selection', () => {
  it('deduplicates primary-key metadata before selecting compatible keys', () => {
    const left = info('customers', [
      ['id', 'bigint', true],
      ['id', 'bigint', true],
      ['name', 'text'],
    ]);
    const right = info('summary', [
      ['id', 'bigint', true],
      ['name', 'text'],
    ]);

    expect(findCompatiblePrimaryKey(left, right)).toEqual(['id']);
  });

  it('shows exact, similar-name, and one-sided columns without unsafe preselection', () => {
    const customers = info('customers', [
      ['id', 'bigint', true],
      ['name', 'text'],
      ['email', 'text'],
      ['lifetime_value', 'numeric'],
    ]);
    const summary = info('customer_summary', [
      ['id', 'bigint'],
      ['name', 'text'],
      ['order_count', 'bigint'],
      ['total_value', 'numeric'],
    ]);

    const keys = findCompatiblePrimaryKey(customers, summary);
    expect(keys).toEqual(['id']);
    const plan = createCompareColumnPlan(customers, summary, keys!);

    expect(plan.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'exact:id', picked: true, kind: 'exact' }),
      expect.objectContaining({ id: 'exact:name', picked: true, kind: 'exact' }),
      expect.objectContaining({ id: 'similar:lifetime_value:total_value', picked: false, kind: 'similar' }),
      expect.objectContaining({ id: 'left:email', picked: false, kind: 'leftOnly' }),
      expect.objectContaining({ id: 'right:order_count', picked: false, kind: 'rightOnly' }),
    ]));

    expect(completeCompareColumnSelection(plan, ['exact:id', 'exact:name'])).toEqual([
      { label: 'id', left: 'id', right: 'id' },
      { label: 'name', left: 'name', right: 'name' },
    ]);
  });
});
