import { postPublic } from '../api/client.js';
import { saveConfig } from '../config.js';
import * as c from '@clack/prompts';
import { success, error as cliError } from '../utils/format.js';

export async function loginCommand(): Promise<void> {
  const email = await c.text({
    message: 'Email',
    validate: (val) => {
      if (!val) return 'Email is required';
      if (!val.includes('@')) return 'Invalid email address';
    },
  });

  if (c.isCancel(email)) return;

  const password = await c.password({
    message: 'Password',
  });

  if (c.isCancel(password)) return;

  const spin = c.spinner();
  spin.start('Logging in...');

  try {
    const res = await postPublic<{ accessToken: string; refreshToken: string; profile: Record<string, unknown> }>(
      '/api/auth/login',
      { id: email, password }
    );

    const { data } = res;
    const profile = data.profile as Record<string, string>;
    saveConfig({
      apiUrl: process.env.BONSAI_API_URL || 'https://app.bonsai.ai',
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      operatorId: profile.id ?? profile.operatorId,
      email: profile.email ?? email,
    });

    spin.stop('Logged in successfully');
    success(`Welcome, ${profile.displayName ?? email}`);
  } catch (err) {
    spin.stop('Login failed');
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}
