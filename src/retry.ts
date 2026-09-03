import { AppError } from "./errors.js";

export interface NetworkRetryPolicy {
  retries: number;
  retryDelayMs: number;
  timeoutMs: number;
}

export interface NetworkRetryOptions {
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export const DEFAULT_NETWORK_RETRY_POLICY: NetworkRetryPolicy = {
  retries: 2,
  retryDelayMs: 400,
  timeoutMs: 30000,
};

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  return value;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 1) {
    return fallback;
  }

  return Math.floor(numeric);
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

function extractStatusCode(error: unknown): number | undefined {
  if (!(error instanceof AppError) || !error.details || typeof error.details !== "object") {
    return undefined;
  }

  const details = error.details as { statusCode?: unknown };
  const statusCode = toFiniteNumber(details.statusCode);
  if (statusCode === null) {
    return undefined;
  }

  return Math.floor(statusCode);
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if (error instanceof AppError && error.details && typeof error.details === "object") {
    const nestedError = (error.details as { error?: unknown }).error;
    if (nestedError && typeof nestedError === "object") {
      const nestedCode = (nestedError as { code?: unknown }).code;
      if (typeof nestedCode === "string") {
        return nestedCode;
      }
    }
  }

  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

function containsTimeoutMessage(error: unknown): boolean {
  if (error instanceof AppError && error.details && typeof error.details === "object") {
    const nestedError = (error.details as { error?: unknown }).error;
    if (nestedError instanceof Error) {
      const nestedMessage = nestedError.message.toLowerCase();
      if (nestedMessage.includes("timeout") || nestedMessage.includes("timed out")) {
        return true;
      }
    }
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

export function createNetworkRetryPolicy(
  input?: NetworkRetryOptions
): NetworkRetryPolicy {
  return {
    retries: asNonNegativeInt(input?.retries, DEFAULT_NETWORK_RETRY_POLICY.retries),
    retryDelayMs: asNonNegativeInt(
      input?.retryDelayMs,
      DEFAULT_NETWORK_RETRY_POLICY.retryDelayMs
    ),
    timeoutMs: asPositiveInt(input?.timeoutMs, DEFAULT_NETWORK_RETRY_POLICY.timeoutMs),
  };
}

export function isRetryableNetworkError(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (typeof statusCode === "number" && (statusCode === 429 || statusCode >= 500)) {
    return true;
  }

  const code = extractErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }

  return containsTimeoutMessage(error);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retryWithBackoff<T>(
  run: () => Promise<T>,
  policy: NetworkRetryPolicy,
  shouldRetry: (error: unknown) => boolean
): Promise<T> {
  const maxAttempts = policy.retries + 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      return await run();
    } catch (error) {
      attempt += 1;

      const canRetry = attempt < maxAttempts && shouldRetry(error);
      if (!canRetry) {
        throw error;
      }

      await sleep(policy.retryDelayMs * attempt);
    }
  }

  throw new AppError("E_INVALID_INPUT", "Unexpected retry loop termination.");
}
