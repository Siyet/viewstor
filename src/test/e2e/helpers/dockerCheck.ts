import { execSync } from 'child_process';

export const isDockerAvailable = (() => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

export const describeIf = (condition: boolean) =>
  condition ? describe : describe.skip;
