import { join } from 'node:path';
import type { ReviewResult, SessionSummary, ResolvedPaths, SkillEvolutionConfig, RefreshableReviewRunner, LlmResolver, ResolvedProvider } from '../shared/types.js';
import ConsoleLogger from '../shared/logger.js';
import { LlmRuntimeResolver } from './llm_runtime_resolver.js';

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

/**
 * Builds a prompt for LLM-based skill modification review.
 */
function buildReviewPrompt(summary: SessionSummary, skillContent: string): string {
  const errorEvents = summary.events.filter(e => e.eventType === 'tool_error');
  const correctionEvents = summary.events.filter(e => e.eventType === 'user_correction');
  const positiveEvents = summary.events.filter(e => e.eventType === 'positive_feedback');
  const overlays = summary.overlays;

  let prompt = `You are an expert in refining AI assistant skill documentation. Below is a summary of a recent session where the skill had issues.

# Session Summary
- Session ID: ${summary.sessionId}
- Skill: ${summary.skillKey}
- Duration: ${summary.durationMs}ms
- Total Errors: ${summary.totalErrors}

# Current Skill Documentation
\`\`\`markdown
${skillContent || '(empty or missing)'}
\`\`\`

# Problem Signals

## Tool Errors (${errorEvents.length})
${errorEvents.map((e, i) => `### ${i + 1}. Tool: ${e.toolName || 'unknown'}
- Severity: ${e.severity}
- Message: ${e.messageExcerpt || 'no details'}`).join('\n') || 'None'}

## User Corrections (${correctionEvents.length})
${correctionEvents.map((e, i) => `### ${i + 1}. Message excerpt:
${e.messageExcerpt || 'empty'}`).join('\n') || 'None'}

## Overlays Generated (${overlays.length})
${overlays.map((o, i) => `### ${i + 1}. ${o.reasoning}
\`\`\`
${o.content}
\`\`\``).join('\n') || 'None'}

## Positive Feedback (${positiveEvents.length})
${positiveEvents.map((e, i) => `### ${i + 1}. ${e.messageExcerpt || 'none'}`).join('\n') || 'None'}

# Task
Based on the signals above, propose a patch to improve the skill's documentation (SKILL.md). The patch should:

1. Address common failure modes by clarifying usage, required parameters, or error handling
2. Incorporate user corrections to better match real needs
3. Keep the existing structure but improve clarity and robustness
4. Be formatted as a unified diff (subject to refinement by the patch generator)

Return your suggested changes in markdown with clear "## Proposed Changes" and "## Original Content" sections.`;

  return prompt;
}

/**
 * LLM-based review runner that generates skill modification suggestions via AI.
 */
export class LLMReviewRunner implements RefreshableReviewRunner {
  private readonly config: SkillEvolutionConfig;
  private readonly logger = new ConsoleLogger('review_runner.llm');
  private readonly skillContentCache: Map<string, string> = new Map();
  public paths: ResolvedPaths | null;
  private llmResolver?: LlmResolver | null;

  public constructor(config: SkillEvolutionConfig = DEFAULT_CONFIG, paths: ResolvedPaths | null = null) {
    this.config = config;
    this.paths = paths;
  }

  /**
   * Refreshes runtime context after workspace binding changes.
   * Clears stale caches so subsequent reviews use the new workspace paths.
   */
  public refreshRuntimeContext(ctx: {
    paths: ResolvedPaths;
    llmRuntimeResolver?: LlmResolver | null;
  }): void {
    this.logger.info('Refreshing runtime context', {
      oldWorkspaceDir: this.paths?.workspaceDir,
      newWorkspaceDir: ctx.paths.workspaceDir,
      hasResolver: !!ctx.llmRuntimeResolver,
      cacheSize: this.skillContentCache.size
    });
    this.paths = ctx.paths;
    this.skillContentCache.clear();
    this.llmResolver = ctx.llmRuntimeResolver ?? null;
  }

  /**
   * Executes LLM-powered review.
   */
  public async runReview(summary: SessionSummary): Promise<ReviewResult> {
    const { sessionId, skillKey, totalErrors, events, overlays } = summary;
    const correctionCount = events.filter(e => e.eventType === 'user_correction').length;
    const positiveCount = events.filter(e => e.eventType === 'positive_feedback').length;

    // Determine if we should recommend modification
    const shouldRecommend = totalErrors > 0 || correctionCount > 0 || overlays.length > 0;
    const riskLevel = this.getRiskLevel(totalErrors + correctionCount);

    if (!shouldRecommend) {
      return {
        isModificationRecommended: false,
        justification: `No significant issues detected (errors: ${totalErrors}, corrections: ${correctionCount}, overlays: ${overlays.length}).`,
        proposedDiff: '',
        riskLevel,
        metadata: {
          skillKey,
          patchId: `patch_${Date.now()}`,
          baseVersion: 'latest',
          sourceSessionId: sessionId,
          mergeMode: this.config.merge.requireHumanMerge ? 'manual' : 'auto',
          riskLevel,
          rollbackChainDepth: 0
        }
      };
    }

    try {
      // Read current skill content
      const skillContent = await this.getSkillContent(skillKey);

      // Build prompt and call LLM
      const prompt = buildReviewPrompt(summary, skillContent);
      const llmOutput = await this.callLLM(prompt);

      // Extract the diff from LLM response
      const proposedDiff = this.extractDiff(llmOutput);

      const result: ReviewResult = {
        isModificationRecommended: true,
        justification: `LLM analysis complete: ${totalErrors} errors, ${correctionCount} corrections, ${positiveCount} positive signals, ${overlays.length} overlays.`,
        proposedDiff,
        riskLevel,
        metadata: {
          skillKey,
          patchId: `patch_${Date.now()}`,
          baseVersion: 'latest',
          sourceSessionId: sessionId,
          mergeMode: this.config.merge.requireHumanMerge ? 'manual' : 'auto',
          riskLevel,
          rollbackChainDepth: 0
        }
      };

      this.logger.info('LLM review completed', {
        sessionId,
        skillKey,
        patchId: result.metadata.patchId,
        riskLevel,
        diffLength: proposedDiff.length
      });

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('LLM review failed', { sessionId, skillKey, error: message });

      // Fallback to simple overlay-based diff if LLM fails
      const fallbackDiff = `# LLM Unavailable - Using Fallback\n\n${overlays.map(o => o.content).join('\n\n')}`;
      return {
        isModificationRecommended: true,
        justification: `LLM unavailable, using fallback. Errors: ${totalErrors}, corrections: ${correctionCount}.`,
        proposedDiff: fallbackDiff,
        riskLevel,
        metadata: {
          skillKey,
          patchId: `patch_${Date.now()}`,
          baseVersion: 'latest',
          sourceSessionId: sessionId,
          mergeMode: this.config.merge.requireHumanMerge ? 'manual' : 'auto',
          riskLevel,
          rollbackChainDepth: 0
        }
      };
    }
  }

  private async getSkillContent(skillKey: string): Promise<string> {
    const cached = this.skillContentCache.get(skillKey);
    if (cached !== undefined) {
      return cached;
    }

    const baseSkillsDir = this.paths?.skillsDir ?? join(process.cwd(), 'skills');
    const skillPath = join(baseSkillsDir, skillKey, 'SKILL.md');
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(skillPath, 'utf8');
      this.skillContentCache.set(skillKey, content);
      return content;
    } catch {
      this.logger.warn('Skill content not found, using empty', { skillKey, path: skillPath });
      return ''; // Return empty instead of throwing
    }
  }

  private async callLLM(prompt: string): Promise<string> {
    const primaryConfig = this.config.llm.inheritPrimaryConfig
      ? this.readPrimaryModelFromConfig()
      : null;
    const model = this.config.llm.modelOverride ?? primaryConfig?.model ?? null;

    if (!model) {
      throw new Error('No LLM model configured. Set skillEvolution.llm.modelOverride or enable inheritPrimaryConfig.');
    }

    // Use explicit provider from config if set, otherwise use inferred provider
    // from the primary model config (matches first segment against models.providers)
    const effectiveProvider = this.config.llm.provider ?? primaryConfig?.provider ?? null;

    this.logger.debug('Attempting LLM call', { model, effectiveProvider, promptLength: prompt.length });

    const resolved = this.resolveProvider(model, effectiveProvider);

    this.logger.debug('LLM provider resolved', {
      resolvedFrom: resolved.resolvedFrom,
      baseUrl: resolved.baseUrl,
      api: resolved.api,
      modelId: resolved.modelId
    });

    // Build request based on API type
    const { baseUrl, apiKey, api: apiType, modelId } = resolved;
    let endpoint: string;
    let body: unknown;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (apiType === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      endpoint = `${baseUrl.replace(/\/$/, '')}/messages`;
      body = {
        model: modelId,
        max_tokens: 16384,
        messages: [
          { role: 'user', content: prompt }
        ],
        stream: false
      };
    } else if (apiType === 'openai') {
      headers['Authorization'] = `Bearer ${apiKey}`;
      endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      body = {
        model: modelId,
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 16384,
        stream: false
      };
    } else {
      throw new Error(`Unsupported API type: ${apiType}`);
    }

    this.logger.debug('Calling LLM endpoint', { endpoint, model: modelId, apiType });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as Record<string, unknown>;

    // Parse response based on API type
    let completion: string;
    if (apiType === 'anthropic-messages') {
      const content = data.content as Array<{ text?: string }> | undefined;
      completion = content?.[0]?.text ?? '';
    } else {
      const choices = data.choices as Array<{ message?: { content?: string; reasoning?: string } }> | undefined;
      const message = choices?.[0]?.message;
      completion = message?.content ?? '';
      // Reasoning models (e.g. stepfun/step-3.5-flash) may put output in reasoning field
      // when max_tokens is exhausted by internal chain-of-thought
      if (!completion && message?.reasoning) {
        this.logger.warn('LLM content empty, falling back to reasoning field', {
          reasoningLength: message.reasoning.length,
          finishReason: (choices?.[0] as Record<string, unknown>)?.finish_reason
        });
        completion = message.reasoning;
      }
    }

    if (!completion) {
      throw new Error('LLM returned empty completion');
    }

    return completion;
  }

  /**
   * Resolves provider via the injected LlmResolver. If the resolver was not
   * injected (e.g. constructor received workspaceDir but ensureWorkspaceDir
   * was skipped), constructs one on-the-fly from the available workspace path.
   */
  private resolveProvider(model: string, providerOverride?: string | null): ResolvedProvider {
    const provider = providerOverride ?? this.config.llm.provider ?? null;
    if (this.llmResolver) {
      return this.llmResolver.resolve(model, provider);
    }

    // Safety net: construct a resolver on-the-fly when paths are available.
    // This handles the case where the plugin constructor sets workspaceBound=true
    // before ensureWorkspaceDir has a chance to inject the resolver.
    if (this.paths?.workspaceDir) {
      this.logger.warn('No LlmResolver injected, constructing on-the-fly from workspace path', {
        workspaceDir: this.paths.workspaceDir
      });
      const onTheFly = new LlmRuntimeResolver(this.paths.workspaceDir, this.logger);
      // Cache for subsequent calls in this session
      this.llmResolver = onTheFly;
      return onTheFly.resolve(model, provider);
    }

    throw new Error('LLM provider not configured. No LlmResolver injected and no workspace path available.');
  }

  /**
   * Reads the primary model and inferred provider from openclaw.json via the LlmRuntimeResolver.
   * Falls back to null if no resolver is available or no config found.
   */
  private readPrimaryModelFromConfig(): { model: string; provider: string | null } | null {
    if (this.llmResolver && this.llmResolver instanceof LlmRuntimeResolver) {
      return this.llmResolver.readPrimaryModel();
    }

    if (this.paths?.workspaceDir) {
      const resolver = new LlmRuntimeResolver(this.paths.workspaceDir, this.logger);
      return resolver.readPrimaryModel();
    }

    return null;
  }

  private extractDiff(llmOutput: string): string {
    // Try to extract markdown sections
    const proposedMatch = llmOutput.match(/## Proposed Changes\n([\s\S]*?)(?=\n## Original Content\n|$)/);
    const originalMatch = llmOutput.match(/## Original Content\n([\s\S]*)/);

    if (proposedMatch && originalMatch) {
      return `## Proposed Changes\n${proposedMatch[1].trim()}\n\n## Original Content\n${originalMatch[1].trim()}`;
    }

    // Fallback to full output
    return llmOutput.trim();
  }

  private getRiskLevel(totalSignals: number): 'low' | 'medium' | 'high' {
    if (totalSignals <= 1) return 'low';
    if (totalSignals <= 3) return 'medium';
    return 'high';
  }
}

export default LLMReviewRunner;