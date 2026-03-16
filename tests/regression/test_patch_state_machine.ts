import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchQueueManager } from '../../src/review/patch_queue.ts';
import { PatchStateError } from '../../src/shared/errors.ts';
import type { PatchCandidate, PatchStatus } from '../../src/shared/types.ts';

function makePatch(id: string): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id,
    skillKey: 'test-skill',
    status: 'queued',
    risk: 'low',
    sourceSessionIds: ['s1'],
    createdAt: now,
    updatedAt: now,
    summary: 'test',
    justification: 'test',
    proposedDiff: 'diff',
    originalContent: 'original',
    artifactVersion: 1,
  };
}

describe('regression/patch_state_machine', () => {
  let tempDir: string;
  let queue: PatchQueueManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'state-machine-test-'));
    queue = new PatchQueueManager(join(tempDir, '.skill-patches'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('valid full lifecycle paths', () => {
    it('queued -> reviewing -> ready -> notified -> approved -> applied', async () => {
      await queue.create(makePatch('lifecycle-1'));
      const steps: PatchStatus[] = ['reviewing', 'ready', 'notified', 'approved', 'applied'];
      for (const status of steps) {
        const result = await queue.transition('lifecycle-1', status);
        expect(result.status).toBe(status);
      }
    });

    it('queued -> reviewing -> ready -> approved -> applied (skip notified)', async () => {
      await queue.create(makePatch('lifecycle-2'));
      const steps: PatchStatus[] = ['reviewing', 'ready', 'approved', 'applied'];
      for (const status of steps) {
        const result = await queue.transition('lifecycle-2', status);
        expect(result.status).toBe(status);
      }
    });

    it('queued -> reviewing -> ready -> rejected', async () => {
      await queue.create(makePatch('lifecycle-3'));
      const steps: PatchStatus[] = ['reviewing', 'ready', 'rejected'];
      for (const status of steps) {
        const result = await queue.transition('lifecycle-3', status);
        expect(result.status).toBe(status);
      }
    });

    it('queued -> superseded', async () => {
      await queue.create(makePatch('lifecycle-4'));
      const result = await queue.transition('lifecycle-4', 'superseded');
      expect(result.status).toBe('superseded');
    });

    it('reviewing -> superseded', async () => {
      await queue.create(makePatch('lifecycle-5'));
      await queue.transition('lifecycle-5', 'reviewing');
      const result = await queue.transition('lifecycle-5', 'superseded');
      expect(result.status).toBe('superseded');
    });

    it('ready -> superseded', async () => {
      await queue.create(makePatch('lifecycle-6'));
      await queue.transition('lifecycle-6', 'reviewing');
      await queue.transition('lifecycle-6', 'ready');
      const result = await queue.transition('lifecycle-6', 'superseded');
      expect(result.status).toBe('superseded');
    });
  });

  describe('failed from any non-terminal state', () => {
    const nonTerminalStates: PatchStatus[] = ['queued', 'reviewing', 'ready', 'notified', 'approved'];

    for (const state of nonTerminalStates) {
      it(`${state} -> failed`, async () => {
        const id = `fail-from-${state}`;
        await queue.create(makePatch(id));

        // Walk to target state
        const path: Record<string, PatchStatus[]> = {
          queued: [],
          reviewing: ['reviewing'],
          ready: ['reviewing', 'ready'],
          notified: ['reviewing', 'ready', 'notified'],
          approved: ['reviewing', 'ready', 'approved'],
        };
        for (const step of path[state]) {
          await queue.transition(id, step);
        }

        const result = await queue.transition(id, 'failed');
        expect(result.status).toBe('failed');
      });
    }
  });

  describe('invalid transitions throw PatchStateError', () => {
    const invalidPairs: Array<[PatchStatus[], PatchStatus]> = [
      // From queued: cannot jump to ready, notified, approved, applied, rejected
      [[], 'ready'],
      [[], 'notified'],
      [[], 'approved'],
      [[], 'applied'],
      [[], 'rejected'],
      // From reviewing: cannot go back or skip
      [['reviewing'], 'queued'],
      [['reviewing'], 'notified'],
      [['reviewing'], 'approved'],
      [['reviewing'], 'applied'],
      [['reviewing'], 'rejected'],
      // From terminal states: no transitions
      [['reviewing', 'ready', 'rejected'], 'queued'],
      [['reviewing', 'ready', 'rejected'], 'reviewing'],
      [['reviewing', 'ready', 'approved', 'applied'], 'queued'],
      [['reviewing', 'ready', 'approved', 'applied'], 'reviewing'],
      [['superseded' as PatchStatus], 'queued'],
    ];

    for (const [path, target] of invalidPairs) {
      const fromState = path.length > 0 ? path[path.length - 1] : 'queued';
      it(`${fromState} -> ${target} throws`, async () => {
        const id = `invalid-${fromState}-${target}`;
        await queue.create(makePatch(id));

        // Walk to state except 'superseded' which we handle specially
        if (path.length > 0 && path[0] !== 'superseded') {
          for (const step of path) {
            await queue.transition(id, step);
          }
        } else if (path.length > 0 && path[0] === 'superseded') {
          await queue.transition(id, 'superseded');
        }

        await expect(queue.transition(id, target)).rejects.toBeInstanceOf(PatchStateError);
      });
    }
  });
});
