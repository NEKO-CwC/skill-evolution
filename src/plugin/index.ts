/**
 * Plugin entry point that wires core modules and exposes runtime hooks.
 */

import type {
  FeedbackClassifier,
  FeedbackCollector,
  MergeManager,
  OverlayInjector,
  OverlayStore,
  PatchGenerator,
  PluginHooks,
  RefreshableReviewRunner,
  ReviewRunner,
  RollbackManager,
  SkillEvolutionConfig,
  Logger,
  ResolvedPaths,
} from '../shared/types.js';
import { getDefaultConfig } from './config.js';
import { resolvePaths } from '../shared/paths.js';
import { after_tool_call } from './hooks/after_tool_call.js';
import { agent_end } from './hooks/agent_end.js';
import { before_prompt_build } from './hooks/before_prompt_build.js';
import { message_received } from './hooks/message_received.js';
import { session_end } from './hooks/session_end.js';
import FeedbackClassifierImpl from './feedback/classifiers.js';
import FeedbackCollectorImpl from './feedback/collector.js';
import OverlayInjectorImpl from './overlay/overlay_injector.js';
import OverlayStoreImpl from './overlay/overlay_store.js';
import MergeManagerImpl from '../review/merge_manager.js';
import PatchGeneratorImpl from '../review/patch_generator.js';
import LLMReviewRunner from '../review/llm_review_runner.js';
import { LlmRuntimeResolver } from '../review/llm_runtime_resolver.js';
import RollbackManagerImpl from '../review/rollback_manager.js';
import { ConsoleLogger } from '../shared/logger.js';

/**
 * Type guard for ReviewRunner instances that support runtime context refresh.
 */
function isRefreshableReviewRunner(runner: ReviewRunner): runner is RefreshableReviewRunner {
  return typeof (runner as RefreshableReviewRunner).refreshRuntimeContext === 'function';
}

/**
 * Concrete plugin composition root and hook implementation.
 */
export class SkillEvolutionPlugin implements PluginHooks {
  public readonly config: SkillEvolutionConfig;

  public paths: ResolvedPaths;

  public readonly logger: Logger;

  public overlayStore: OverlayStore;

  public readonly overlayInjector: OverlayInjector;

  public feedbackCollector: FeedbackCollector;

  public readonly feedbackClassifier: FeedbackClassifier;

  public readonly patchGenerator: PatchGenerator;

  public mergeManager: MergeManager;

  public rollbackManager: RollbackManager;

  public reviewRunner: ReviewRunner;

  private readonly sessionSkillKeys: Map<string, string>;

  private readonly sessionStartedAt: Map<string, number>;

  private workspaceBound: boolean;

  /**
   * True when workspace was bound from a fallback source (e.g. process.cwd()).
   * A fallback-bound workspace can be upgraded when hook context provides
   * the real workspace path. Once upgraded, this flag is cleared.
   */
  private workspaceBoundFromFallback: boolean;

  /**
   * Initializes plugin dependencies with defaults for v1 skeleton.
   * @param workspaceDirIsFallback - When true, the workspaceDir binding
   *   is tentative and can be overridden by hook context later.
   */
  public constructor(
    config: SkillEvolutionConfig = getDefaultConfig(),
    workspaceDir?: string,
    workspaceDirIsFallback = false
  ) {
    this.config = config;
    this.paths = resolvePaths(workspaceDir ?? process.cwd(), this.config);
    this.workspaceBound = !!workspaceDir;
    this.workspaceBoundFromFallback = !!workspaceDir && workspaceDirIsFallback;
    this.logger = new ConsoleLogger('plugin.index');
    this.overlayStore = new OverlayStoreImpl(this.paths.overlaysDir);
    this.overlayInjector = new OverlayInjectorImpl();
    this.feedbackCollector = new FeedbackCollectorImpl(this.paths.feedbackDir);
    this.feedbackClassifier = new FeedbackClassifierImpl();
    this.reviewRunner = new LLMReviewRunner(this.config, this.paths);
    this.patchGenerator = new PatchGeneratorImpl();
    this.rollbackManager = new RollbackManagerImpl(this.config, this.paths.backupsDir, this.paths.skillsDir);
    this.mergeManager = new MergeManagerImpl(
      this.config,
      this.rollbackManager,
      this.paths.skillsDir,
      this.paths.patchesDir
    );
    this.sessionSkillKeys = new Map<string, string>();
    this.sessionStartedAt = new Map<string, number>();

    // When workspaceDir is provided at construction time, inject the resolver
    // immediately. ensureWorkspaceDir() won't run because workspaceBound is
    // already true, so the resolver must be created here.
    if (workspaceDir && isRefreshableReviewRunner(this.reviewRunner)) {
      const resolver = new LlmRuntimeResolver(this.paths.workspaceDir, this.logger);
      this.reviewRunner.refreshRuntimeContext({
        paths: this.paths,
        llmRuntimeResolver: resolver
      });
    }
  }

  /**
   * Whether the plugin has been bound to a real workspace directory.
   */
  public isWorkspaceBound(): boolean {
    return this.workspaceBound;
  }

  public ensureWorkspaceDir(workspaceDir: string): void {
    if (this.workspaceBound && !this.workspaceBoundFromFallback) {
      this.logger.debug('Workspace already bound, skipping', { existingWorkspace: this.paths.workspaceDir, requested: workspaceDir });
      return;
    }
    if (this.workspaceBoundFromFallback) {
      this.logger.info('Upgrading workspace from fallback binding', {
        fallbackWorkspace: this.paths.workspaceDir,
        newWorkspace: workspaceDir
      });
    }
    this.workspaceBound = true;
    this.workspaceBoundFromFallback = false;
    const oldWorkspace = this.paths.workspaceDir;
    this.paths = resolvePaths(workspaceDir, this.config);
    this.rebuildPathDependentComponents();

    // Refresh review runner via the typed interface if supported
    if (isRefreshableReviewRunner(this.reviewRunner)) {
      const resolver = new LlmRuntimeResolver(
        this.paths.workspaceDir,
        this.logger
      );
      this.reviewRunner.refreshRuntimeContext({
        paths: this.paths,
        llmRuntimeResolver: resolver
      });
    } else {
      // Fallback for non-refreshable runners (e.g. test stubs)
      this.reviewRunner.paths = this.paths;
    }

    this.logger.info('Workspace bound from runtime context', {
      workspaceDir,
      oldWorkspace,
      resolved: {
        workspaceDir: this.paths.workspaceDir,
        overlaysDir: this.paths.overlaysDir,
        patchesDir: this.paths.patchesDir,
        skillsDir: this.paths.skillsDir
      }
    });
  }

  /**
   * Rebuilds all path-dependent components after workspace rebind.
   */
  private rebuildPathDependentComponents(): void {
    this.overlayStore = new OverlayStoreImpl(this.paths.overlaysDir);
    this.feedbackCollector = new FeedbackCollectorImpl(this.paths.feedbackDir);
    this.rollbackManager = new RollbackManagerImpl(this.config, this.paths.backupsDir, this.paths.skillsDir);
    this.mergeManager = new MergeManagerImpl(
      this.config,
      this.rollbackManager,
      this.paths.skillsDir,
      this.paths.patchesDir
    );
  }

  /**
   * Runs prompt-build hook.
   */
  public async before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string> {
    return before_prompt_build(this, sessionId, skillKey, currentPrompt);
  }

  /**
   * Runs post-tool-call hook.
   */
  public async after_tool_call(
    sessionId: string,
    toolName: string,
    output: string,
    isError: boolean,
    rawResult?: unknown
  ): Promise<void> {
    return after_tool_call(this, sessionId, toolName, output, isError, rawResult);
  }

  /**
   * Runs message-received hook.
   */
  public async message_received(sessionId: string, message: string): Promise<void> {
    return message_received(this, sessionId, message);
  }

  /**
   * Runs agent-end hook.
   */
  public async agent_end(sessionId: string): Promise<void> {
    return agent_end(this, sessionId);
  }

  public async session_end(sessionId: string): Promise<void> {
    return session_end(this, sessionId);
  }

  public ensureSessionStarted(sessionId: string): void {
    if (!this.sessionStartedAt.has(sessionId)) {
      this.sessionStartedAt.set(sessionId, Date.now());
      this.logger.debug('Session started', { sessionId });
    }
  }

  public setSessionSkillKey(sessionId: string, skillKey: string): void {
    this.sessionSkillKeys.set(sessionId, skillKey);
  }

  public getSessionSkillKey(sessionId: string): string {
    return this.sessionSkillKeys.get(sessionId) ?? 'unknown-skill';
  }

  public getSessionStartTime(sessionId: string): number {
    return this.sessionStartedAt.get(sessionId) ?? Date.now();
  }

  public endSession(sessionId: string): void {
    this.sessionSkillKeys.delete(sessionId);
    this.sessionStartedAt.delete(sessionId);
    this.logger.debug('Session ended', { sessionId });
  }
}

export default SkillEvolutionPlugin;
