import { join } from 'node:path';
import { fileExists, readFile } from '../../shared/fs.js';
import type { SessionSummary } from '../../shared/types.js';
import type { SkillEvolutionPlugin } from '../index.js';

async function readCurrentSkillContent(skillsDir: string, skillKey: string): Promise<string> {
  const skillFilePath = join(skillsDir, skillKey, 'SKILL.md');
  if (await fileExists(skillFilePath)) {
    return readFile(skillFilePath);
  }
  return '';
}

export async function session_end(plugin: SkillEvolutionPlugin, sessionId: string): Promise<void> {
  // GUARD: must be before any path-derived operations
  if (!plugin.isWorkspaceBound()) {
    plugin.logger.warn('session_end: workspace not bound, skipping all operations', {
      sessionId,
      hook: 'session_end',
      workspaceBound: false,
      workspaceDir: plugin.paths.workspaceDir,
      cwd: process.cwd(),
      reason: 'workspace-unbound-skip-review'
    });
    return;
  }

  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);
  const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  const overlays = await plugin.overlayStore.listBySession(sessionId);

  const summary: SessionSummary = {
    sessionId,
    skillKey,
    events,
    overlays,
    durationMs: Date.now() - plugin.getSessionStartTime(sessionId),
    totalErrors: events.filter((event) => event.eventType === 'tool_error').length
  };

  plugin.logger.info('Session summary collected', {
    sessionId: summary.sessionId,
    skillKey: summary.skillKey,
    eventCount: summary.events.length,
    overlayCount: summary.overlays.length,
    durationMs: summary.durationMs,
    totalErrors: summary.totalErrors,
    pluginPaths: plugin.paths,
    reviewRunnerPaths: plugin.reviewRunner.paths
  });

  const reviewMode = plugin.config.reviewMode ?? 'queue-only';

  if (reviewMode === 'off') {
    plugin.logger.info('Review mode is off, skipping review pipeline', { sessionId });
  } else if (plugin.config.triggers.onSessionEndReview) {
    await runReviewPipeline(plugin, summary, reviewMode);
  }

  if (plugin.config.sessionOverlay.clearOnSessionEnd) {
    await plugin.overlayStore.clearSession(sessionId);
  }

  plugin.endSession(sessionId);
}

async function runReviewPipeline(
  plugin: SkillEvolutionPlugin,
  summary: SessionSummary,
  reviewMode: string
): Promise<void> {
  const { sessionId, skillKey } = summary;
  const minEvidence = plugin.config.review.minEvidenceCount;
  const totalEvidence = summary.events.length;

  plugin.logger.debug('Starting review pipeline', {
    sessionId,
    skillKey,
    totalEvidence,
    minEvidenceRequired: minEvidence,
    reviewMode,
    pluginPaths: plugin.paths,
    reviewRunnerPaths: plugin.reviewRunner.paths
  });

  if (totalEvidence < minEvidence) {
    plugin.logger.info('Skipping review: insufficient evidence', {
      sessionId,
      skillKey,
      totalEvidence,
      minEvidenceRequired: minEvidence
    });
    return;
  }

  try {
    // v2 path: use PatchQueueManager + ReviewOrchestrator for assisted/auto-low-risk modes
    if (
      plugin.patchQueue &&
      plugin.reviewOrchestrator &&
      (reviewMode === 'assisted' || reviewMode === 'auto-low-risk')
    ) {
      await runV2ReviewPipeline(plugin, summary, reviewMode);
      return;
    }

    // v1/queue-only path: inline review pipeline (preserves existing behavior)
    await runLegacyReviewPipeline(plugin, summary);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    plugin.logger.error('Review pipeline failed', {
      sessionId,
      skillKey,
      error: message
    });
  }
}

async function runV2ReviewPipeline(
  plugin: SkillEvolutionPlugin,
  summary: SessionSummary,
  reviewMode: string
): Promise<void> {
  const { sessionId, skillKey } = summary;

  // Generate review result for patch candidate creation
  const reviewResult = await plugin.reviewRunner.runReview(summary);

  if (!reviewResult.isModificationRecommended) {
    plugin.logger.info('Review complete: no modification recommended', {
      sessionId,
      skillKey,
      justification: reviewResult.justification
    });
    return;
  }

  const currentContent = await readCurrentSkillContent(plugin.paths.skillsDir, skillKey);

  // Create PatchCandidate via v2 generator
  const candidate = plugin.patchGenerator.generateCandidate(
    reviewResult,
    currentContent,
    [sessionId]
  );

  // Check for existing pending patches and supersede
  const pendingPatches = await plugin.patchQueue!.findPendingForSkill(skillKey);
  const createdPatch = await plugin.patchQueue!.create(candidate);

  for (const pending of pendingPatches) {
    await plugin.patchQueue!.supersede(pending.id, createdPatch.id);
  }

  plugin.logger.info('Patch candidate created', {
    sessionId,
    skillKey,
    patchId: createdPatch.id,
    riskLevel: createdPatch.risk,
    reviewMode,
    supersededCount: pendingPatches.length,
  });

  // Delegate to review orchestrator based on reviewMode
  if (reviewMode === 'assisted' || reviewMode === 'auto-low-risk') {
    // Fire-and-forget: don't block session_end
    plugin.reviewOrchestrator!.enqueue(createdPatch.id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      plugin.logger.error('Review orchestrator enqueue failed', {
        patchId: createdPatch.id,
        error: msg,
      });
    });
  }

  // Schedule notification if enabled
  const notifyConfig = plugin.config.notify;
  if (notifyConfig?.enabled && notifyConfig.mode !== 'off') {
    plugin.reviewOrchestrator!.scheduleNotify(createdPatch.id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      plugin.logger.error('Notify schedule failed', { patchId: createdPatch.id, error: msg });
    });
  }
}

async function runLegacyReviewPipeline(
  plugin: SkillEvolutionPlugin,
  summary: SessionSummary
): Promise<void> {
  const { sessionId, skillKey } = summary;

  const reviewResult = await plugin.reviewRunner.runReview(summary);

  if (!reviewResult.isModificationRecommended) {
    plugin.logger.info('Review complete: no modification recommended', {
      sessionId,
      skillKey,
      justification: reviewResult.justification
    });
    return;
  }

  const currentContent = await readCurrentSkillContent(plugin.paths.skillsDir, skillKey);
  const patchContent = plugin.patchGenerator.generate(reviewResult, currentContent);

  plugin.logger.info('Patch generated, attempting merge', {
    sessionId,
    skillKey,
    patchId: reviewResult.metadata.patchId,
    riskLevel: reviewResult.riskLevel,
    mergeMode: reviewResult.metadata.mergeMode,
    patchPreview: patchContent.substring(0, 200)
  });

  const merged = await plugin.mergeManager.merge(skillKey, patchContent, reviewResult.metadata);

  plugin.logger.info(merged ? 'Patch auto-merged successfully' : 'Patch queued for human review', {
    sessionId,
    skillKey,
    patchId: reviewResult.metadata.patchId
  });
}

export default session_end;
