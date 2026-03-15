/**
 * Custom domain error classes for plugin-level failure handling.
 */

/**
 * Raised when a patch cannot be applied due to merge conflicts.
 */
export class MergeConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

/**
 * Raised when rollback history exceeds configured limits.
 */
export class RollbackLimitExceeded extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RollbackLimitExceeded';
  }
}

/**
 * Raised when an expected session overlay cannot be found.
 */
export class OverlayNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OverlayNotFoundError';
  }
}

/**
 * Raised when review execution fails or cannot complete safely.
 */
export class ReviewFailedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReviewFailedError';
  }
}

/**
 * Raised when plugin configuration is missing fields or invalid.
 */
export class InvalidConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}
