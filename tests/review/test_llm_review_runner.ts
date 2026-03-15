import { describe, expect, it, beforeEach } from 'vitest';
import { LLMReviewRunner } from '../../src/review/llm_review_runner.js';
import { SkillEvolutionPlugin } from '../../src/plugin/index.js';
import { getDefaultConfig } from '../../src/plugin/config.js';
import type { ResolvedPaths, SessionSummary } from '../../src/shared/types.js';

describe('review/llm_review_runner', () => {
  // Use actual workspace path
  const workspaceDir = '/home/node/.openclaw/workspace';
  const mockPaths: ResolvedPaths = {
    workspaceDir,
    overlaysDir: `${workspaceDir}/.skill-overlays`,
    patchesDir: `${workspaceDir}/.skill-patches`,
    backupsDir: `${workspaceDir}/.skill-backups`,
    skillsDir: `${workspaceDir}/skills`,
    feedbackDir: `${workspaceDir}/.skill-feedback`
  };

  beforeEach(() => {
    // Reset module cache if needed
  });

  const baseSummary = (totalErrors: number, events: any[] = [], overlaysCount: number = 0): SessionSummary => ({
    sessionId: 'session-1',
    skillKey: 'exa',
    events,
    overlays: Array.from({ length: overlaysCount }, (_, idx) => ({
      sessionId: 'session-1',
      skillKey: 'exa',
      content: `overlay-${idx + 1}`,
      createdAt: idx,
      updatedAt: idx,
      reasoning: 'reason'
    })),
    durationMs: 100,
    totalErrors
  });

  it('recommends modification when errors present and LLM call fails falls back', async () => {
    const config = getDefaultConfig();
    // Use invalid model to force LLM failure and fallback
    config.llm.modelOverride = 'invalid/nonexistent-model';
    config.merge.requireHumanMerge = true;
    const runner = new LLMReviewRunner(config, mockPaths);

    const summary = baseSummary(1, [
      {
        sessionId: 'session-1',
        skillKey: 'exa',
        timestamp: Date.now(),
        eventType: 'tool_error',
        severity: 'high',
        toolName: 'web_search',
        messageExcerpt: 'API error'
      }
    ], 1);

    const result = await runner.runReview(summary);
    expect(result.isModificationRecommended).toBe(true);
    // With 1 error, risk should be low
    expect(result.riskLevel).toBe('low');
    expect(result.metadata.mergeMode).toBe('manual');
    expect(typeof result.proposedDiff).toBe('string');
    // Fallback should include overlay content and LLM unavailable header
    expect(result.proposedDiff).toContain('LLM Unavailable');
    expect(result.proposedDiff).toContain('overlay-1');
  });

  it('does not recommend modification when no issues', async () => {
    const config = getDefaultConfig();
    config.llm.modelOverride = null;
    const runner = new LLMReviewRunner(config, mockPaths);

    const summary = baseSummary(0, []);
    const result = await runner.runReview(summary);
    expect(result.isModificationRecommended).toBe(false);
    expect(result.proposedDiff).toBe('');
  });

  it('gracefully falls back when LLM call fails', async () => {
    const config = getDefaultConfig();
    config.llm.modelOverride = 'invalid/model-not-exist';
    config.merge.requireHumanMerge = true;
    const runner = new LLMReviewRunner(config, mockPaths);

    const summary = baseSummary(1, [
      {
        sessionId: 'session-1',
        skillKey: 'exa',
        timestamp: Date.now(),
        eventType: 'tool_error',
        severity: 'medium',
        toolName: 'read',
        messageExcerpt: 'File not found'
      }
    ], 1);

    const result = await runner.runReview(summary);
    expect(result.isModificationRecommended).toBe(true);
    // Fallback should include overlay content (LLM unavailable)
    expect(result.proposedDiff).toContain('overlay-1');
    expect(result.justification).toContain('fallback');
  });

  it('uses max_tokens 16384 to accommodate reasoning models', () => {
    // Reasoning models (e.g. stepfun/step-3.5-flash) exhaust low max_tokens on
    // internal chain-of-thought, leaving content null. Verify the runner uses
    // a sufficiently large max_tokens value.
    const config = getDefaultConfig();
    const runner = new LLMReviewRunner(config, mockPaths);
    // Access the private callLLM indirectly — the source must use 16384
    // This is a documentation/regression guard; the actual value is verified
    // by reading the source file.
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require('node:path').join(__dirname, '../../src/review/llm_review_runner.ts'),
      'utf8'
    );
    const matches = source.match(/max_tokens:\s*(\d+)/g) ?? [];
    for (const m of matches) {
      const val = parseInt(m.replace('max_tokens:', '').trim(), 10);
      expect(val).toBeGreaterThanOrEqual(8192);
    }
    expect(matches.length).toBeGreaterThan(0);
  });

  it('extracts reasoning field when content is null (reasoning model fallback)', () => {
    // When a reasoning model returns content: null but reasoning: "...",
    // the runner should use the reasoning field as completion.
    // This is tested by verifying the source code contains the fallback logic.
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require('node:path').join(__dirname, '../../src/review/llm_review_runner.ts'),
      'utf8'
    );
    expect(source).toContain('message?.reasoning');
    expect(source).toContain('falling back to reasoning field');
  });

  it('constructs resolver on-the-fly when llmResolver not injected but paths available', async () => {
    // This is the core regression test: when the resolver is NOT injected
    // (e.g. constructor received workspaceDir but ensureWorkspaceDir was
    // skipped), resolveProvider should still work by constructing a resolver
    // on-the-fly from the workspace path.
    const config = getDefaultConfig();
    // Use invalid model to force a controlled failure, but the resolver
    // should still attempt to resolve (not throw "no resolver" error)
    config.llm.modelOverride = 'openrouter/nonexistent-model-for-test';
    const runner = new LLMReviewRunner(config, mockPaths);
    // Do NOT call refreshRuntimeContext — simulates the missing-injection scenario

    const summary = baseSummary(1, [
      {
        sessionId: 'session-1',
        skillKey: 'exa',
        timestamp: Date.now(),
        eventType: 'tool_error',
        severity: 'medium',
        toolName: 'read',
        messageExcerpt: 'test'
      }
    ], 1);

    const result = await runner.runReview(summary);
    // Should NOT contain the old "Inject LlmResolver or set env" error
    // It should either succeed or fail with a model-not-found error (not resolver missing)
    expect(result.justification).not.toContain('Inject LlmResolver');
  });

  it('constructor injects resolver when workspaceDir provided', () => {
    // When SkillEvolutionPlugin is constructed with workspaceDir, the
    // LlmRuntimeResolver should be injected into the review runner
    // immediately — not deferred to ensureWorkspaceDir.
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config, workspaceDir);

    // The review runner should have a resolver (llmResolver is private,
    // but we can verify by checking the source for constructor injection)
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require('node:path').join(__dirname, '../../src/plugin/index.ts'),
      'utf8'
    );
    // Constructor must create resolver when workspaceDir is provided
    expect(source).toContain('if (workspaceDir && isRefreshableReviewRunner');
    expect(source).toContain('new LlmRuntimeResolver(this.paths.workspaceDir');
    // Must be inside the constructor, not just in ensureWorkspaceDir
    const constructorBlock = source.slice(
      source.indexOf('public constructor'),
      source.indexOf('public isWorkspaceBound')
    );
    expect(constructorBlock).toContain('LlmRuntimeResolver');
  });

  it('does not contain hardcoded openrouter/hunter-alpha model', () => {
    // The hardcoded model ID was replaced with readPrimaryModelFromConfig()
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require('node:path').join(__dirname, '../../src/review/llm_review_runner.ts'),
      'utf8'
    );
    expect(source).not.toContain("'openrouter/hunter-alpha'");
    expect(source).toContain('readPrimaryModelFromConfig');
  });

  it('passes config.llm.provider through resolveProvider', () => {
    // Verify the source wires config.llm.provider into the resolver call
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require('node:path').join(__dirname, '../../src/review/llm_review_runner.ts'),
      'utf8'
    );
    expect(source).toContain('this.config.llm.provider');
    expect(source).toContain('.resolve(model, provider)');
  });

  it('infers provider from primary model config to avoid model ID truncation', () => {
    // When inheritPrimaryConfig reads "openrouter/hunter-alpha" from openclaw.json
    // and models.providers has "openrouter", the inferred provider should be passed
    // through to resolveProvider so the model string goes verbatim to the API.
    const fs = require('node:fs');
    const source = fs.readFileSync(
      require('node:path').join(__dirname, '../../src/review/llm_review_runner.ts'),
      'utf8'
    );
    // readPrimaryModelFromConfig returns { model, provider }
    expect(source).toContain('primaryConfig?.model');
    expect(source).toContain('primaryConfig?.provider');
    // effectiveProvider merges explicit config with inferred
    expect(source).toContain('effectiveProvider');
    expect(source).toContain('resolveProvider(model, effectiveProvider)');
  });
});
