/**
 * Tool registration orchestrator — registers patch tools with the OpenClaw plugin API.
 */

import type { AgentToolDefinition, OpenClawPluginApi } from '../../shared/types.js';
import type { PatchQueueManager } from '../../review/patch_queue.js';
import type { MergeManager } from '../../shared/types.js';
import {
  patchList,
  patchGet,
  patchApply,
  patchReject,
  patchStatus,
  reviewEnqueue,
  patchNotify,
  type PatchToolDeps,
} from './patch_tools.js';

function makeTools(deps: PatchToolDeps): AgentToolDefinition[] {
  return [
    {
      name: 'skill_evolution_patch_list',
      description: 'List patch candidates with optional filters by skillKey, status, and limit.',
      inputSchema: {
        type: 'object',
        properties: {
          skillKey: { type: 'string', description: 'Filter by skill key' },
          status: { type: 'string', description: 'Filter by patch status' },
          limit: { type: 'number', description: 'Max results to return' },
        },
      },
      handler: (params) => patchList(deps, params) as Promise<unknown>,
    },
    {
      name: 'skill_evolution_patch_get',
      description: 'Get full details of a patch candidate by ID.',
      inputSchema: {
        type: 'object',
        properties: { patchId: { type: 'string', description: 'Patch ID' } },
        required: ['patchId'],
      },
      handler: (params) => patchGet(deps, params) as Promise<unknown>,
    },
    {
      name: 'skill_evolution_patch_apply',
      description: 'Apply a patch candidate to the skill file. Creates backup and transitions to applied.',
      inputSchema: {
        type: 'object',
        properties: { patchId: { type: 'string', description: 'Patch ID to apply' } },
        required: ['patchId'],
      },
      handler: (params) => patchApply(deps, params) as Promise<unknown>,
    },
    {
      name: 'skill_evolution_patch_reject',
      description: 'Reject a patch candidate with an optional reason.',
      inputSchema: {
        type: 'object',
        properties: {
          patchId: { type: 'string', description: 'Patch ID to reject' },
          reason: { type: 'string', description: 'Rejection reason' },
        },
        required: ['patchId'],
      },
      handler: (params) => patchReject(deps, params) as Promise<unknown>,
    },
    {
      name: 'skill_evolution_patch_status',
      description: 'Get the status, risk, and summary of a patch candidate.',
      inputSchema: {
        type: 'object',
        properties: { patchId: { type: 'string', description: 'Patch ID' } },
        required: ['patchId'],
      },
      handler: (params) => patchStatus(deps, params) as Promise<unknown>,
    },
    {
      name: 'skill_evolution_review_enqueue',
      description: 'Transition a patch to reviewing status for review agent processing.',
      inputSchema: {
        type: 'object',
        properties: { patchId: { type: 'string', description: 'Patch ID to enqueue' } },
        required: ['patchId'],
      },
      handler: (params) => reviewEnqueue(deps, params) as Promise<unknown>,
    },
    {
      name: 'skill_evolution_patch_notify',
      description: 'Send a notification for a patch candidate. Returns notified=false for superseded/terminal patches.',
      inputSchema: {
        type: 'object',
        properties: {
          patchId: { type: 'string', description: 'Patch ID' },
          channel: { type: 'string', description: 'Notification channel' },
        },
        required: ['patchId'],
      },
      handler: (params) => patchNotify(deps, params) as Promise<unknown>,
    },
  ];
}

export function registerPatchTools(
  api: OpenClawPluginApi,
  deps: PatchToolDeps
): void {
  if (typeof api.registerTool !== 'function') {
    return;
  }

  const tools = makeTools(deps);
  for (const tool of tools) {
    api.registerTool(tool);
  }
}

export { makeTools };
