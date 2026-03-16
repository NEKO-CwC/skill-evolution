/**
 * Patch generator implementing reviewed diff materialization contract.
 */

import { randomBytes } from 'node:crypto';
import type {
  PatchCandidate,
  PatchCandidateGenerator,
  PatchGenerator,
  ReviewResult,
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
}

export default PatchGeneratorImpl;
