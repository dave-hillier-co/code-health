export const ExitCode = {
  Success: 0,
  /** Findings above guideline or a regression. */
  CheckFailed: 1,
  /** Bad arguments or invalid config. */
  Usage: 2,
  /** Not a git repo, shallow clone without a window, Node too old. */
  Environment: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  readonly exitCode: ExitCodeValue;
  /** Stable machine-readable identifier, for example `usage` or `not-a-git-repo`. */
  readonly code: string;

  constructor(exitCode: ExitCodeValue, code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function usageError(message: string): CliError {
  return new CliError(ExitCode.Usage, "usage", message);
}

export function configError(message: string): CliError {
  return new CliError(ExitCode.Usage, "config", message);
}

export function environmentError(code: string, message: string): CliError {
  return new CliError(ExitCode.Environment, code, message);
}
