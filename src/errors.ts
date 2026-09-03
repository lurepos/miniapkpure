export type AppErrorCode =
  | "E_INVALID_INPUT"
  | "E_PACKAGE_NOT_FOUND"
  | "E_NO_TRACKED_PACKAGES"
  | "E_REMOTE_FETCH_FAILED"
  | "E_DOWNLOAD_FAILED"
  | "E_NON_INTERACTIVE_INPUT_REQUIRED";

const EXIT_CODE_BY_ERROR: Record<AppErrorCode, number> = {
  E_INVALID_INPUT: 2,
  E_PACKAGE_NOT_FOUND: 2,
  E_NO_TRACKED_PACKAGES: 2,
  E_REMOTE_FETCH_FAILED: 3,
  E_DOWNLOAD_FAILED: 4,
  E_NON_INTERACTIVE_INPUT_REQUIRED: 2,
};

export class AppError extends Error {
  readonly code: AppErrorCode;

  readonly exitCode: number;

  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.exitCode = EXIT_CODE_BY_ERROR[code];
    this.details = details;
    this.name = "AppError";
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError("E_INVALID_INPUT", error.message);
  }

  return new AppError("E_INVALID_INPUT", "Unexpected error.", { error });
}
