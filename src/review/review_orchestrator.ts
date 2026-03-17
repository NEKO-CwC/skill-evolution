/**
 * Review orchestrator: coordinates enqueue -> review -> notify flow.
 * Delegates to the top-level skill-evolution agent's internal sessions,
 * with fallback to LLMReviewRunner when the agent is unavailable.
 */

import { execFile } from 'node:child_process';
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
   * Enqueue a patch for review. Attempts agent delegation, falls back to LLMReviewRunner.
   * Non-blocking: returns immediately after fire-and-forget.
   */
  public async enqueue(patchId: string): Promise<void> {
    const reviewMode = this.config.reviewMode ?? 'queue-only';

    if (reviewMode === 'off' || reviewMode === 'queue-only') {
      this.logger.debug('Review not triggered (reviewMode)', { patchId, reviewMode });
      return;
    }

    const agentConfig = this.config.agent;
    const sessionConfig = this.config.sessions?.review;

    if (agentConfig?.enabled && sessionConfig?.enabled) {
      const delegated = await this.tryDelegateToAgentSession(patchId);
      if (delegated) return;

      this.logger.warn('Agent session delegation failed, falling back to LLMReviewRunner', {
        module: 'review_orchestrator',
        event: 'agent_delegation_failed',
        patchId,
        agentId: agentConfig.id,
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

  /**
   * Delegate review to the top-level skill-evolution agent via gateway CLI.
   * Sends a message to the agent's review session. Fire-and-forget, non-blocking.
   * Returns true if delegation was initiated, false if unavailable.
   */
  private async tryDelegateToAgentSession(patchId: string): Promise<boolean> {
    const agentId = this.config.agent?.id ?? 'skill-evolution';
    const sessionConfig = this.config.sessions?.review;
    const timeoutSeconds = sessionConfig?.timeoutSeconds ?? 180;

    // Build a session ID for reuse if configured
    const sessionId = sessionConfig?.reuse
      ? `se-review-${agentId}`
      : `se-review-${patchId}`;

    const message = [
      `Review patch ${patchId}.`,
      'Use skill_evolution_patch_get to read details,',
      'then skill_evolution_patch_apply or skill_evolution_patch_reject.',
    ].join(' ');

    return new Promise<boolean>((resolve) => {
      const child = execFile(
        'openclaw',
        ['agent', '--agent', agentId, '--session-id', sessionId, '--message', message],
        { timeout: timeoutSeconds * 1000 },
        (error) => {
          if (error) {
            this.logger.debug('Agent session delegation completed with error', {
              patchId,
              agentId,
              error: error.message,
            });
          } else {
            this.logger.info('Agent session delegation completed', {
              patchId,
              agentId,
              sessionId,
            });
          }
        }
      );

      // Fire-and-forget: resolve immediately, don't wait for agent to finish
      if (child.pid) {
        this.logger.info('Delegated review to agent session', {
          patchId,
          agentId,
          sessionId,
          pid: child.pid,
        });
        child.unref();
        resolve(true);
      } else {
        this.logger.debug('Failed to spawn agent process', { patchId, agentId });
        resolve(false);
      }
    });
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
