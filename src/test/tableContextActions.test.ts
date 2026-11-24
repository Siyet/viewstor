import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TABLE_CONTEXT_ACTIONS, tableContextActions, TableContextKind } from '../views/tableContextActions';

interface MenuContribution {
  command: string;
  when?: string;
  group?: string;
}

const PACKAGE_PATH = path.join(__dirname, '..', '..', 'package.json');

function appliesToKind(contribution: MenuContribution, kind: TableContextKind): boolean {
  const when = contribution.when || '';
  if (when.includes(`viewItem == ${kind}`)) return true;
  const match = when.match(/viewItem =~ \/(.+)\//);
  return Boolean(match && new RegExp(match[1]).test(kind));
}

describe('shared table context actions', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf-8'));
  const contributed = packageJson.contributes.menus['view/item/context'] as MenuContribution[];

  for (const kind of ['table', 'view'] as const) {
    it(`keeps the ${kind} tree menu synchronized with the shared registry`, () => {
      const treeActions = contributed
        .filter(item => item.group !== 'inline' && appliesToKind(item, kind))
        .map(item => ({ command: item.command, group: item.group }));
      const sharedActions = tableContextActions(kind)
        .map(item => ({ command: item.command, group: item.group }));

      expect(treeActions).toEqual(sharedActions);
    });
  }

  it('marks only the destructive group as dangerous', () => {
    for (const action of tableContextActions('table')) {
      expect(Boolean(action.destructive)).toBe(action.group === '4_danger');
    }
  });

  it('uses the same default labels as the contributed tree commands', () => {
    const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.nls.json'), 'utf-8'));
    const commands = packageJson.contributes.commands as Array<{ command: string; title: string }>;
    for (const action of TABLE_CONTEXT_ACTIONS) {
      const title = commands.find(command => command.command === action.command)?.title;
      const labelKey = title?.match(/^%(.+)%$/)?.[1];
      expect(labelKey, `missing localized title for ${action.command}`).toBeTruthy();
      expect(action.label).toBe(labels[labelKey!]);
    }
  });
});
