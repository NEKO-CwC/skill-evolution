import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchQueueManager } from '../../src/review/patch_queue.ts';
import { fileExists, readFile } from '../../src/shared/fs.ts';
import type { PatchCandidate } from '../../src/shared/types.ts';

function makePatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id: `patch_multi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    skillKey: 'skill.multi',
    status: 'queued',
    risk: 'low',
    sourceSessionIds: ['s1'],
    createdAt: now,
    updatedAt: now,
    summary: 'multi-session test',
    justification: 'test',
    proposedDiff: 'diff',
    originalContent: 'original',
    artifactVersion: 1,
    ...overrides,
  };
}

describe('regression/multi_session', () => {
  let tempDir: string;
  let patchesDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multi-session-test-'));
    patchesDir = join(tempDir, '.skill-patches');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('two sessions create patches for same skill without index corruption', async () => {
    const queue = new PatchQueueManager(patchesDir);

    const p1 = makePatch({ id: 'ms_p1', sourceSessionIds: ['session-A'] });
    const p2 = makePatch({ id: 'ms_p2', sourceSessionIds: ['session-B'] });

    // Create both patches (simulating concurrent sessions)
    await queue.create(p1);
    await queue.create(p2);

    // Index should have both
    const index = await queue.getIndex();
    expect(index.patches).toHaveLength(2);
    expect(index.patches.map((p) => p.id).sort()).toEqual(['ms_p1', 'ms_p2']);

    // Index.json should be valid JSON
    const indexPath = join(patchesDir, 'index.json');
    expect(await fileExists(indexPath)).toBe(true);
    const raw = await readFile(indexPath);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('sourceSessionIds accumulate correctly via supersede', async () => {
    const queue = new PatchQueueManager(patchesDir);

    const p1 = makePatch({ id: 'ms_acc_1', sourceSessionIds: ['s1', 's2'] });
    const p2 = makePatch({ id: 'ms_acc_2', sourceSessionIds: ['s3'] });

    await queue.create(p1);
    await queue.create(p2);

    await queue.supersede('ms_acc_1', 'ms_acc_2');

    const newPatch = await queue.get('ms_acc_2');
    expect(newPatch.sourceSessionIds).toContain('s1');
    expect(newPatch.sourceSessionIds).toContain('s2');
    expect(newPatch.sourceSessionIds).toContain('s3');
    expect([...new Set(newPatch.sourceSessionIds)]).toEqual(newPatch.sourceSessionIds);
  });

  it('supersede handles multiple patches in sequence', async () => {
    const queue = new PatchQueueManager(patchesDir);

    const patches = [];
    for (let i = 0; i < 4; i++) {
      const p = makePatch({ id: `ms_seq_${i}`, sourceSessionIds: [`s${i}`] });
      await queue.create(p);
      patches.push(p);
    }

    // Each supersedes the previous
    for (let i = 0; i < 3; i++) {
      await queue.supersede(`ms_seq_${i}`, `ms_seq_${i + 1}`);
    }

    // Only the last should be pending
    const pending = await queue.findPendingForSkill('skill.multi');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('ms_seq_3');

    // Should have all session IDs
    const final = await queue.get('ms_seq_3');
    expect(final.sourceSessionIds).toHaveLength(4);
  });

  it('concurrent transitions on different patches do not interfere', async () => {
    const queue = new PatchQueueManager(patchesDir);

    await queue.create(makePatch({ id: 'conc_1' }));
    await queue.create(makePatch({ id: 'conc_2' }));

    // Transition both concurrently
    await Promise.all([
      queue.transition('conc_1', 'reviewing'),
      queue.transition('conc_2', 'reviewing'),
    ]);

    const p1 = await queue.get('conc_1');
    const p2 = await queue.get('conc_2');
    expect(p1.status).toBe('reviewing');
    expect(p2.status).toBe('reviewing');

    // Index should reflect both
    const index = await queue.getIndex();
    const statuses = index.patches.map((p) => p.status);
    expect(statuses.filter((s) => s === 'reviewing')).toHaveLength(2);
  });
});
