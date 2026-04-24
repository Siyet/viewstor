import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { DatabaseType } from '../types/connection';
import { AdapterSpec, getAdapterSpec, getAllAdapterSpecs, getPackageInstallArg } from './adapterRegistry';

export interface AdapterInfo {
  type: DatabaseType;
  spec: AdapterSpec;
  installed: boolean;
}

let adapterDir: string | undefined;

export function setAdapterDir(dir: string): void {
  adapterDir = dir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const pkgJson = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'viewstor-adapters', private: true }, null, 2), 'utf8');
  }
}

export function getAdapterDir(): string | undefined {
  return adapterDir;
}

export function getAdapterModulePath(packageName: string): string | undefined {
  if (!adapterDir) return undefined;
  const modulePath = path.join(adapterDir, 'node_modules', packageName);
  if (fs.existsSync(modulePath)) return modulePath;
  return undefined;
}

export function isAdapterInstalled(type: DatabaseType): boolean {
  const spec = getAdapterSpec(type);
  if (getAdapterModulePath(spec.packageName)) return true;
  // Development/test fallback: check if the package is in node_modules
  try {
    require.resolve(spec.packageName);
    return true;
  } catch {
    return false;
  }
}

export function listAdapters(): AdapterInfo[] {
  return getAllAdapterSpecs().map(([type, spec]) => ({
    type,
    spec,
    installed: isAdapterInstalled(type),
  }));
}

export async function installAdapter(
  type: DatabaseType,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (!adapterDir) throw new Error('Adapter directory not configured');
  const installArg = getPackageInstallArg(type);
  onProgress?.(`Installing ${installArg}...`);

  await new Promise<void>((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = childProcess.execFile(
      npmCmd,
      ['install', '--prefix', adapterDir!, installArg, '--save'],
      { timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to install ${installArg}: ${stderr || error.message}`));
        } else {
          onProgress?.(`${installArg} installed successfully`);
          resolve();
        }
      },
    );
    child.stdout?.on('data', (data: string) => onProgress?.(data.toString().trim()));
  });
}

export async function uninstallAdapter(type: DatabaseType): Promise<void> {
  if (!adapterDir) throw new Error('Adapter directory not configured');
  const spec = getAdapterSpec(type);

  await new Promise<void>((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    childProcess.execFile(
      npmCmd,
      ['uninstall', '--prefix', adapterDir!, spec.packageName],
      { timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to uninstall ${spec.packageName}: ${stderr || error.message}`));
        } else {
          resolve();
        }
      },
    );
  });
}

export function requireAdapter(packageName: string): unknown {
  const modulePath = getAdapterModulePath(packageName);
  if (modulePath) return require(modulePath);
  // Development fallback — packages in node_modules
  return require(packageName);
}
