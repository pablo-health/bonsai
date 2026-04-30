import { loadConfig, getApiKey } from '../config.js';

export interface ApiResponse<T = unknown> {
  data: T;
  ok: boolean;
  status: number;
  statusText: string;
}

export class BonsaiAPIError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public detail: unknown,
    message?: string
  ) {
    super(message ?? `HTTP ${status}: ${statusText}`);
    this.name = 'BonsaiAPIError';
  }
}

export class BonsaiAuthError extends Error {
  constructor(message = 'Authentication failed. Please run `bonsai login`.') {
    super(message);
    this.name = 'BonsaiAuthError';
  }
}

type RequestOptions = {
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
};

function getBaseUrl(config: ReturnType<typeof loadConfig>): string {
  const base = (config?.apiUrl ?? 'https://app.bonsai.ai').replace(/\/$/, '');
  return base;
}

export function buildUrl(
  config: ReturnType<typeof loadConfig>,
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const base = getBaseUrl(config);
  const url = new URL(`${base}${path}`, `http://placeholder`);
  url.protocol = base.startsWith('https') ? 'https:' : 'http:';

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

function getHeaders(config: ReturnType<typeof loadConfig>, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (config?.accessToken) {
    headers['Authorization'] = `Bearer ${config.accessToken}`;
  } else {
    const apiKey = getApiKey();
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
  }
  return headers;
}

async function request<T>(
  method: string,
  config: ReturnType<typeof loadConfig>,
  path: string,
  options?: RequestOptions & { token?: string },
  retryAuth = false
): Promise<ApiResponse<T>> {
  const url = buildUrl(config, path, options?.query);
  const body = options?.body ? JSON.stringify(options.body) : undefined;
  const token = options?.token ?? config?.accessToken;

  const res = await fetch(url, {
    method,
    headers: getHeaders(config, token),
    body,
  });

  // Handle 401 — try refresh once
  if (res.status === 401 && retryAuth && config?.refreshToken) {
    const refreshUrl = buildUrl(config, '/api/auth/refresh');
    const refreshRes = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: config.refreshToken }),
    });

    if (refreshRes.ok) {
      const refreshData = await refreshRes.json() as { accessToken: string };
      const { saveConfig } = await import('../config.js');
      config.accessToken = refreshData.accessToken;
      saveConfig(config);

      return request<T>(method, config, path, { ...options, token: refreshData.accessToken }, false);
    }
  }

  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    detail = null;
  }

  if (!res.ok) {
    throw new BonsaiAPIError(res.status, res.statusText, detail);
  }

  return { data: detail as T, ok: true, status: res.status, statusText: res.statusText };
}

function authenticatedRequest<T>(
  method: string,
  path: string,
  options?: RequestOptions & { token?: string },
  retryAuth = false
): Promise<ApiResponse<T>> {
  const config = loadConfig();
  if (!config) throw new BonsaiAuthError('Not logged in. Run `bonsai login`.');
  return request<T>(method, config, path, options, retryAuth);
}

export async function get<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
  return authenticatedRequest<T>('GET', path, options);
}

export async function post<T>(path: string, body?: Record<string, unknown>, options?: RequestOptions): Promise<ApiResponse<T>> {
  return authenticatedRequest<T>('POST', path, { ...options, body });
}

export async function patch<T>(path: string, body?: Record<string, unknown>, options?: RequestOptions): Promise<ApiResponse<T>> {
  return authenticatedRequest<T>('PATCH', path, { ...options, body });
}

export async function put<T>(path: string, body?: Record<string, unknown>, options?: RequestOptions): Promise<ApiResponse<T>> {
  return authenticatedRequest<T>('PUT', path, { ...options, body });
}

export async function del<T>(path: string, body?: Record<string, unknown>, options?: RequestOptions): Promise<ApiResponse<T>> {
  return authenticatedRequest<T>('DELETE', path, { ...options, body });
}

// Public (unauthenticated) requests — used for login, setup, catalog endpoints
export async function postPublic<T>(path: string, body: Record<string, unknown>): Promise<ApiResponse<T>> {
  const config = loadConfig();
  const url = buildUrl(config, path);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    detail = null;
  }

  if (!res.ok) {
    throw new BonsaiAPIError(res.status, res.statusText, detail);
  }

  return { data: detail as T, ok: true, status: res.status, statusText: res.statusText };
}

export async function getPublic<T>(path: string): Promise<ApiResponse<T>> {
  const config = loadConfig();
  const url = buildUrl(config, path);
  const res = await fetch(url, {
    method: 'GET',
  });

  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    detail = null;
  }

  if (!res.ok) {
    throw new BonsaiAPIError(res.status, res.statusText, detail);
  }

  return { data: detail as T, ok: true, status: res.status, statusText: res.statusText };
}
