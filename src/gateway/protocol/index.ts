export const PROTOCOL_VERSION = 1;

export const ErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ErrorShape = {
  code: ErrorCode;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export function errorShape(
  code: ErrorCode,
  message: string,
  extra?: {
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  },
): ErrorShape {
  return {
    code,
    message,
    ...(extra?.details !== undefined ? { details: extra.details } : {}),
    ...(extra?.retryable !== undefined ? { retryable: extra.retryable } : {}),
    ...(extra?.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
  };
}

export type ConnectParams = {
  role?: string;
  scopes?: string[];
};

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
  meta?: Record<string, unknown>;
};
