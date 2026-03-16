import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyManager } from '../../../src/plugin/notify/notify_manager.ts';
import { PatchQueueManager } from '../../../src/review/patch_queue.ts';
import { getDefaultConfig } from '../../../src/plugin/config.ts';
import type { PatchCandidate, SkillEvolutionConfig } from '../../../src/shared/types.ts';

function makePatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id: `patch_notify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    skillKey: 'skill.notify',
    status: 'queued',
    risk: 'medium',
    sourceSessionIds: ['s1'],
    createdAt: now,
    updatedAt: now,
    summary: 'Notify test patch',
    justification: 'Test',
    proposedDiff: 'diff',
    originalContent: 'original',
    artifactVersion: 1,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<SkillEvolutionConfig>): SkillEvolutionConfig {
  return {
    ...getDefaultConfig(),
    notify: { enabled: true, mode: 'per-session', channel: 'same-thread' },
    notifications: { debounceSeconds: 5, digestCron: '', minRiskToInterrupt: 'medium' },
    ...overrides,
  };
}

describe('plugin/notify/notify_manager', () => {
  let tempDir: string;
  let patchQueue: PatchQueueManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'notify-test-'));
    patchQueue = new PatchQueueManager(join(tempDir, '.skill-patches'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('schedule', () => {
    it('sends notification for medium+ risk patches', async () => {
      const config = makeConfig();
      const mgr = new NotifyManager(config, patchQueue);

      const patch = makePatch({ id: 'n1', risk: 'medium' });
      await patchQueue.create(patch);

      const sent = await mgr.schedule('n1');
      expect(sent).toBe(true);
    });

    it('skips notification when risk is below minRiskToInterrupt', async () => {
      const config = makeConfig();
      config.notifications!.minRiskToInterrupt = 'medium';
      const mgr = new NotifyManager(config, patchQueue);

      const patch = makePatch({ id: 'n2', risk: 'low' });
      await patchQueue.create(patch);

      const sent = await mgr.schedule('n2');
      expect(sent).toBe(false);
    });

    it('skips notification for superseded patches', async () => {
      const config = makeConfig();
      const mgr = new NotifyManager(config, patchQueue);

      const patch = makePatch({ id: 'n3' });
      await patchQueue.create(patch);
      await patchQueue.transition('n3', 'superseded');

      const sent = await mgr.schedule('n3');
      expect(sent).toBe(false);
    });

    it('is idempotent: second call for same patchId returns false', async () => {
      const config = makeConfig();
      const mgr = new NotifyManager(config, patchQueue);

      const patch = makePatch({ id: 'n4', risk: 'high' });
      await patchQueue.create(patch);

      expect(await mgr.schedule('n4')).toBe(true);
      expect(await mgr.schedule('n4')).toBe(false);
    });

    it('debounces notifications within window', async () => {
      const config = makeConfig();
      config.notifications!.debounceSeconds = 60;
      const mgr = new NotifyManager(config, patchQueue);

      const p1 = makePatch({ id: 'n5a', skillKey: 'api', risk: 'medium' });
      await patchQueue.create(p1);
      expect(await mgr.schedule('n5a')).toBe(true);

      const p2 = makePatch({ id: 'n5b', skillKey: 'api', risk: 'high' });
      await patchQueue.create(p2);
      expect(await mgr.schedule('n5b')).toBe(false);
    });

    it('returns false when notify is disabled', async () => {
      const config = makeConfig({ notify: { enabled: false, mode: 'off', channel: 'same-thread' } });
      const mgr = new NotifyManager(config, patchQueue);

      const patch = makePatch({ id: 'n6', risk: 'high' });
      await patchQueue.create(patch);

      expect(await mgr.schedule('n6')).toBe(false);
    });

    it('returns false for applied patches', async () => {
      const config = makeConfig();
      const mgr = new NotifyManager(config, patchQueue);

      const patch = makePatch({ id: 'n7' });
      await patchQueue.create(patch);
      await patchQueue.transition('n7', 'reviewing');
      await patchQueue.transition('n7', 'ready');
      await patchQueue.transition('n7', 'approved');
      await patchQueue.transition('n7', 'applied');

      expect(await mgr.schedule('n7')).toBe(false);
    });
  });

  describe('digest', () => {
    it('aggregates pending patches into single digest', async () => {
      const config = makeConfig({
        notify: { enabled: true, mode: 'digest', channel: 'same-thread' },
        notifications: { debounceSeconds: 0, digestCron: '0 9 * * *', minRiskToInterrupt: 'low' },
      });
      const mgr = new NotifyManager(config, patchQueue);

      const p1 = makePatch({ id: 'dig1', skillKey: 'deploy', risk: 'low' });
      const p2 = makePatch({ id: 'dig2', skillKey: 'auth', risk: 'medium' });
      await patchQueue.create(p1);
      await patchQueue.create(p2);

      // In digest mode, schedule queues for later
      await mgr.schedule('dig1');
      await mgr.schedule('dig2');

      const count = await mgr.sendDigest();
      expect(count).toBe(2);
    });

    it('excludes superseded patches from digest', async () => {
      const config = makeConfig({
        notify: { enabled: true, mode: 'digest', channel: 'same-thread' },
        notifications: { debounceSeconds: 0, digestCron: '0 9 * * *', minRiskToInterrupt: 'low' },
      });
      const mgr = new NotifyManager(config, patchQueue);

      const p1 = makePatch({ id: 'dig3', skillKey: 'api' });
      const p2 = makePatch({ id: 'dig4', skillKey: 'api' });
      await patchQueue.create(p1);
      await patchQueue.create(p2);

      await mgr.schedule('dig3');
      await mgr.schedule('dig4');

      // Supersede p1
      await patchQueue.supersede('dig3', 'dig4');

      const count = await mgr.sendDigest();
      expect(count).toBe(1);
    });

    it('returns 0 for empty digest', async () => {
      const config = makeConfig();
      const mgr = new NotifyManager(config, patchQueue);

      const count = await mgr.sendDigest();
      expect(count).toBe(0);
    });
  });

  describe('enforceFloodLimit', () => {
    it('supersedes older patches when >3 for same skill within window', async () => {
      const config = makeConfig({
        queue: { storageDir: '.skill-patches', metadataFile: '.skill-patches/index.json', dedupeWindowMinutes: 60, maxPendingPerSkill: 20 },
      });
      const mgr = new NotifyManager(config, patchQueue);

      for (let i = 1; i <= 5; i++) {
        await patchQueue.create(makePatch({ id: `flood_${i}`, skillKey: 'api' }));
      }

      const superseded = await mgr.enforceFloodLimit('api');
      expect(superseded).toBe(4);

      const pending = await patchQueue.findPendingForSkill('api');
      expect(pending).toHaveLength(1);
    });

    it('does nothing when <=3 patches', async () => {
      const config = makeConfig();
      const mgr = new NotifyManager(config, patchQueue);

      for (let i = 1; i <= 3; i++) {
        await patchQueue.create(makePatch({ id: `noflood_${i}`, skillKey: 'api' }));
      }

      const superseded = await mgr.enforceFloodLimit('api');
      expect(superseded).toBe(0);
    });
  });
});
