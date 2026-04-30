import { get } from '../api/client.js';
import { error as cliError } from '../utils/format.js';

export async function whoamiCommand(): Promise<void> {
  try {
    const res = await get<{ id: string; email: string; displayName: string; roles: string[] }>('/api/auth/me');
    const { data } = res;

    console.log(`  Email:       ${data.email}`);
    console.log(`  Display name:${data.displayName ?? ''}`);
    console.log(`  Operator ID: ${data.id}`);
    console.log(`  Roles:       ${data.roles.join(', ') || 'none'}`);
  } catch (err) {
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}
