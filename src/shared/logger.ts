/**
 * Structured console logger with level filtering and module context.
 */

import type { Logger, LogLevel, UnknownRecord } from './types.js';

/**
 * Console-backed structured logger for v1 plugin runtime.
 */
export class ConsoleLogger implements Logger {
  private readonly moduleName: string;

  /**
   * Creates a logger scoped to a module.
   */
  public constructor(moduleName: string) {
    this.moduleName = moduleName;
  }

  /**
   * Writes a debug-level log entry.
   */
  public debug(message: string, context?: UnknownRecord): void {
    this.log('debug', message, context);
  }

  /**
   * Writes an info-level log entry.
   */
  public info(message: string, context?: UnknownRecord): void {
    this.log('info', message, context);
  }

  /**
   * Writes a warning-level log entry.
   */
  public warn(message: string, context?: UnknownRecord): void {
    this.log('warn', message, context);
  }

  /**
   * Writes an error-level log entry.
   */
  public error(message: string, context?: UnknownRecord): void {
    this.log('error', message, context);
  }

  /**
   * Formats and emits a structured log record.
   */
  private log(level: LogLevel, message: string, context?: UnknownRecord): void {
    const entry: UnknownRecord = {
      timestamp: new Date().toISOString(),
      level,
      module: this.moduleName,
      message,
      ...(context !== undefined ? { context } : {})
    };

    const serialized = JSON.stringify(entry);
    if (level === 'error') {
      console.error(serialized);
      return;
    }
    if (level === 'warn') {
      console.warn(serialized);
      return;
    }
    if (level === 'info') {
      console.info(serialized);
      return;
    }
    console.debug(serialized);
  }
}

export default ConsoleLogger;
