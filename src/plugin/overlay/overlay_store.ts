/**
 * Overlay persistence adapter implementing session-local storage contract.
 */

import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OverlayNotFoundError } from '../../shared/errors.js';
import { ensureDir, fileExists, readFile, writeFile, deleteDir } from '../../shared/fs.js';
import { ConsoleLogger } from '../../shared/logger.js';
import type { OverlayEntry, OverlayStore } from '../../shared/types.js';

/**
 * Default overlay store implementation placeholder.
 */
export class OverlayStoreImpl implements OverlayStore {
  private readonly storageDir: string;

  private readonly logger: ConsoleLogger;

  public constructor(storageDir: string = '.skill-overlays') {
    this.storageDir = storageDir;
    this.logger = new ConsoleLogger('plugin.overlay_store');
  }

  /**
   * Stores a new overlay entry.
   */
  public async create(entry: OverlayEntry): Promise<void> {
    const overlayPath = this.getOverlayPath(entry.sessionId, entry.skillKey);
    await ensureDir(dirname(overlayPath));
    await writeFile(overlayPath, JSON.stringify(entry, null, 2));
    this.logger.debug('Overlay created', { sessionId: entry.sessionId, skillKey: entry.skillKey, path: overlayPath });
  }

  /**
   * Reads an overlay entry by session and skill.
   */
  public async read(sessionId: string, skillKey: string): Promise<OverlayEntry | null> {
    const overlayPath = this.getOverlayPath(sessionId, skillKey);
    if (!(await fileExists(overlayPath))) {
      return null;
    }

    const raw = await readFile(overlayPath);
    return this.parseOverlay(raw, overlayPath);
  }

  /**
   * Updates an existing overlay entry.
   */
  public async update(sessionId: string, skillKey: string, partial: Partial<OverlayEntry>): Promise<void> {
    const current = await this.read(sessionId, skillKey);
    if (current === null) {
      throw new OverlayNotFoundError(`Overlay not found for session=${sessionId}, skillKey=${skillKey}`);
    }

    const next: OverlayEntry = {
      ...current,
      ...partial,
      sessionId: current.sessionId,
      skillKey: current.skillKey
    };

    await this.create(next);
    this.logger.debug('Overlay updated', { sessionId, skillKey });
  }

  /**
   * Deletes an overlay entry.
   */
  public async delete(sessionId: string, skillKey: string): Promise<void> {
    const overlayPath = this.getOverlayPath(sessionId, skillKey);
    await rm(overlayPath, { force: true });
    this.logger.debug('Overlay deleted', { sessionId, skillKey, path: overlayPath });
  }

  /**
   * Lists overlays for a session.
   */
  public async listBySession(sessionId: string): Promise<OverlayEntry[]> {
    const sessionDir = this.getSessionDir(sessionId);
    if (!(await fileExists(sessionDir))) {
      return [];
    }

    const entries = await readdir(sessionDir, { withFileTypes: true });
    const overlays: OverlayEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const filePath = join(sessionDir, entry.name);
      const raw = await readFile(filePath);
      overlays.push(this.parseOverlay(raw, filePath));
    }

    return overlays;
  }

  /**
   * Clears all overlays in a session.
   */
  public async clearSession(sessionId: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    await deleteDir(sessionDir);
    this.logger.info('Session overlays cleared', { sessionId, path: sessionDir });
  }

  private getSessionDir(sessionId: string): string {
    return join(this.storageDir, encodeURIComponent(sessionId));
  }

  private getOverlayPath(sessionId: string, skillKey: string): string {
    return join(this.getSessionDir(sessionId), `${encodeURIComponent(skillKey)}.json`);
  }

  private parseOverlay(content: string, path: string): OverlayEntry {
    const parsed = JSON.parse(content) as OverlayEntry;
    this.logger.debug('Overlay read from storage', {
      sessionId: parsed.sessionId,
      skillKey: parsed.skillKey,
      path
    });
    return parsed;
  }
}

export default OverlayStoreImpl;
