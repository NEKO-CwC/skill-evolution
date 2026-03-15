/**
 * Session-end review runner implementing recommendation orchestration contract.
 */

import { ReviewFailedError } from '../shared/errors.js';
import ConsoleLogger from '../shared/logger.js';
import type { ReviewResult, ReviewRunner, SessionSummary } from '../shared/types.js';
import type { SkillEvolutionConfig } from '../shared/types.js';

const DEFAULT_CONFIG: SkillEvolutionConfig = {
  enabled: true,
  merge: {
    requireHumanMerge: true,
    maxRollbackVersions: 5
  },
  sessionOverlay: {
    enabled: true,
    storageDir: '.skill-overlays',
    injectMode: 'system-context',
    clearOnSessionEnd: true
  },
  triggers: {
    onToolError: true,
    onUserCorrection: true,
    onSessionEndReview: true,
    onPositiveFeedback: true
  },
  llm: {
    inheritPrimaryConfig: true,
    modelOverride: null,
    thinkingOverride: null,
    provider: null
  },
  review: {
    minEvidenceCount: 2,
    allowAutoMergeOnLowRiskOnly: false
  }
};

export class ReviewRunnerImpl implements ReviewRunner {
  private readonly config: SkillEvolutionConfig;

  private readonly logger = new ConsoleLogger('review_runner');

  public constructor(config: SkillEvolutionConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  /**
   * Executes review process over a session summary.
   */
  public async runReview(summary: SessionSummary): Promise<ReviewResult> {
    try {
      const overlayCount = summary.overlays.length;
      const correctionCount = summary.events.filter((e) => e.eventType === 'user_correction').length;
      const positiveCount = summary.events.filter((e) => e.eventType === 'positive_feedback').length;
      const shouldRecommend = summary.totalErrors > 0 || correctionCount > 0 || overlayCount > 0;

      const riskLevel = this.getRiskLevel(summary.totalErrors, correctionCount);
      const proposedDiff = summary.overlays.map((entry) => entry.content).join('\n\n');
      const mergeMode = this.config.merge.requireHumanMerge ? 'manual' : 'auto';
      const patchId = `patch_${Date.now()}`;

      const result: ReviewResult = {
        isModificationRecommended: shouldRecommend,
        justification: `Session had ${summary.totalErrors} errors, ${correctionCount} corrections, ${positiveCount} positive signals, and ${overlayCount} overlays.`,
        proposedDiff,
        riskLevel,
        metadata: {
          skillKey: summary.skillKey,
          patchId,
          baseVersion: 'latest',
          sourceSessionId: summary.sessionId,
          mergeMode,
          riskLevel,
          rollbackChainDepth: 0
        }
      };

      this.logger.info('Review completed', {
        sessionId: summary.sessionId,
        skillKey: summary.skillKey,
        recommended: result.isModificationRecommended,
        riskLevel: result.riskLevel,
        patchId
      });

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewFailedError(`Failed to run deterministic review: ${message}`);
    }
  }

  private getRiskLevel(totalErrors: number, correctionCount: number): 'low' | 'medium' | 'high' {
    const combined = totalErrors + correctionCount;
    if (combined <= 1) {
      return 'low';
    }
    if (combined <= 3) {
      return 'medium';
    }
    return 'high';
  }
}

export default ReviewRunnerImpl;
