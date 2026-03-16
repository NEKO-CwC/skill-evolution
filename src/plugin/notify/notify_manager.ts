/**
 * Notification manager: debounce, digest, dedupe, risk-filter.
 */

import ConsoleLogger from '../../shared/logger.js';
import type { PatchQueueManager } from '../../review/patch_queue.js';
import type { PatchStatus, RiskLevel, SkillEvolutionConfig } from '../../shared/types.js';

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high'];

interface NotifyRecord {
  patchId: string;
  skillKey: string;
  sentAt: number;
}

export class NotifyManager {
  private readonly config: SkillEvolutionConfig;
  private readonly patchQueue: PatchQueueManager;
  private readonly logger = new ConsoleLogger('notify_manager');

  /** Tracks last notification time per skillKey for debounce. */
  private readonly lastNotifiedPerSkill = new Map<string, number>();

  /** Tracks which patchIds have been notified (idempotent). */
  private readonly notifiedPatchIds = new Set<string>();

  /** Pending notifications for digest mode. */
  private readonly pendingDigest: NotifyRecord[] = [];

  public constructor(config: SkillEvolutionConfig, patchQueue: PatchQueueManager) {
    this.config = config;
    this.patchQueue = patchQueue;
  }

  /**
   * Schedule a notification for a patch, respecting debounce/risk/dedupe rules.
   * Returns true if notification was sent, false if suppressed.
   */
  public async schedule(patchId: string): Promise<boolean> {
    const notifyConfig = this.config.notify;
    if (!notifyConfig?.enabled || notifyConfig.mode === 'off') {
      return false;
    }

    // Fetch patch to check status and risk
    let candidate;
    try {
      candidate = await this.patchQueue.get(patchId);
    } catch {
      this.logger.warn('Cannot notify: patch not found', { patchId });
      return false;
    }

    // Dedupe: skip non-notifiable statuses
    const nonNotifiable: PatchStatus[] = ['superseded', 'applied', 'rejected', 'failed'];
    if (nonNotifiable.includes(candidate.status)) {
      return false;
    }

    // Dedupe: already notified this exact patchId
    if (this.notifiedPatchIds.has(patchId)) {
      return false;
    }

    // Digest mode: queue for later
    if (notifyConfig.mode === 'digest' && this.config.notifications?.digestCron) {
      this.pendingDigest.push({
        patchId,
        skillKey: candidate.skillKey,
        sentAt: 0,
      });
      this.logger.debug('Patch queued for digest', { patchId, skillKey: candidate.skillKey });
      return false;
    }

    // Per-session mode: check risk filter and debounce
    const minRisk = this.config.notifications?.minRiskToInterrupt ?? 'medium';
    if (RISK_ORDER.indexOf(candidate.risk) < RISK_ORDER.indexOf(minRisk)) {
      this.logger.debug('Notification skipped: risk too low', {
        patchId,
        risk: candidate.risk,
        minRisk,
      });
      return false;
    }

    // Debounce check
    const debounceSeconds = this.config.notifications?.debounceSeconds ?? 300;
    const lastNotified = this.lastNotifiedPerSkill.get(candidate.skillKey);
    if (lastNotified) {
      const elapsedMs = Date.now() - lastNotified;
      if (elapsedMs < debounceSeconds * 1000) {
        this.logger.debug('Notification debounced', {
          patchId,
          skillKey: candidate.skillKey,
          elapsedMs,
          debounceMs: debounceSeconds * 1000,
        });
        return false;
      }
    }

    // Send notification
    await this.sendNotification(patchId, candidate.skillKey, candidate.risk, candidate.summary);
    return true;
  }

  /**
   * Build and send a digest of all pending notifications.
   * Returns the number of patches included.
   */
  public async sendDigest(): Promise<number> {
    const validPending: NotifyRecord[] = [];

    for (const record of this.pendingDigest) {
      if (this.notifiedPatchIds.has(record.patchId)) continue;
      try {
        const patch = await this.patchQueue.get(record.patchId);
        const nonNotifiable: PatchStatus[] = ['superseded', 'applied', 'rejected', 'failed'];
        if (!nonNotifiable.includes(patch.status)) {
          validPending.push(record);
        }
      } catch {
        // patch no longer exists
      }
    }

    if (validPending.length === 0) {
      return 0;
    }

    const digestLines = ['[Skill Evolution] Digest: pending patches\n'];
    for (const record of validPending) {
      try {
        const patch = await this.patchQueue.get(record.patchId);
        digestLines.push(`- ${patch.id} (${patch.skillKey}, risk=${patch.risk}): ${patch.summary}`);
        this.notifiedPatchIds.add(record.patchId);
        this.lastNotifiedPerSkill.set(record.skillKey, Date.now());
      } catch {
        // skip
      }
    }

    this.logger.info('Digest notification sent', {
      patchCount: validPending.length,
      digest: digestLines.join('\n'),
    });

    // Clear pending
    this.pendingDigest.length = 0;
    return validPending.length;
  }

  /**
   * Auto-supersede when too many patches accumulate for same skill.
   * Returns number of superseded patches.
   */
  public async enforceFloodLimit(skillKey: string): Promise<number> {
    const maxPending = this.config.queue?.maxPendingPerSkill ?? 20;
    const dedupeWindow = (this.config.queue?.dedupeWindowMinutes ?? 60) * 60 * 1000;
    const now = Date.now();

    const pending = await this.patchQueue.findPendingForSkill(skillKey);
    const recent = pending.filter((p) => {
      const createdAt = new Date(p.createdAt).getTime();
      return now - createdAt < dedupeWindow;
    });

    if (recent.length <= 3) {
      return 0;
    }

    // Keep the latest, supersede the rest
    const sorted = [...recent].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const latest = sorted[0];
    let superseded = 0;

    for (let i = 1; i < sorted.length; i++) {
      const old = sorted[i];
      await this.patchQueue.supersede(old.id, latest.id);

      // Remove from pending digest
      const digestIdx = this.pendingDigest.findIndex((r) => r.patchId === old.id);
      if (digestIdx >= 0) {
        this.pendingDigest.splice(digestIdx, 1);
      }
      superseded++;
    }

    this.logger.info('Flood limit enforced', {
      skillKey,
      superseded,
      surviving: latest.id,
    });

    return superseded;
  }

  private async sendNotification(
    patchId: string,
    skillKey: string,
    risk: RiskLevel,
    summary: string
  ): Promise<void> {
    const message = [
      '[Skill Evolution] Patch ready for review',
      '',
      `Patch: ${patchId}`,
      `Skill: ${skillKey}`,
      `Risk: ${risk}`,
      `Summary: ${summary}`,
      '',
      'Actions:',
      `- apply ${patchId}`,
      `- reject ${patchId}`,
      `- show ${patchId}`,
    ].join('\n');

    this.logger.info('Notification sent', { patchId, skillKey, risk, message });
    this.notifiedPatchIds.add(patchId);
    this.lastNotifiedPerSkill.set(skillKey, Date.now());
  }
}

export default NotifyManager;
