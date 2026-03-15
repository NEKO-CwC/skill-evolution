import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolvePaths } from '../../src/shared/paths.ts';

describe('shared/paths', () => {
  it('resolves relative paths against workspace dir', () => {
    const workspaceDir = '/tmp/workspace';
    const paths = resolvePaths(workspaceDir, {
      sessionOverlay: {
        storageDir: '.skill-overlays'
      }
    });

    expect(paths.workspaceDir).toBe(workspaceDir);
    expect(paths.overlaysDir).toBe(resolve(workspaceDir, '.skill-overlays'));
    expect(paths.patchesDir).toBe(resolve(workspaceDir, '.skill-patches'));
    expect(paths.backupsDir).toBe(resolve(workspaceDir, '.skill-backups'));
    expect(paths.skillsDir).toBe(resolve(workspaceDir, 'skills'));
  });

  it('preserves absolute overlay path as-is', () => {
    const workspaceDir = '/tmp/workspace';
    const absoluteOverlayDir = '/var/tmp/custom-overlays';
    const paths = resolvePaths(workspaceDir, {
      sessionOverlay: {
        storageDir: absoluteOverlayDir
      }
    });

    expect(paths.overlaysDir).toBe(absoluteOverlayDir);
  });

  it('uses config storageDir for overlays', () => {
    const workspaceDir = '/tmp/workspace';
    const paths = resolvePaths(workspaceDir, {
      sessionOverlay: {
        storageDir: 'overlay-store'
      }
    });

    expect(paths.overlaysDir).toBe(resolve(workspaceDir, 'overlay-store'));
  });

  it('sets feedbackDir to workspace-relative default', () => {
    const workspaceDir = '/tmp/workspace';
    const paths = resolvePaths(workspaceDir, {
      sessionOverlay: {
        storageDir: '.skill-overlays'
      }
    });

    expect(paths.feedbackDir).toBe(resolve(workspaceDir, '.skill-feedback'));
  });
});
