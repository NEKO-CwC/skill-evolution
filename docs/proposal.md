# Proposal: OpenClaw Skill Evolution Plugin

## Project Name
**OpenClaw Skill Evolution Plugin**  
*Subtitle: Feedback-driven Skill README / SKILL.md Self-Iteration Plugin*

## Background
OpenClaw's skill mechanism uses static `SKILL.md` files for SOPs and tool constraints. While effective, skills are currently "snapshots" taken at session start. There is no native mechanism for session-local temporary corrections that don't pollute the global skill library. Directly editing skill files during a session is unreliable for temporary fixes.

This project splits skill evolution into two distinct layers:
1. **Session-local Overlay**: Temporary corrections applied only to the current session.
2. **Post-session Evolution**: Formal skill updates via a review subagent that generates patches for permanent merging.

## Goals
- Build an OpenClaw plugin that iterates `SKILL.md` files based on:
    - Tool execution results (errors/retries).
    - Positive and negative user feedback.
    - Correction trajectories within a session.
    - Complete post-session reviews.
- Enable immediate session-local behavior changes without side effects on other sessions.
- Automate the generation of formal skill patches with controlled merge policies.
- Maintain a version history (up to 5 versions) for safe rollbacks.

## Non-Goals (v1)
- Modifying OpenClaw core code.
- Directly writing temporary corrections into shared `SKILL.md` files.
- Hybrid merge strategies (per-patch settings); v1 uses a global policy.
- Complex integration testing platforms (focus on unit tests and mock workflows).

## Product Definition
A plugin that orchestrates feedback collection, session-local overlays, post-session review, patch merging, and version rollback to create a self-evolving skill ecosystem.

## Core Design (3-Layer Architecture)
### 1. Plugin Hook Layer
- Monitors tool calls and user messages.
- Manages the session-local overlay state.
- Injects overlays via `before_prompt_build` to shape the model's behavior in real-time.

### 2. Review Subagent Layer
- Summarizes the session's skill usage and feedback.
- Determines which corrections should be permanent.
- Generates `PATCH.md` and merge/risk notes.
- Executes merge logic based on user configuration.

### 3. Skill Version Management Layer
- Handles writing permanent updates back to skill files.
- Maintains a rolling backup of the last 5 versions for each skill.
- Provides rollback capabilities and changelog maintenance.

## Workflow Summary
- **During Session**: If a tool fails or a user corrects the agent, a temporary overlay is generated and stored in `.skill-overlays/SESSION_ID/`. This overlay is injected into subsequent prompts.
- **Session End**: A subagent reviews the session logs and overlays. It produces a formal patch draft.
- **Merge Phase**: Depending on `requireHumanMerge`, the patch is either auto-applied or held for manual approval.

## Repository Structure
- `src/plugin/`: Hooks for session lifecycle and feedback collection.
- `src/review/`: Logic for patch generation, merging, and rollbacks.
- `src/shared/`: Types, file system utilities, and logging.
- `prompts/`: System prompts for the review subagent.
- `tests/`: Unit and mock workflow tests.

## Success Criteria
1. Session-local corrections immediately affect subsequent agent behavior.
2. Temporary overlays do not affect other concurrent or future sessions.
3. Stable patch generation at session end.
4. Functional global `requireHumanMerge` switch.
5. Reliable rollback mechanism for the last 5 versions.
6. Comprehensive documentation and test coverage.

## ⚠️ To Be Verified
- The exact format for "injecting" overlays into `before_prompt_build` (e.g., prepending to system message vs. adding as a new context block).
- Performance overhead of spawning a subagent for every session review.
