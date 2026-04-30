import { loadConfig, clearConfig } from '../config.js';
import * as c from '@clack/prompts';
import { success, dim } from '../utils/format.js';

export async function logoutCommand(): Promise<void> {
  const config = loadConfig();

  if (!config?.email) {
    console.log('Not logged in.');
    return;
  }

  const confirmed = await c.confirm({
    message: `Log out as ${dim(config.email)}?`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  clearConfig();
  success('Logged out. Config cleared.');
}
