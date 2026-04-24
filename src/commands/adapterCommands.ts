import * as vscode from 'vscode';
import { listAdapters, installAdapter, uninstallAdapter, isAdapterInstalled } from '../adapters/adapterManager';
import { getAdapterSpec } from '../adapters/adapterRegistry';
import { DatabaseType } from '../types/connection';

export function registerAdapterCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('viewstor.manageAdapters', manageAdapters),
  );
}

async function manageAdapters() {
  const adapters = listAdapters();
  const items: vscode.QuickPickItem[] = adapters.map(a => ({
    label: `${a.installed ? '$(check)' : '$(cloud-download)'} ${a.type}`,
    description: `${a.spec.packageName}@${a.spec.version}`,
    detail: a.installed
      ? 'Installed — select to uninstall'
      : `Not installed (~${a.spec.approxSizeMB} MB) — select to install`,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Viewstor: Manage Database Adapters',
    placeHolder: 'Select an adapter to install or uninstall',
  });
  if (!picked) return;

  const idx = items.indexOf(picked);
  const adapter = adapters[idx];
  const type = adapter.type;

  if (adapter.installed) {
    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Uninstall the {0} adapter ({1})?', type, adapter.spec.packageName),
      { modal: true },
      vscode.l10n.t('Uninstall'),
    );
    if (confirm) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uninstalling ${type} adapter...` },
        async () => {
          await uninstallAdapter(type);
          vscode.window.showInformationMessage(vscode.l10n.t('{0} adapter uninstalled', type));
        },
      );
    }
  } else {
    await installAdapterWithProgress(type);
  }
}

export async function installAdapterWithProgress(type: DatabaseType): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing ${type} adapter...`, cancellable: false },
      async (progress) => {
        await installAdapter(type, msg => progress.report({ message: msg }));
      },
    );
    vscode.window.showInformationMessage(vscode.l10n.t('{0} adapter installed successfully', type));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(vscode.l10n.t('Failed to install {0} adapter: {1}', type, message));
    return false;
  }
}

export async function ensureAdapterInstalled(type: DatabaseType): Promise<boolean> {
  if (isAdapterInstalled(type)) return true;

  const install = vscode.l10n.t('Install');
  const result = await vscode.window.showWarningMessage(
    vscode.l10n.t('The {0} database adapter is not installed. Install it now (~{1} MB)?', type, String(getAdapterSpec(type).approxSizeMB)),
    install,
    vscode.l10n.t('Cancel'),
  );
  if (result !== install) return false;

  return installAdapterWithProgress(type);
}
