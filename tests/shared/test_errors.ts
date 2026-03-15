import { describe, expect, it } from 'vitest';
import {
  InvalidConfigError,
  MergeConflictError,
  OverlayNotFoundError,
  ReviewFailedError,
  RollbackLimitExceeded
} from '../../src/shared/errors.ts';

describe('shared/errors', () => {
  it('sets MergeConflictError name to class name', () => {
    const error = new MergeConflictError('merge failed');
    expect(error.name).toBe('MergeConflictError');
  });

  it('sets RollbackLimitExceeded name to class name', () => {
    const error = new RollbackLimitExceeded('too many backups');
    expect(error.name).toBe('RollbackLimitExceeded');
  });

  it('sets OverlayNotFoundError name to class name', () => {
    const error = new OverlayNotFoundError('missing overlay');
    expect(error.name).toBe('OverlayNotFoundError');
  });

  it('sets ReviewFailedError name to class name', () => {
    const error = new ReviewFailedError('review failed');
    expect(error.name).toBe('ReviewFailedError');
  });

  it('sets InvalidConfigError name to class name', () => {
    const error = new InvalidConfigError('invalid');
    expect(error.name).toBe('InvalidConfigError');
  });
});
