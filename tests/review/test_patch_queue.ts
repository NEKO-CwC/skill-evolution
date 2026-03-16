import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchQueueManager } from '../../src/review/patch_queue.ts';
import { PatchNotFoundError, PatchStateError } from '../../src/shared/errors.ts';
import { fileExists, readFile } from '../../src/shared/fs.ts';
import type { PatchCandidate, PatchStatus } from '../../src/shared/types.ts';

function makePatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id: `patch_${Date.now()}_test`,
    skillKey: 'skill.alpha',
    status: 'queued',
    risk: 'low',
    sourceSessionIds: ['session-1'],
    createdAt: now,
    updatedAt: now,
    summary: 'Test patch summary',
    justification: 'Test justification',
    proposedDiff: '+ new guidance',
    originalContent: '# Old content',
    artifactVersion: 1,
    ...overrides,
  };
}

describe('review/patch_queue', () => {
  let tempDir: string;
  let patchesDir: string;
  let queue: PatchQueueManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'patch-queue-test-'));
    patchesDir = join(tempDir, '.skill-patches');
    queue = new PatchQueueManager(patchesDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates JSON and MD files and updates index', async () => {
      const candidate = makePatch({ id: 'patch_create_1' });
      const created = await queue.create(candidate);

      expect(created.id).toBe('patch_create_1');
      expect(created.proposalPath).toContain('.md');

      const jsonPath = join(patchesDir, 'skill.alpha', 'patch_create_1.json');
      expect(await fileExists(jsonPath)).toBe(true);

      const mdPath = join(patchesDir, 'skill.alpha', 'patch_create_1.md');
      expect(await fileExists(mdPath)).toBe(true);

      const index = await queue.getIndex();
      expect(index.patches).toHaveLength(1);
      expect(index.patches[0].id).toBe('patch_create_1');
      expect(index.version).toBe(1);
    });

    it('preserves all candidate fields in JSON', async () => {
      const candidate = makePatch({ id: 'patch_fields' });
      await queue.create(candidate);

      const loaded = await queue.get('patch_fields');
      expect(loaded.skillKey).toBe('skill.alpha');
      expect(loaded.risk).toBe('low');
      expect(loaded.proposedDiff).toBe('+ new guidance');
      expect(loaded.originalContent).toBe('# Old content');
      expect(loaded.sourceSessionIds).toEqual(['session-1']);
    });
  });

  describe('get', () => {
    it('returns the full PatchCandidate', async () => {
      await queue.create(makePatch({ id: 'patch_get_1' }));
      const result = await queue.get('patch_get_1');
      expect(result.id).toBe('patch_get_1');
      expect(result.status).toBe('queued');
    });

    it('throws PatchNotFoundError for missing patch', async () => {
      await expect(queue.get('nonexistent')).rejects.toBeInstanceOf(PatchNotFoundError);
    });
  });

  describe('update', () => {
    it('merges partial updates and refreshes index', async () => {
      await queue.create(makePatch({ id: 'patch_upd_1', summary: 'old summary' }));
      const updated = await queue.update('patch_upd_1', { summary: 'new summary' });

      expect(updated.summary).toBe('new summary');
      expect(updated.id).toBe('patch_upd_1');

      const index = await queue.getIndex();
      expect(index.patches[0].summary).toBe('new summary');
    });

    it('does not overwrite id or skillKey', async () => {
      await queue.create(makePatch({ id: 'patch_upd_2', skillKey: 'skill.alpha' }));
      const updated = await queue.update('patch_upd_2', {
        id: 'hacked-id',
        skillKey: 'hacked-skill',
      } as Partial<PatchCandidate>);

      expect(updated.id).toBe('patch_upd_2');
      expect(updated.skillKey).toBe('skill.alpha');
    });
  });

  describe('transition (state machine)', () => {
    it('allows queued -> reviewing', async () => {
      await queue.create(makePatch({ id: 'patch_t1' }));
      const result = await queue.transition('patch_t1', 'reviewing');
      expect(result.status).toBe('reviewing');
    });

    it('allows reviewing -> ready', async () => {
      await queue.create(makePatch({ id: 'patch_t2' }));
      await queue.transition('patch_t2', 'reviewing');
      const result = await queue.transition('patch_t2', 'ready');
      expect(result.status).toBe('ready');
    });

    it('allows ready -> approved -> applied', async () => {
      await queue.create(makePatch({ id: 'patch_t3' }));
      await queue.transition('patch_t3', 'reviewing');
      await queue.transition('patch_t3', 'ready');
      await queue.transition('patch_t3', 'approved');
      const result = await queue.transition('patch_t3', 'applied');
      expect(result.status).toBe('applied');
    });

    it('allows ready -> rejected', async () => {
      await queue.create(makePatch({ id: 'patch_t4' }));
      await queue.transition('patch_t4', 'reviewing');
      await queue.transition('patch_t4', 'ready');
      const result = await queue.transition('patch_t4', 'rejected');
      expect(result.status).toBe('rejected');
    });

    it('allows ready -> notified -> approved', async () => {
      await queue.create(makePatch({ id: 'patch_t5' }));
      await queue.transition('patch_t5', 'reviewing');
      await queue.transition('patch_t5', 'ready');
      await queue.transition('patch_t5', 'notified');
      const result = await queue.transition('patch_t5', 'approved');
      expect(result.status).toBe('approved');
    });

    it('allows queued -> superseded', async () => {
      await queue.create(makePatch({ id: 'patch_t6' }));
      const result = await queue.transition('patch_t6', 'superseded');
      expect(result.status).toBe('superseded');
    });

    it('allows any state -> failed', async () => {
      await queue.create(makePatch({ id: 'patch_t7' }));
      await queue.transition('patch_t7', 'reviewing');
      const result = await queue.transition('patch_t7', 'failed');
      expect(result.status).toBe('failed');
    });

    it('is idempotent for same-status transition', async () => {
      await queue.create(makePatch({ id: 'patch_t8' }));
      const result = await queue.transition('patch_t8', 'queued');
      expect(result.status).toBe('queued');
    });

    it('throws PatchStateError for invalid transition', async () => {
      await queue.create(makePatch({ id: 'patch_t9' }));
      await expect(queue.transition('patch_t9', 'applied')).rejects.toBeInstanceOf(PatchStateError);
    });

    it('throws PatchStateError when transitioning from terminal state', async () => {
      await queue.create(makePatch({ id: 'patch_t10' }));
      await queue.transition('patch_t10', 'reviewing');
      await queue.transition('patch_t10', 'ready');
      await queue.transition('patch_t10', 'rejected');
      await expect(queue.transition('patch_t10', 'queued')).rejects.toBeInstanceOf(PatchStateError);
    });

    it('throws PatchStateError for applied -> queued', async () => {
      await queue.create(makePatch({ id: 'patch_t11' }));
      await queue.transition('patch_t11', 'reviewing');
      await queue.transition('patch_t11', 'ready');
      await queue.transition('patch_t11', 'approved');
      await queue.transition('patch_t11', 'applied');
      await expect(queue.transition('patch_t11', 'queued')).rejects.toBeInstanceOf(PatchStateError);
    });
  });

  describe('list', () => {
    it('returns all patches when no filter', async () => {
      await queue.create(makePatch({ id: 'p1', skillKey: 'a' }));
      await queue.create(makePatch({ id: 'p2', skillKey: 'b' }));
      const result = await queue.list();
      expect(result).toHaveLength(2);
    });

    it('filters by skillKey', async () => {
      await queue.create(makePatch({ id: 'p3', skillKey: 'a' }));
      await queue.create(makePatch({ id: 'p4', skillKey: 'b' }));
      const result = await queue.list({ skillKey: 'a' });
      expect(result).toHaveLength(1);
      expect(result[0].skillKey).toBe('a');
    });

    it('filters by status', async () => {
      await queue.create(makePatch({ id: 'p5' }));
      await queue.create(makePatch({ id: 'p6' }));
      await queue.transition('p5', 'reviewing');
      const result = await queue.list({ status: 'reviewing' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('p5');
    });

    it('respects limit', async () => {
      await queue.create(makePatch({ id: 'p7' }));
      await queue.create(makePatch({ id: 'p8' }));
      await queue.create(makePatch({ id: 'p9' }));
      const result = await queue.list({ limit: 2 });
      expect(result).toHaveLength(2);
    });
  });

  describe('supersede', () => {
    it('marks old patch as superseded and links new patch', async () => {
      await queue.create(makePatch({ id: 'old_p', skillKey: 'skill.alpha', sourceSessionIds: ['s1'] }));
      await queue.create(makePatch({ id: 'new_p', skillKey: 'skill.alpha', sourceSessionIds: ['s2'] }));

      await queue.supersede('old_p', 'new_p');

      const oldPatch = await queue.get('old_p');
      expect(oldPatch.status).toBe('superseded');
      expect(oldPatch.supersededBy).toBe('new_p');

      const newPatch = await queue.get('new_p');
      expect(newPatch.supersedes).toContain('old_p');
      expect(newPatch.sourceSessionIds).toContain('s1');
      expect(newPatch.sourceSessionIds).toContain('s2');
    });

    it('does not supersede patches in terminal state', async () => {
      await queue.create(makePatch({ id: 'applied_p' }));
      await queue.transition('applied_p', 'reviewing');
      await queue.transition('applied_p', 'ready');
      await queue.transition('applied_p', 'approved');
      await queue.transition('applied_p', 'applied');

      await queue.create(makePatch({ id: 'new_p2' }));
      await queue.supersede('applied_p', 'new_p2');

      const applied = await queue.get('applied_p');
      expect(applied.status).toBe('applied');
    });

    it('deduplicates sourceSessionIds', async () => {
      await queue.create(makePatch({ id: 'dup_old', sourceSessionIds: ['s1', 's2'] }));
      await queue.create(makePatch({ id: 'dup_new', sourceSessionIds: ['s2', 's3'] }));
      await queue.supersede('dup_old', 'dup_new');

      const newPatch = await queue.get('dup_new');
      const unique = [...new Set(newPatch.sourceSessionIds)];
      expect(newPatch.sourceSessionIds).toEqual(unique);
      expect(newPatch.sourceSessionIds).toHaveLength(3);
    });
  });

  describe('findPendingForSkill', () => {
    it('returns only queued/reviewing/ready patches for skill', async () => {
      await queue.create(makePatch({ id: 'fp1', skillKey: 'sk1' }));
      await queue.create(makePatch({ id: 'fp2', skillKey: 'sk1' }));
      await queue.create(makePatch({ id: 'fp3', skillKey: 'sk2' }));
      await queue.transition('fp2', 'reviewing');

      const pending = await queue.findPendingForSkill('sk1');
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.id).sort()).toEqual(['fp1', 'fp2']);
    });
  });

  describe('index.json integrity', () => {
    it('maintains correct count after multiple operations', async () => {
      await queue.create(makePatch({ id: 'ix1' }));
      await queue.create(makePatch({ id: 'ix2' }));
      await queue.transition('ix1', 'reviewing');

      const index = await queue.getIndex();
      expect(index.patches).toHaveLength(2);
      expect(index.patches.find((p) => p.id === 'ix1')?.status).toBe('reviewing');
      expect(index.patches.find((p) => p.id === 'ix2')?.status).toBe('queued');
    });

    it('index.json is valid JSON on disk', async () => {
      await queue.create(makePatch({ id: 'ix3' }));
      const indexPath = join(patchesDir, 'index.json');
      const raw = await readFile(indexPath);
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });
});
