/**
 * Agent tool implementations for patch operations.
 * All tools return structured JSON, are idempotent, and validate against the patch state machine.
 */

import { PatchNotFoundError, PatchStateError } from '../../shared/errors.js';
import ConsoleLogger from '../../shared/logger.js';
import type { PatchQueueManager } from '../../review/patch_queue.js';
import type { MergeManager, PatchStatus } from '../../shared/types.js';

const logger = new ConsoleLogger('patch_tools');

export interface PatchToolDeps {
  patchQueue: PatchQueueManager;
  mergeManager: MergeManager;
}

function errorResult(error: unknown): { success: false; error: string } {
  const msg = error instanceof Error ? error.message : String(error);
  return { success: false, error: msg };
}

export async function patchList(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const filter: { skillKey?: string; status?: PatchStatus; limit?: number } = {};
    if (typeof params.skillKey === 'string') filter.skillKey = params.skillKey;
    if (typeof params.status === 'string') filter.status = params.status as PatchStatus;
    if (typeof params.limit === 'number') filter.limit = params.limit;
    return await deps.patchQueue.list(filter);
  } catch (error) {
    return errorResult(error);
  }
}

export async function patchGet(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const patchId = params.patchId as string;
    if (!patchId) return { success: false, error: 'patchId is required' };
    return await deps.patchQueue.get(patchId);
  } catch (error) {
    return errorResult(error);
  }
}

export async function patchApply(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const patchId = params.patchId as string;
    if (!patchId) return { success: false, error: 'patchId is required' };

    const candidate = await deps.patchQueue.get(patchId);

    if (candidate.status === 'applied') {
      return { success: true, patchId, status: 'applied' };
    }

    const applied = await deps.mergeManager.applyPatch(candidate);
    await deps.patchQueue.update(patchId, { status: 'applied' });

    logger.info('Patch applied via tool', { patchId, skillKey: applied.skillKey });
    return { success: true, patchId, status: 'applied' };
  } catch (error) {
    return errorResult(error);
  }
}

export async function patchReject(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const patchId = params.patchId as string;
    if (!patchId) return { success: false, error: 'patchId is required' };

    const candidate = await deps.patchQueue.get(patchId);

    if (candidate.status === 'rejected') {
      return { success: true, patchId, status: 'rejected' };
    }

    const reason = typeof params.reason === 'string' ? params.reason : undefined;
    const rejected = await deps.mergeManager.rejectPatch(candidate, reason);
    await deps.patchQueue.update(patchId, {
      status: 'rejected',
      justification: rejected.justification,
    });

    logger.info('Patch rejected via tool', { patchId, reason });
    return { success: true, patchId, status: 'rejected' };
  } catch (error) {
    return errorResult(error);
  }
}

export async function patchStatus(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const patchId = params.patchId as string;
    if (!patchId) return { success: false, error: 'patchId is required' };

    const candidate = await deps.patchQueue.get(patchId);
    return {
      patchId: candidate.id,
      status: candidate.status,
      risk: candidate.risk,
      summary: candidate.summary,
    };
  } catch (error) {
    return errorResult(error);
  }
}

export async function reviewEnqueue(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const patchId = params.patchId as string;
    if (!patchId) return { success: false, error: 'patchId is required' };

    const candidate = await deps.patchQueue.get(patchId);

    if (candidate.status === 'reviewing') {
      return { success: true, patchId, status: 'reviewing' };
    }

    await deps.patchQueue.transition(patchId, 'reviewing');
    logger.info('Patch enqueued for review via tool', { patchId });
    return { success: true, patchId, status: 'reviewing' };
  } catch (error) {
    return errorResult(error);
  }
}

export async function patchNotify(
  deps: PatchToolDeps,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const patchId = params.patchId as string;
    if (!patchId) return { success: false, error: 'patchId is required' };

    const candidate = await deps.patchQueue.get(patchId);

    const nonNotifiableStatuses: PatchStatus[] = ['superseded', 'applied', 'rejected', 'failed'];
    if (nonNotifiableStatuses.includes(candidate.status)) {
      return { success: true, patchId, notified: false };
    }

    if (candidate.status === 'notified') {
      return { success: true, patchId, notified: false };
    }

    if (candidate.status === 'ready') {
      await deps.patchQueue.transition(patchId, 'notified');
    }

    logger.info('Patch notification sent via tool', { patchId });
    return { success: true, patchId, notified: true };
  } catch (error) {
    return errorResult(error);
  }
}
