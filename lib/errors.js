/**
 * Every failure in this app is a typed AppError. Nothing fails silently:
 * the code is machine-readable, the message is what we show the user, and
 * `detail` carries the "what exactly went wrong / what is missing" text that
 * the eligibility rules surface as the reason for UNABLE_TO_VERIFY.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, detail = null, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export const CODES = {
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
  UNSUPPORTED_CHAIN: 'UNSUPPORTED_CHAIN',
  RATE_LIMITED: 'RATE_LIMITED',
  RPC_FAILURE: 'RPC_FAILURE',
  UPSTREAM_FAILURE: 'UPSTREAM_FAILURE',
  NEEDS_API_KEY: 'NEEDS_API_KEY',
  ALLOWLIST_UNAVAILABLE: 'ALLOWLIST_UNAVAILABLE',
  REQUIRES_PRIVATE_AUTH: 'REQUIRES_PRIVATE_AUTH',
  AMBIGUOUS_PHASES: 'AMBIGUOUS_PHASES',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
};

export const fail = (code, message, opts) => {
  throw new AppError(code, message, opts);
};
