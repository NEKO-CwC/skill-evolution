import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile as nodeWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OverlayStoreImpl } from '../../../src/plugin/overlay/overlay_store.ts';
import { OverlayNotFoundError } from '../../../src/shared/errors.ts';
import { ensureDir } from '../../../src/shared/fs.ts';
import type { OverlayEntry } from '../../../src/shared/types.ts';

describe('plugin/overlay/overlay_store', () => {
  let tempDir: string;
  let store: OverlayStoreImpl;

  const entry = (sessionId: string, skillKey: string, content = 'overlay content'): OverlayEntry => ({
    sessionId,
    skillKey,
    content,
    createdAt: 1,
    updatedAt: 1,
    reasoning: 'because it helps'
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-overlay-store-test-'));
    store = new OverlayStoreImpl(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates and reads overlay entry from disk', async () => {
    const overlay = entry('session-a', 'skill/a');
    await store.create(overlay);

    await expect(store.read('session-a', 'skill/a')).resolves.toEqual(overlay);
  });

  it('returns null when reading non-existent overlay', async () => {
    await expect(store.read('missing-session', 'missing-skill')).resolves.toBeNull();
  });

  it('updates existing overlay while preserving sessionId and skillKey', async () => {
    await store.create(entry('session-a', 'skill/a', 'v1'));
    await store.update('session-a', 'skill/a', {
      content: 'v2',
      reasoning: 'updated',
      sessionId: 'other-session',
      skillKey: 'other-skill'
    });

    await expect(store.read('session-a', 'skill/a')).resolves.toEqual({
      sessionId: 'session-a',
      skillKey: 'skill/a',
      content: 'v2',
      createdAt: 1,
      updatedAt: 1,
      reasoning: 'updated'
    });
  });

  it('throws OverlayNotFoundError when updating missing overlay', async () => {
    await expect(store.update('session-a', 'skill/a', { content: 'x' })).rejects.toBeInstanceOf(OverlayNotFoundError);
  });

  it('deletes existing overlay and subsequent read returns null', async () => {
    await store.create(entry('session-a', 'skill/a'));
    await store.delete('session-a', 'skill/a');
    await expect(store.read('session-a', 'skill/a')).resolves.toBeNull();
  });

  it('lists only overlays for the requested session', async () => {
    const a1 = entry('session-a', 'skill/one', 'one');
    const a2 = entry('session-a', 'skill/two', 'two');
    const b1 = entry('session-b', 'skill/one', 'three');
    await store.create(a1);
    await store.create(a2);
    await store.create(b1);

    const listed = await store.listBySession('session-a');
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([a1, a2]));
    expect(listed).not.toEqual(expect.arrayContaining([b1]));
  });

  it('keeps overlays isolated across sessions for same skill key', async () => {
    await store.create(entry('session-a', 'same/skill', 'from-a'));
    await store.create(entry('session-b', 'same/skill', 'from-b'));

    await expect(store.read('session-a', 'same/skill')).resolves.toMatchObject({ content: 'from-a' });
    await expect(store.read('session-b', 'same/skill')).resolves.toMatchObject({ content: 'from-b' });
  });

  it('clearSession removes all overlays for one session only', async () => {
    await store.create(entry('session-a', 'skill/one'));
    await store.create(entry('session-b', 'skill/two'));

    await store.clearSession('session-a');

    await expect(store.listBySession('session-a')).resolves.toEqual([]);
    await expect(store.listBySession('session-b')).resolves.toHaveLength(1);
  });

  it('uses URL-encoded skill keys in storage file paths', async () => {
    const rawSkillKey = 'skill/with spaces?x=1&y=2';
    const rawSessionId = 'session/with spaces';
    await store.create(entry(rawSessionId, rawSkillKey));

    const encodedSession = encodeURIComponent(rawSessionId);
    const encodedSkill = `${encodeURIComponent(rawSkillKey)}.json`;
    const sessionDir = join(tempDir, encodedSession);
    const files = await readdir(sessionDir);
    expect(files).toContain(encodedSkill);
  });

  it('throws when stored overlay json is invalid during listBySession', async () => {
    const sessionDir = join(tempDir, encodeURIComponent('session-a'));
    await ensureDir(sessionDir);
    await nodeWriteFile(join(sessionDir, `${encodeURIComponent('skill/a')}.json`), '{invalid json', 'utf8');
    await expect(store.listBySession('session-a')).rejects.toThrow();
  });
});
