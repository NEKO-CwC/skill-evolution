import { describe, expect, it } from 'vitest';
import { PatchGeneratorImpl } from '../../src/review/patch_generator.ts';
import type { ReviewResult } from '../../src/shared/types.ts';

const makeReviewResult = (overrides?: Partial<ReviewResult>): ReviewResult => ({
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
  },
  ...overrides,
});

describe('review/patch_generator', () => {
  it('includes expected patch sections and metadata lines', () => {
    const generator = new PatchGeneratorImpl();
    const result = makeReviewResult();

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

  describe('generateCandidate (v2)', () => {
    it('returns a PatchCandidate with queued status', () => {
      const generator = new PatchGeneratorImpl();
      const result = makeReviewResult();

      const candidate = generator.generateCandidate(result, '# original', ['session_99']);

      expect(candidate.status).toBe('queued');
      expect(candidate.skillKey).toBe('skill.alpha');
      expect(candidate.risk).toBe('medium');
      expect(candidate.proposedDiff).toBe('replace old guidance with new guidance');
      expect(candidate.originalContent).toBe('# original');
      expect(candidate.sourceSessionIds).toEqual(['session_99']);
      expect(candidate.artifactVersion).toBe(1);
    });

    it('generates unique patch IDs', () => {
      const generator = new PatchGeneratorImpl();
      const result = makeReviewResult();

      const c1 = generator.generateCandidate(result, '', []);
      const c2 = generator.generateCandidate(result, '', []);

      expect(c1.id).not.toBe(c2.id);
      expect(c1.id).toMatch(/^patch_\d+_[a-f0-9]+$/);
    });

    it('falls back to metadata.sourceSessionId when sessionIds is empty', () => {
      const generator = new PatchGeneratorImpl();
      const result = makeReviewResult();

      const candidate = generator.generateCandidate(result, '', []);
      expect(candidate.sourceSessionIds).toEqual(['session_99']);
    });

    it('sets createdAt and updatedAt as ISO strings', () => {
      const generator = new PatchGeneratorImpl();
      const result = makeReviewResult();

      const candidate = generator.generateCandidate(result, '', ['s1']);
      expect(new Date(candidate.createdAt).toISOString()).toBe(candidate.createdAt);
      expect(new Date(candidate.updatedAt).toISOString()).toBe(candidate.updatedAt);
    });

    it('truncates summary from justification to 200 chars', () => {
      const generator = new PatchGeneratorImpl();
      const longJustification = 'A'.repeat(300);
      const result = makeReviewResult({ justification: longJustification });

      const candidate = generator.generateCandidate(result, '', ['s1']);
      expect(candidate.summary.length).toBeLessThanOrEqual(200);
    });
  });
});
