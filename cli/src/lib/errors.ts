import { ErrorEnvelope } from './output.js';

export const ERROR_CODE_MAP: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'REMOTE_ERROR',
};

export const EXIT_CODE_MAP: Record<string, number> = {
  VALIDATION_ERROR: 5,
  UNAUTHORIZED: 3,
  FORBIDDEN: 3,
  NOT_FOUND: 4,
  CONFLICT: 6,
  ARCHIVED_PROJECT: 6,
  RATE_LIMITED: 7,
  INTERNAL_ERROR: 10,
  REMOTE_ERROR: 10,
};

export function mapErrorCode(httpStatus: number, serverError?: string): string {
  if (serverError && ERROR_CODE_MAP[httpStatus]) {
    return ERROR_CODE_MAP[httpStatus];
  }
  return ERROR_CODE_MAP[httpStatus] || 'INTERNAL_ERROR';
}

export function getExitCode(errorCode: string): number {
  return EXIT_CODE_MAP[errorCode] || 1;
}

export function translateServerError(httpStatus: number, serverData: unknown): ErrorEnvelope {
  const body = serverData as { error?: string; details?: unknown } || {};
  const code = mapErrorCode(httpStatus, body.error);

  return {
    status: 'error',
    data: null,
    error: {
      code,
      message: body.error || `HTTP ${httpStatus}`,
      http_status: httpStatus,
      details: body.details || null,
    },
    meta: {},
  };
}
