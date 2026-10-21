/**
 * Normalised API errors. FastAPI returns `{ detail: string | ErrorDetail | ValidationError[] }`;
 * the UI wants one message, the HTTP status, an optional machine code, and field errors.
 */

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string | null;
  readonly fieldErrors: readonly FieldError[];
  readonly requestId: string | null;

  constructor(init: {
    status: number;
    message: string;
    code?: string | null;
    fieldErrors?: readonly FieldError[];
    requestId?: string | null;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code ?? null;
    this.fieldErrors = init.fieldErrors ?? [];
    this.requestId = init.requestId ?? null;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Client errors are not retried by the query client. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was not accepted.',
  401: 'Your session has ended. Sign in again.',
  403: 'You do not have permission for this action.',
  404: 'Not found.',
  409: 'This record changed or already exists.',
  422: 'Some fields are invalid.',
  429: 'Too many requests. Try again shortly.',
  500: 'The server hit an error.',
  502: 'The API is unreachable.',
  503: 'The API is unavailable.',
  504: 'The API did not respond in time.',
};

function fallbackMessage(status: number): string {
  return (
    STATUS_MESSAGES[status] ?? (status >= 500 ? 'The server hit an error.' : 'Request failed.')
  );
}

/** Build an {@link ApiError} from a parsed FastAPI error body (or anything else). */
export function toApiError(
  status: number,
  body: unknown,
  requestId: string | null = null,
): ApiError {
  if (!isRecord(body) || !('detail' in body)) {
    return new ApiError({ status, message: fallbackMessage(status), requestId });
  }
  const detail = body.detail;
  if (typeof detail === 'string') {
    return new ApiError({ status, message: detail || fallbackMessage(status), requestId });
  }
  if (Array.isArray(detail)) {
    const fieldErrors: FieldError[] = detail.filter(isRecord).map((d) => ({
      path: Array.isArray(d.loc)
        ? d.loc.filter((p) => p !== 'body' && p !== 'query' && p !== 'path').join('.')
        : '',
      message: typeof d.msg === 'string' ? d.msg : 'Invalid value',
    }));
    const first = fieldErrors[0];
    const message = first
      ? `${first.path ? `${first.path}: ` : ''}${first.message}${fieldErrors.length > 1 ? ` (+${fieldErrors.length - 1} more)` : ''}`
      : fallbackMessage(status);
    return new ApiError({ status, message, fieldErrors, code: 'validation_error', requestId });
  }
  if (isRecord(detail)) {
    const message =
      typeof detail.message === 'string' && detail.message
        ? detail.message
        : fallbackMessage(status);
    const code = typeof detail.code === 'string' ? detail.code : null;
    return new ApiError({ status, message, code, requestId });
  }
  return new ApiError({ status, message: fallbackMessage(status), requestId });
}

/** Human message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Network error: the API could not be reached.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
