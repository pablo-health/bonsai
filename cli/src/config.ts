import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BONSAI_DIR = join(homedir(), '.bonsai');
const CONFIG_PATH = join(BONSAI_DIR, 'config.json');

export interface BonsaiConfig {
  apiUrl: string;
  accessToken?: string;
  refreshToken?: string;
  operatorId?: string;
  email?: string;
  lastProjectId?: string;
}

function readRaw(): BonsaiConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as BonsaiConfig;
  } catch {
    return null;
  }
}

function ensureDir() {
  if (!existsSync(BONSAI_DIR)) {
    mkdirSync(BONSAI_DIR, { recursive: true });
  }
}

export function loadConfig(): BonsaiConfig | null {
  return readRaw();
}

export function saveConfig(config: BonsaiConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  chmodSync(CONFIG_PATH, 0o600);
}

export function clearConfig(): void {
  if (existsSync(CONFIG_PATH)) {
    try {
      unlinkSync(CONFIG_PATH);
    } catch { /* ignore */ }
  }
}

export function getProjectId(): string | undefined {
  const config = loadConfig();
  return process.env.BONSAI_PROJECT_ID ?? config?.lastProjectId;
}

export function setLastProjectId(projectId: string): void {
  const config = loadConfig() ?? { apiUrl: 'https://app.bonsai.ai' };
  config.lastProjectId = projectId;
  saveConfig(config);
}

export function getApiKey(): string | undefined {
  return process.env.BONSAI_API_KEY;
}

export function getApiUrl(): string {
  return process.env.BONSAI_API_URL || loadConfig()?.apiUrl || 'https://app.bonsai.ai';
}
