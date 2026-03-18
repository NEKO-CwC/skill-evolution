/**
 * Patch generator implementing reviewed diff materialization contract.
 */

import { randomBytes } from 'node:crypto';
import type {
  PatchCandidate,
  PatchCandidateGenerator,
  PatchGenerator,
  ReviewResult,
  SessionSummary,
} from '../shared/types.js';

/**
 * Default patch generator — produces both legacy string format and v2 PatchCandidate.
 */
export class PatchGeneratorImpl implements PatchGenerator, PatchCandidateGenerator {
  /**
   * Generates patch output as markdown string (legacy v1 interface).
   */
  public generate(result: ReviewResult, originalContent: string): string {
    return [
      `--- PATCH: ${result.metadata.skillKey} ---`,
      `Patch ID: ${result.metadata.patchId}`,
      `Risk: ${result.riskLevel}`,
      `Source Session: ${result.metadata.sourceSessionId}`,
      '',
      '## Proposed Changes',
      result.proposedDiff,
      '',
      '## Original Content',
      originalContent
    ].join('\n');
  }

  /**
   * Generates a structured PatchCandidate object (v2 interface).
   */
  public generateCandidate(
    result: ReviewResult,
    originalContent: string,
    sessionIds: string[]
  ): PatchCandidate {
    const now = new Date().toISOString();
    const id = `patch_${Date.now()}_${randomBytes(4).toString('hex')}`;

    return {
      id,
      skillKey: result.metadata.skillKey,
      status: 'queued',
      risk: result.riskLevel,
      sourceSessionIds: sessionIds.length > 0 ? sessionIds : [result.metadata.sourceSessionId],
      createdAt: now,
      updatedAt: now,
      summary: result.justification.slice(0, 200),
      justification: result.justification,
      proposedDiff: result.proposedDiff,
      originalContent,
      artifactVersion: 1,
    };
  }
  /**
   * Generates a PatchCandidate directly from session data, without LLM review.
   * Constructs proposedDiff from overlay content and justification from event statistics.
   */
  public generateCandidateFromSession(
    summary: SessionSummary,
    originalContent: string
  ): PatchCandidate {
    const now = new Date().toISOString();
    const id = `patch_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const { sessionId, skillKey, events, overlays, totalErrors } = summary;

    const correctionCount = events.filter(e => e.eventType === 'user_correction').length;
    const positiveCount = events.filter(e => e.eventType === 'positive_feedback').length;
    const totalSignals = totalErrors + correctionCount;
    const risk = totalSignals <= 1 ? 'low' : totalSignals <= 3 ? 'medium' : 'high' as const;

    const justification = [
      `Based on ${totalErrors} tool error(s)`,
      correctionCount > 0 ? `, ${correctionCount} user correction(s)` : '',
      positiveCount > 0 ? `, ${positiveCount} positive signal(s)` : '',
      ` in session ${sessionId}.`,
    ].join('');

    // Build proposedDiff from overlay content (session-local corrections)
    const overlayDiff = overlays.length > 0
      ? overlays.map(o => `### ${o.reasoning}\n${o.content}`).join('\n\n')
      : '(No overlay corrections captured — awaiting agent review)';

    const proposedDiff = [
      '# Session-Based Patch Proposal',
      '',
      '> This patch was generated from session overlay data.',
      '> It represents suggested improvement directions, not a final diff.',
      '> Agent review is required to produce the final SKILL.md changes.',
      '',
      '## Overlay Corrections',
      overlayDiff,
    ].join('\n');

    return {
      id,
      skillKey,
      status: 'queued',
      risk,
      sourceSessionIds: [sessionId],
      createdAt: now,
      updatedAt: now,
      summary: justification.slice(0, 200),
      justification,
      proposedDiff,
      originalContent,
      artifactVersion: 1,
    };
  }
}

export default PatchGeneratorImpl;
