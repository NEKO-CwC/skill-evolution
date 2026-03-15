import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDir, readFile, writeFile, deleteDir, fileExists } from '../../src/shared/fs.ts';

describe('shared/fs', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-fs-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('ensureDir creates nested directories recursively', async () => {
    const nestedDir = join(tempDir, 'a', 'b', 'c');
    await ensureDir(nestedDir);
    await expect(fileExists(nestedDir)).resolves.toBe(true);
  });

  it('ensureDir throws wrapped error when target path is an existing file', async () => {
    const filePath = join(tempDir, 'already-file');
    await writeFile(filePath, 'data');

    await expect(ensureDir(filePath)).rejects.toThrow(`Failed to ensure directory at ${filePath}`);
  });

  it('writeFile writes UTF-8 content and readFile reads the same content', async () => {
    const filePath = join(tempDir, 'content.txt');
    const content = 'hello skill evolution';

    await writeFile(filePath, content);
    await expect(readFile(filePath)).resolves.toBe(content);
  });

  it('readFile throws wrapped error for missing file path', async () => {
    const missingPath = join(tempDir, 'missing.txt');
    await expect(readFile(missingPath)).rejects.toThrow(`Failed to read file at ${missingPath}`);
  });

  it('writeFile throws wrapped error when parent directory does not exist', async () => {
    const filePath = join(tempDir, 'no-parent', 'file.txt');
    await expect(writeFile(filePath, 'x')).rejects.toThrow(`Failed to write file at ${filePath}`);
  });

  it('deleteDir removes a directory recursively', async () => {
    const dirToDelete = join(tempDir, 'to-delete', 'nested');
    await ensureDir(dirToDelete);
    await writeFile(join(dirToDelete, 'x.txt'), 'x');

    await deleteDir(join(tempDir, 'to-delete'));
    await expect(fileExists(join(tempDir, 'to-delete'))).resolves.toBe(false);
  });

  it('fileExists returns false for non-existent path', async () => {
    await expect(fileExists(join(tempDir, 'none'))).resolves.toBe(false);
  });
});
