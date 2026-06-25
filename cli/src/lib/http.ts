import { CliConfig } from './config.js';

export interface HttpRequestInit {
  method: string;
  baseUrl: string;
  pathTemplate: string;
  pathParams: Record<string, string>;
  queryParams?: Record<string, string | number | boolean | string[]>;
  body?: unknown;
  timeout: number;
  token: string | null;
}

export function buildUrl(baseUrl: string, pathTemplate: string, pathParams: Record<string, string>): string {
  let path = pathTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export function buildQueryString(params: Record<string, string | number | boolean | string[]>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      searchParams.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      searchParams.set(key, String(value));
    } else {
      searchParams.set(key, String(value));
    }
  }

  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

export async function request(options: HttpRequestInit): Promise<{ status: number; headers: Headers; data: unknown }> {
  const { method, baseUrl, pathTemplate, pathParams, queryParams, body, timeout, token } = options;

  const url = buildUrl(baseUrl, pathTemplate, pathParams) + buildQueryString(queryParams || {});

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let data: unknown = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else if (response.status !== 204) {
      data = await response.text();
    }

    return {
      status: response.status,
      headers: response.headers,
      data,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
