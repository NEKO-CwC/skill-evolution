/**
 * Patch queue manager: CRUD for PatchCandidate, index maintenance, state machine.
 */

import { join } from 'node:path';
import { open, readdir, unlink } from 'node:fs/promises';
import { PatchNotFoundError, PatchStateError } from '../shared/errors.js';
import { ensureDir, fileExists, readFile, writeFile } from '../shared/fs.js';
import ConsoleLogger from '../shared/logger.js';
import type {
  PatchCandidate,
  PatchIndexEntry,
  PatchQueue,
  PatchQueueIndex,
  PatchStatus,
} from '../shared/types.js';

const VALID_TRANSITIONS: Record<PatchStatus, PatchStatus[]> = {
  queued: ['reviewing', 'superseded', 'failed'],
  reviewing: ['ready', 'superseded', 'failed'],
  ready: ['notified', 'approved', 'rejected', 'superseded', 'failed'],
  notified: ['approved', 'rejected', 'failed'],
  approved: ['applied', 'failed'],
  rejected: [],
  applied: [],
  superseded: [],
  failed: [],
};

const LOCK_RETRY_COUNT = 3;
const LOCK_RETRY_BASE_MS = 50;

export class PatchQueueManager implements PatchQueue {
  private readonly patchesDir: string;
  private readonly logger = new ConsoleLogger('patch_queue');

  public constructor(patchesDir: string) {
    this.patchesDir = patchesDir;
  }

  public async create(candidate: PatchCandidate): Promise<PatchCandidate> {
    const skillDir = join(this.patchesDir, candidate.skillKey);
    await ensureDir(skillDir);

    const jsonPath = this.getCandidatePath(candidate.skillKey, candidate.id);
    await writeFile(jsonPath, JSON.stringify(candidate, null, 2));

    const mdPath = join(skillDir, `${candidate.id}.md`);
    await writeFile(mdPath, this.formatMdSummary(candidate));
    candidate.proposalPath = mdPath;

    await this.updateIndex((index) => {
      index.patches.push(this.toIndexEntry(candidate));
      return index;
    });

    this.logger.info('Patch candidate created', {
      patchId: candidate.id,
      skillKey: candidate.skillKey,
      status: candidate.status,
    });

    return candidate;
  }

  public async get(patchId: string): Promise<PatchCandidate> {
    const entry = await this.findEntryById(patchId);
    if (!entry) {
      throw new PatchNotFoundError(`Patch not found: ${patchId}`);
    }
    const jsonPath = this.getCandidatePath(entry.skillKey, patchId);
    if (!(await fileExists(jsonPath))) {
      throw new PatchNotFoundError(`Patch file not found: ${jsonPath}`);
    }
    const raw = await readFile(jsonPath);
    return JSON.parse(raw) as PatchCandidate;
  }

  public async update(patchId: string, updates: Partial<PatchCandidate>): Promise<PatchCandidate> {
    const current = await this.get(patchId);
    const updated: PatchCandidate = {
      ...current,
      ...updates,
      id: current.id,
      skillKey: current.skillKey,
      updatedAt: new Date().toISOString(),
    };

    const jsonPath = this.getCandidatePath(current.skillKey, patchId);
    await writeFile(jsonPath, JSON.stringify(updated, null, 2));

    await this.updateIndex((index) => {
      const idx = index.patches.findIndex((p) => p.id === patchId);
      if (idx >= 0) {
        index.patches[idx] = this.toIndexEntry(updated);
      }
      return index;
    });

    return updated;
  }

  public async transition(patchId: string, newStatus: PatchStatus): Promise<PatchCandidate> {
    const current = await this.get(patchId);

    if (current.status === newStatus) {
      return current;
    }

    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new PatchStateError(
        `Invalid transition: ${current.status} -> ${newStatus} for patch ${patchId}`
      );
    }

    return this.update(patchId, { status: newStatus });
  }

  public async list(
    filter?: { skillKey?: string; status?: PatchStatus; limit?: number }
  ): Promise<PatchIndexEntry[]> {
    const index = await this.getIndex();
    let results = index.patches;

    if (filter?.skillKey) {
      results = results.filter((p) => p.skillKey === filter.skillKey);
    }
    if (filter?.status) {
      results = results.filter((p) => p.status === filter.status);
    }
    if (filter?.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  public async supersede(oldPatchId: string, newPatchId: string): Promise<void> {
    const oldPatch = await this.get(oldPatchId);
    const newPatch = await this.get(newPatchId);

    const supersedeableStatuses: PatchStatus[] = ['queued', 'reviewing', 'ready'];
    if (!supersedeableStatuses.includes(oldPatch.status)) {
      this.logger.warn('Cannot supersede patch in terminal state', {
        patchId: oldPatchId,
        status: oldPatch.status,
      });
      return;
    }

    await this.update(oldPatchId, {
      status: 'superseded',
      supersededBy: newPatchId,
    });

    const supersedes = newPatch.supersedes ?? [];
    if (!supersedes.includes(oldPatchId)) {
      supersedes.push(oldPatchId);
    }
    const mergedSessionIds = [...new Set([...newPatch.sourceSessionIds, ...oldPatch.sourceSessionIds])];
    await this.update(newPatchId, {
      supersedes,
      sourceSessionIds: mergedSessionIds,
    });
  }

  public async getIndex(): Promise<PatchQueueIndex> {
    const indexPath = this.getIndexPath();
    if (!(await fileExists(indexPath))) {
      return { version: 1, updatedAt: new Date().toISOString(), patches: [] };
    }
    const raw = await readFile(indexPath);
    return JSON.parse(raw) as PatchQueueIndex;
  }

  public async findPendingForSkill(skillKey: string): Promise<PatchIndexEntry[]> {
    const pendingStatuses: PatchStatus[] = ['queued', 'reviewing', 'ready'];
    const index = await this.getIndex();
    return index.patches.filter(
      (p) => p.skillKey === skillKey && pendingStatuses.includes(p.status)
    );
  }

  private async updateIndex(
    mutator: (index: PatchQueueIndex) => PatchQueueIndex
  ): Promise<void> {
    await ensureDir(this.patchesDir);
    const lockPath = join(this.patchesDir, 'index.lock');
    let lockHandle: import('node:fs/promises').FileHandle | null = null;

    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
      try {
        lockHandle = await open(lockPath, 'wx');
        break;
      } catch {
        if (attempt < LOCK_RETRY_COUNT - 1) {
          const delay = LOCK_RETRY_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    try {
      const index = await this.getIndex();
      const updated = mutator(index);
      updated.updatedAt = new Date().toISOString();
      const indexPath = this.getIndexPath();
      await writeFile(indexPath, JSON.stringify(updated, null, 2));
    } finally {
      if (lockHandle) {
        await lockHandle.close();
        try {
          await unlink(lockPath);
        } catch {
          // lock file already removed
        }
      }
    }
  }

  private async findEntryById(patchId: string): Promise<PatchIndexEntry | null> {
    const index = await this.getIndex();
    return index.patches.find((p) => p.id === patchId) ?? null;
  }

  private getCandidatePath(skillKey: string, patchId: string): string {
    return join(this.patchesDir, skillKey, `${patchId}.json`);
  }

  private getIndexPath(): string {
    return join(this.patchesDir, 'index.json');
  }

  private toIndexEntry(candidate: PatchCandidate): PatchIndexEntry {
    return {
      id: candidate.id,
      skillKey: candidate.skillKey,
      status: candidate.status,
      risk: candidate.risk,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      summary: candidate.summary,
    };
  }

  private formatMdSummary(candidate: PatchCandidate): string {
    return [
      `--- PATCH: ${candidate.skillKey} ---`,
      `Patch ID: ${candidate.id}`,
      `Risk: ${candidate.risk}`,
      `Status: ${candidate.status}`,
      `Sessions: ${candidate.sourceSessionIds.join(', ')}`,
      `Created: ${candidate.createdAt}`,
      '',
      '## Summary',
      candidate.summary,
      '',
      '## Justification',
      candidate.justification,
      '',
      '## Proposed Changes',
      candidate.proposedDiff,
      '',
      '## Original Content',
      candidate.originalContent,
    ].join('\n');
  }
}

export default PatchQueueManager;
