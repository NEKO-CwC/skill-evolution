import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PatchQueueManager } from '../../../src/review/patch_queue.ts';
import { MergeManagerImpl } from '../../../src/review/merge_manager.ts';
import RollbackManagerImpl from '../../../src/review/rollback_manager.ts';
import { getDefaultConfig } from '../../../src/plugin/config.ts';
import { ensureDir, writeFile } from '../../../src/shared/fs.ts';
import {
  patchList,
  patchGet,
  patchApply,
  patchReject,
  patchStatus,
  reviewEnqueue,
  patchNotify,
  type PatchToolDeps,
} from '../../../src/plugin/tools/patch_tools.ts';
import { makeTools } from '../../../src/plugin/tools/index.ts';
import type { PatchCandidate } from '../../../src/shared/types.ts';

function makePatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id: `patch_tool_${Date.now()}`,
    skillKey: 'skill.tools',
    status: 'queued',
    risk: 'low',
    sourceSessionIds: ['session-1'],
    createdAt: now,
    updatedAt: now,
    summary: 'Tool test patch',
    justification: 'Test justification',
    proposedDiff: 'new tool content',
    originalContent: '# old content',
    artifactVersion: 1,
    ...overrides,
  };
}

describe('plugin/tools/patch_tools', () => {
  let tempDir: string;
  let deps: PatchToolDeps;
  let patchesDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'patch-tools-test-'));
    patchesDir = join(tempDir, '.skill-patches');
    skillsDir = join(tempDir, 'skills');
    const backupsDir = join(tempDir, '.skill-backups');

    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
    const mergeManager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);
    const patchQueue = new PatchQueueManager(patchesDir);

    deps = { patchQueue, mergeManager };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('patch_list', () => {
    it('returns all patches when no filter', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pl1', skillKey: 'a' }));
      await deps.patchQueue.create(makePatch({ id: 'pl2', skillKey: 'b' }));

      const result = await patchList(deps, {}) as Array<unknown>;
      expect(result).toHaveLength(2);
    });

    it('filters by skillKey', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pl3', skillKey: 'a' }));
      await deps.patchQueue.create(makePatch({ id: 'pl4', skillKey: 'b' }));

      const result = await patchList(deps, { skillKey: 'a' }) as Array<unknown>;
      expect(result).toHaveLength(1);
    });

    it('filters by status', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pl5' }));
      await deps.patchQueue.create(makePatch({ id: 'pl6' }));
      await deps.patchQueue.transition('pl5', 'reviewing');

      const result = await patchList(deps, { status: 'reviewing' }) as Array<unknown>;
      expect(result).toHaveLength(1);
    });

    it('respects limit', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pl7' }));
      await deps.patchQueue.create(makePatch({ id: 'pl8' }));
      await deps.patchQueue.create(makePatch({ id: 'pl9' }));

      const result = await patchList(deps, { limit: 2 }) as Array<unknown>;
      expect(result).toHaveLength(2);
    });
  });

  describe('patch_get', () => {
    it('returns full patch candidate', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pg1' }));
      const result = await patchGet(deps, { patchId: 'pg1' }) as PatchCandidate;
      expect(result.id).toBe('pg1');
      expect(result.proposedDiff).toBe('new tool content');
      expect(result.originalContent).toBe('# old content');
    });

    it('returns error for missing patch', async () => {
      const result = await patchGet(deps, { patchId: 'nonexistent' }) as { success: false; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error when patchId missing', async () => {
      const result = await patchGet(deps, {}) as { success: false; error: string };
      expect(result.success).toBe(false);
    });
  });

  describe('patch_apply', () => {
    it('applies patch and transitions to applied', async () => {
      const skillPath = join(skillsDir, 'skill.tools', 'SKILL.md');
      await ensureDir(dirname(skillPath));
      await writeFile(skillPath, 'old content');

      await deps.patchQueue.create(makePatch({ id: 'pa1', status: 'queued' }));

      const result = await patchApply(deps, { patchId: 'pa1' }) as { success: boolean; patchId: string; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('applied');

      const updated = await deps.patchQueue.get('pa1');
      expect(updated.status).toBe('applied');
    });

    it('is idempotent for already applied patches', async () => {
      const skillPath = join(skillsDir, 'skill.tools', 'SKILL.md');
      await ensureDir(dirname(skillPath));
      await writeFile(skillPath, 'old content');

      await deps.patchQueue.create(makePatch({ id: 'pa2' }));
      await patchApply(deps, { patchId: 'pa2' });

      const result = await patchApply(deps, { patchId: 'pa2' }) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('applied');
    });

    it('returns error for missing patchId', async () => {
      const result = await patchApply(deps, {}) as { success: false };
      expect(result.success).toBe(false);
    });
  });

  describe('patch_reject', () => {
    it('rejects patch with reason', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pr1' }));

      const result = await patchReject(deps, { patchId: 'pr1', reason: 'Not applicable' }) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');

      const updated = await deps.patchQueue.get('pr1');
      expect(updated.status).toBe('rejected');
      expect(updated.justification).toContain('Not applicable');
    });

    it('is idempotent for already rejected patches', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pr2' }));
      await patchReject(deps, { patchId: 'pr2' });

      const result = await patchReject(deps, { patchId: 'pr2' }) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
    });
  });

  describe('patch_status', () => {
    it('returns patchId, status, risk, summary', async () => {
      await deps.patchQueue.create(makePatch({ id: 'ps1', risk: 'medium', summary: 'My summary' }));

      const result = await patchStatus(deps, { patchId: 'ps1' }) as Record<string, unknown>;
      expect(result.patchId).toBe('ps1');
      expect(result.status).toBe('queued');
      expect(result.risk).toBe('medium');
      expect(result.summary).toBe('My summary');
    });

    it('returns error for missing patch', async () => {
      const result = await patchStatus(deps, { patchId: 'nonexistent' }) as { success: false };
      expect(result.success).toBe(false);
    });
  });

  describe('review_enqueue', () => {
    it('transitions queued patch to reviewing', async () => {
      await deps.patchQueue.create(makePatch({ id: 're1' }));

      const result = await reviewEnqueue(deps, { patchId: 're1' }) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('reviewing');
    });

    it('is idempotent for already reviewing patches', async () => {
      await deps.patchQueue.create(makePatch({ id: 're2' }));
      await deps.patchQueue.transition('re2', 'reviewing');

      const result = await reviewEnqueue(deps, { patchId: 're2' }) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('reviewing');
    });

    it('returns error for invalid transition', async () => {
      await deps.patchQueue.create(makePatch({ id: 're3' }));
      await deps.patchQueue.transition('re3', 'reviewing');
      await deps.patchQueue.transition('re3', 'ready');
      await deps.patchQueue.transition('re3', 'rejected');

      const result = await reviewEnqueue(deps, { patchId: 're3' }) as { success: false; error: string };
      expect(result.success).toBe(false);
    });
  });

  describe('patch_notify', () => {
    it('notifies for ready patches', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pn1' }));
      await deps.patchQueue.transition('pn1', 'reviewing');
      await deps.patchQueue.transition('pn1', 'ready');

      const result = await patchNotify(deps, { patchId: 'pn1' }) as { success: boolean; notified: boolean };
      expect(result.success).toBe(true);
      expect(result.notified).toBe(true);
    });

    it('returns notified=false for superseded patches', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pn2' }));
      await deps.patchQueue.transition('pn2', 'superseded');

      const result = await patchNotify(deps, { patchId: 'pn2' }) as { success: boolean; notified: boolean };
      expect(result.success).toBe(true);
      expect(result.notified).toBe(false);
    });

    it('returns notified=false for already notified patches', async () => {
      await deps.patchQueue.create(makePatch({ id: 'pn3' }));
      await deps.patchQueue.transition('pn3', 'reviewing');
      await deps.patchQueue.transition('pn3', 'ready');
      await deps.patchQueue.transition('pn3', 'notified');

      const result = await patchNotify(deps, { patchId: 'pn3' }) as { success: boolean; notified: boolean };
      expect(result.success).toBe(true);
      expect(result.notified).toBe(false);
    });

    it('returns notified=false for applied patches', async () => {
      const skillPath = join(skillsDir, 'skill.tools', 'SKILL.md');
      await ensureDir(dirname(skillPath));
      await writeFile(skillPath, 'old');

      await deps.patchQueue.create(makePatch({ id: 'pn4' }));
      await patchApply(deps, { patchId: 'pn4' });

      const result = await patchNotify(deps, { patchId: 'pn4' }) as { success: boolean; notified: boolean };
      expect(result.success).toBe(true);
      expect(result.notified).toBe(false);
    });
  });

  describe('makeTools', () => {
    it('returns 7 tool definitions with correct names', () => {
      const tools = makeTools(deps);
      expect(tools).toHaveLength(7);

      const names = tools.map((t) => t.name);
      expect(names).toContain('skill_evolution_patch_list');
      expect(names).toContain('skill_evolution_patch_get');
      expect(names).toContain('skill_evolution_patch_apply');
      expect(names).toContain('skill_evolution_patch_reject');
      expect(names).toContain('skill_evolution_patch_status');
      expect(names).toContain('skill_evolution_review_enqueue');
      expect(names).toContain('skill_evolution_patch_notify');
    });

    it('all tools have description and inputSchema', () => {
      const tools = makeTools(deps);
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('all tools return structured JSON via handler', async () => {
      await deps.patchQueue.create(makePatch({ id: 'handler_test' }));
      const tools = makeTools(deps);

      const statusTool = tools.find((t) => t.name === 'skill_evolution_patch_status')!;
      const result = await statusTool.handler({ patchId: 'handler_test' }) as Record<string, unknown>;
      expect(result.patchId).toBe('handler_test');
    });
  });
});
