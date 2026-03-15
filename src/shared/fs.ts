/**
 * File system helpers wrapping Node fs/promises with safe error messages.
 */

import { access, mkdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';

/**
 * Ensures a directory exists, including parent directories.
 */
export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error: unknown) {
    throw new Error(`Failed to ensure directory at ${path}: ${toErrorMessage(error)}`);
  }
}

/**
 * Reads UTF-8 text content from a file.
 */
export async function readFile(path: string): Promise<string> {
  try {
    return await fsReadFile(path, { encoding: 'utf8' });
  } catch (error: unknown) {
    throw new Error(`Failed to read file at ${path}: ${toErrorMessage(error)}`);
  }
}

/**
 * Writes UTF-8 text content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  try {
    await fsWriteFile(path, content, { encoding: 'utf8' });
  } catch (error: unknown) {
    throw new Error(`Failed to write file at ${path}: ${toErrorMessage(error)}`);
  }
}

/**
 * Deletes a directory recursively if it exists.
 */
export async function deleteDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error: unknown) {
    throw new Error(`Failed to delete directory at ${path}: ${toErrorMessage(error)}`);
  }
}

/**
 * Checks whether a file system path exists.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts unknown caught values into readable error text.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
