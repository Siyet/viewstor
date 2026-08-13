import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresDriver } from '../drivers/postgres';
import { SqliteDriver } from '../drivers/sqlite';

describe('ER diagram foreign-key metadata', () => {
  const sqliteDrivers: SqliteDriver[] = [];

  afterEach(async () => {
    await Promise.all(sqliteDrivers.splice(0).map(driver => driver.disconnect()));
  });

  it('maps PostgreSQL composite foreign keys in column order', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        constraint_name: 'line_items_order_fkey',
        source_schema: 'sales',
        source_table: 'line_items',
        source_columns: ['tenant_id', 'order_id'],
        target_schema: 'sales',
        target_table: 'orders',
        target_columns: ['tenant_id', 'id'],
        delete_rule: 'CASCADE',
        update_rule: 'NO ACTION',
      }],
    }));
    const driver = new PostgresDriver();
    (driver as unknown as { client: { query: typeof query } }).client = { query };

    await expect(driver.getForeignKeys('sales')).resolves.toEqual([{
      name: 'line_items_order_fkey',
      sourceSchema: 'sales',
      sourceTable: 'line_items',
      sourceColumns: ['tenant_id', 'order_id'],
      targetSchema: 'sales',
      targetTable: 'orders',
      targetColumns: ['tenant_id', 'id'],
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
    }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('position_in_unique_constraint'), ['sales']);
  });

  it('groups SQLite composite foreign-key rows into one relationship', async () => {
    const driver = new SqliteDriver();
    sqliteDrivers.push(driver);
    await driver.connect({
      id: 'er-sqlite',
      name: 'ER SQLite',
      type: 'sqlite',
      host: '',
      port: 0,
      database: ':memory:',
    });
    await driver.execute(`
      CREATE TABLE parents (
        tenant_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE children (
        tenant_id INTEGER NOT NULL,
        parent_id INTEGER NOT NULL,
        FOREIGN KEY (tenant_id, parent_id)
          REFERENCES parents (tenant_id, id)
          ON DELETE CASCADE
      );
    `);

    const foreignKeys = await driver.getForeignKeys();
    expect(foreignKeys).toEqual([{
      name: 'fk_children_0',
      sourceTable: 'children',
      sourceColumns: ['tenant_id', 'parent_id'],
      targetTable: 'parents',
      targetColumns: ['tenant_id', 'id'],
      onDelete: 'CASCADE',
      onUpdate: undefined,
    }]);
  });
});
