export type BobErrorCode =
  | "startup_failed"
  | "configuration_invalid"
  | "cancelled"
  | "timeout"
  | "output_limit"
  | "protocol_failed"
  | "child_exited"
  | "cleanup_failed"
  | "busy"
  | "closed";

const ERROR_MESSAGES = {
  startup_failed: "Bob Gateway could not start.",
  configuration_invalid: "Bob Gateway configuration is invalid.",
  cancelled: "The Bob Gateway operation was cancelled.",
  timeout: "The Bob Gateway operation timed out.",
  output_limit: "The Bob Gateway output limit was exceeded.",
  protocol_failed: "Bob Gateway protocol processing failed.",
  child_exited: "The Bob Gateway child exited unexpectedly.",
  cleanup_failed: "Bob Gateway cleanup failed.",
  busy: "The Bob Gateway client already has an active prompt.",
  closed: "The Bob Gateway client is closed.",
} satisfies Record<BobErrorCode, string>;

export class BobError extends Error {
  readonly code: BobErrorCode;
  readonly cleanupFailed: boolean;

  constructor(code: BobErrorCode, cleanupFailed = false) {
    super(ERROR_MESSAGES[code]);
    this.name = "BobError";
    this.code = code;
    this.cleanupFailed = cleanupFailed;
  }
}

export function withCleanupFailure(error: BobError): BobError {
  return error.cleanupFailed ? error : new BobError(error.code, true);
}
