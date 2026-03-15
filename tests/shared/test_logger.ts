import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '../../src/shared/logger.ts';

describe('shared/logger', () => {
  const logger = new ConsoleLogger('test_module');

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes error level logs to console.error', () => {
    logger.error('failed merge', { patchId: 'p1' });
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('routes warn level logs to console.warn', () => {
    logger.warn('possible conflict');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('routes info level logs to console.info', () => {
    logger.info('review complete');
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
  });

  it('routes debug level logs to console.debug', () => {
    logger.debug('overlay created');
    expect(console.debug).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it('serializes log record with module, message, and context fields', () => {
    logger.info('contextual', { key: 'value' });
    const callArg = vi.mocked(console.info).mock.calls[0]?.[0];
    expect(typeof callArg).toBe('string');

    const parsed = JSON.parse(String(callArg)) as {
      level: string;
      module: string;
      message: string;
      context?: { key?: string };
    };

    expect(parsed.level).toBe('info');
    expect(parsed.module).toBe('test_module');
    expect(parsed.message).toBe('contextual');
    expect(parsed.context?.key).toBe('value');
  });
});
