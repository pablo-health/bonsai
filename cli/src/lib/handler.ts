import { loadConfig } from './config.js';
import { request } from './http.js';
import { successEnvelope, errorEnvelope, printEnvelope, Envelope } from './output.js';
import { translateServerError, getExitCode } from './errors.js';

export interface OperationConfig {
  method: string;
  pathTemplate: string;
  scope: 'global' | 'project';
  action: string;
  pathParamNames: string[];
  queryParamNames: string[];
  bodySchemaRef?: string | null;
}

interface RunOptions {
  json: boolean;
  verbose: boolean;
  [key: string]: unknown;
}

export async function runOperation(op: OperationConfig, options: RunOptions): Promise<number> {
  const startTime = Date.now();
  const config = await loadConfig({
    project: options.project as string | undefined,
    token: options.token as string | undefined,
  });

  if (!config.baseUrl) {
    const env = errorEnvelope('CONFIG_ERROR', 'No API base URL configured. Set --base-url, BONSAI_API_BASE_URL, or configure via `bonsai config set`.', 1);
    printEnvelope(env, options.json);
    return 2;
  }

  if (!config.token) {
    const env = errorEnvelope('UNAUTHORIZED', 'No authentication token. Set --token, BONSAI_API_TOKEN, or run `bonsai auth login`.', 401);
    printEnvelope(env, options.json);
    return 3;
  }

  if (op.scope === 'project' && !config.project) {
    const env = errorEnvelope('MISSING_PROJECT', 'No project ID. Set --project, BONSAI_PROJECT_ID, or configure default.', 400);
    printEnvelope(env, options.json);
    return 2;
  }

  const pathParams: Record<string, string> = {};
  if (op.scope === 'project') {
    pathParams.projectId = config.project!;
  }
  for (const name of op.pathParamNames) {
    const value = options[name];
    if (value === undefined || value === null) {
      const env = errorEnvelope('MISSING_ARG', `Missing required parameter: ${name}`, 400);
      printEnvelope(env, options.json);
      return 2;
    }
    pathParams[name] = String(value);
  }

  const queryParams: Record<string, string | number | boolean> = {};
  for (const name of op.queryParamNames) {
    const value = options[name];
    if (value !== undefined && value !== null && value !== '') {
      queryParams[name] = value as string | number | boolean;
    }
  }

  let body: unknown = undefined;
  if (options.data !== undefined && options.data !== null && options.data !== '') {
    if (typeof options.data === 'string') {
      if (options.data === '-') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } else {
        body = JSON.parse(options.data);
      }
    }
  } else if (options.dataFile) {
    const { readFileSync } = await import('node:fs');
    body = JSON.parse(readFileSync(options.dataFile as string, 'utf-8'));
  } else {
    const fieldKeys = Object.keys(options).filter(k =>
      !['json', 'verbose', 'quiet', 'project', 'token', 'baseUrl', 'timeout', 'data', 'dataFile', 'help', 'noHelp'].includes(k) &&
      !op.pathParamNames.includes(k) &&
      !op.queryParamNames.includes(k)
    );
    if (fieldKeys.length > 0) {
      body = {};
      for (const key of fieldKeys) {
        const value = options[key];
        if (value !== undefined && value !== null) {
          (body as Record<string, unknown>)[key] = value;
        }
      }
    }
  }

  try {
    const resp = await request({
      method: op.method,
      baseUrl: config.baseUrl,
      pathTemplate: op.pathTemplate,
      pathParams,
      queryParams,
      body,
      timeout: config.timeout,
      token: config.token,
    });

    if (options.verbose) {
      process.stderr.write(`[verbose] ${op.method} ${op.pathTemplate} → ${resp.status} (${Date.now() - startTime}ms)\n`);
    }

    if (resp.status >= 400) {
      const env = translateServerError(resp.status, resp.data);
      printEnvelope(env, options.json);
      return getExitCode(env.error.code);
    }

    const envelope: Envelope = successEnvelope(resp.data ?? null, {
      duration_ms: Date.now() - startTime,
    });
    printEnvelope(envelope, options.json);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const env = errorEnvelope('NETWORK_ERROR', message, 0);
    printEnvelope(env, options.json);
    return 8;
  }
}
