/**
 * Review orchestrator: coordinates enqueue -> review -> notify flow.
 * Handles agent spawning with fallback to LLMReviewRunner.
 */

import ConsoleLogger from '../shared/logger.js';
import type {
  PatchCandidate,
  RefreshableReviewRunner,
  ReviewRunner,
  SessionSummary,
  SkillEvolutionConfig,
} from '../shared/types.js';
import type { PatchQueueManager } from './patch_queue.js';

const LLM_FALLBACK_TIMEOUT_MS = 60_000;

export class ReviewOrchestrator {
  private readonly config: SkillEvolutionConfig;
  private readonly patchQueue: PatchQueueManager;
  private readonly reviewRunner: ReviewRunner;
  private readonly logger = new ConsoleLogger('review_orchestrator');

  public constructor(
    config: SkillEvolutionConfig,
    patchQueue: PatchQueueManager,
    reviewRunner: ReviewRunner
  ) {
    this.config = config;
    this.patchQueue = patchQueue;
    this.reviewRunner = reviewRunner;
  }

  /**
   * Enqueue a patch for review. Attempts agent spawn, falls back to LLMReviewRunner.
   * Non-blocking: returns immediately after fire-and-forget.
   */
  public async enqueue(patchId: string): Promise<void> {
    const reviewMode = this.config.reviewMode ?? 'queue-only';

    if (reviewMode === 'off' || reviewMode === 'queue-only') {
      this.logger.debug('Review not triggered (reviewMode)', { patchId, reviewMode });
      return;
    }

    const agentConfig = this.config.agents?.review;

    if (agentConfig?.enabled) {
      const spawned = await this.trySpawnReviewAgent(patchId);
      if (spawned) return;

      this.logger.warn('Agent spawn failed, falling back to LLMReviewRunner', {
        module: 'review_orchestrator',
        event: 'agent_spawn_failed',
        patchId,
        reason: 'runtime_unavailable',
        fallback: 'llm_review_runner',
      });
    }

    await this.runLlmFallbackReview(patchId);
  }

  /**
   * Schedule notification for a patch. Non-blocking.
   */
  public async scheduleNotify(patchId: string): Promise<void> {
    const notifyConfig = this.config.notify;
    if (!notifyConfig?.enabled || notifyConfig.mode === 'off') {
      return;
    }

    this.logger.info('Notification scheduled', { patchId, mode: notifyConfig.mode });
  }

  /**
   * Process a review for a patch — called by review agent or as fallback.
   */
  public async processReview(patchId: string, summary: SessionSummary): Promise<void> {
    try {
      await this.patchQueue.transition(patchId, 'reviewing');

      const reviewResult = await this.reviewRunner.runReview(summary);

      if (!reviewResult.isModificationRecommended) {
        this.logger.info('Review complete: no modification recommended', { patchId });
        return;
      }

      await this.patchQueue.update(patchId, {
        reviewOutput: {
          reviewedAt: new Date().toISOString(),
          riskAssessment: reviewResult.riskLevel,
          suggestedAction: 'apply',
          rationale: reviewResult.justification,
          revisedDiff: reviewResult.proposedDiff,
        },
        risk: reviewResult.riskLevel,
      });

      await this.patchQueue.transition(patchId, 'ready');

      // Auto-apply low-risk patches if configured
      const reviewMode = this.config.reviewMode ?? 'queue-only';
      if (reviewMode === 'auto-low-risk') {
        const maxRisk = this.config.risk?.autoApplyMaxRisk ?? 'low';
        const riskOrder = ['low', 'medium', 'high'];
        if (riskOrder.indexOf(reviewResult.riskLevel) <= riskOrder.indexOf(maxRisk)) {
          await this.patchQueue.transition(patchId, 'approved');
          this.logger.info('Patch auto-approved (low risk)', { patchId, risk: reviewResult.riskLevel });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Review processing failed', { patchId, error: message });
      try {
        await this.patchQueue.transition(patchId, 'failed');
      } catch {
        // already in terminal state
      }
    }
  }

  private async trySpawnReviewAgent(patchId: string): Promise<boolean> {
    // Agent spawning requires OpenClaw session API (api.spawnAgent / api.runAgent).
    // When the runtime supports it, this method will:
    // 1. Check if a review agent session already exists (reuse if spawnMode='session')
    // 2. Spawn the skill-evolution-review agent with the patchId as task
    // 3. The agent will call skill_evolution_patch_get -> analyze -> patch_apply/reject
    // 4. Return true on successful spawn, false on failure
    //
    // Model configuration: Review agent inherits OpenClaw native provider/model
    // by default. Only overrides if agents.review.model is explicitly set.
    //
    // Timeout: agents.review.runTimeoutSeconds (default 180s)
    //
    // For now, returns false to trigger LLM fallback.
    this.logger.debug('Agent spawn not yet available', { patchId });
    return false;
  }

  private async runLlmFallbackReview(patchId: string): Promise<void> {
    try {
      const candidate = await this.patchQueue.get(patchId);

      // Build a minimal SessionSummary from the patch candidate
      const summary: SessionSummary = {
        sessionId: candidate.sourceSessionIds[0] ?? 'unknown',
        skillKey: candidate.skillKey,
        events: [],
        overlays: [],
        durationMs: 0,
        totalErrors: 0,
      };

      await this.processReview(patchId, summary);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('LLM fallback review failed', {
        module: 'review_orchestrator',
        event: 'llm_fallback_failed',
        patchId,
        fallback: 'queue_only',
        error: message,
      });
      // Patch stays queued — eventual consistency
    }
  }
}

export default ReviewOrchestrator;
