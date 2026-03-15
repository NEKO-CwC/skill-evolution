import { describe, expect, it } from 'vitest';
import { PatchGeneratorImpl } from '../../src/review/patch_generator.ts';
import type { ReviewResult } from '../../src/shared/types.ts';

describe('review/patch_generator', () => {
  it('includes expected patch sections and metadata lines', () => {
    const generator = new PatchGeneratorImpl();
    const result: ReviewResult = {
      isModificationRecommended: true,
      justification: 'errors found',
      proposedDiff: 'replace old guidance with new guidance',
      riskLevel: 'medium',
      metadata: {
        skillKey: 'skill.alpha',
        patchId: 'patch_123',
        baseVersion: 'latest',
        sourceSessionId: 'session_99',
        mergeMode: 'manual',
        riskLevel: 'medium',
        rollbackChainDepth: 0
      }
    };

    const patch = generator.generate(result, '# old skill content');

    expect(patch).toContain('--- PATCH: skill.alpha ---');
    expect(patch).toContain('Patch ID: patch_123');
    expect(patch).toContain('Risk: medium');
    expect(patch).toContain('Source Session: session_99');
    expect(patch).toContain('## Proposed Changes');
    expect(patch).toContain('replace old guidance with new guidance');
    expect(patch).toContain('## Original Content');
    expect(patch).toContain('# old skill content');
  });
});
