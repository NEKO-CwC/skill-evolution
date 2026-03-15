/**
 * Patch generator implementing reviewed diff materialization contract.
 */

import type { PatchGenerator, ReviewResult } from '../shared/types.js';

/**
 * Default patch generator placeholder implementation.
 */
export class PatchGeneratorImpl implements PatchGenerator {
  /**
   * Generates patch output based on review result.
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
}

export default PatchGeneratorImpl;
