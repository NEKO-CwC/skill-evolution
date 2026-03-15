import { isAbsolute, resolve } from 'node:path';
import type { ResolvedPaths } from './types.js';
import ConsoleLogger from './logger.js';

export type { ResolvedPaths };

export function resolvePaths(
  workspaceDir: string,
  config: { sessionOverlay: { storageDir: string }; skillsDir?: string }
): ResolvedPaths {
  const rel = (pathValue: string): string => (isAbsolute(pathValue) ? pathValue : resolve(workspaceDir, pathValue));
  const result: ResolvedPaths = {
    workspaceDir,
    overlaysDir: rel(config.sessionOverlay.storageDir),
    patchesDir: rel('.skill-patches'),
    backupsDir: rel('.skill-backups'),
    skillsDir: rel(config.skillsDir ?? 'skills'),
    feedbackDir: rel('.skill-feedback')
  };
  
  // Debug logging - can be removed later
  const logger = new ConsoleLogger('paths');
  logger.debug('resolvePaths called', { 
    inputWorkspaceDir: workspaceDir,
    result: result
  });
  
  return result;
}
