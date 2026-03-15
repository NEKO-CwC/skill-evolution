/**
 * Feedback collection adapter implementing event persistence contract.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, fileExists, readFile } from '../../shared/fs.js';
import type { FeedbackCollector, FeedbackEvent } from '../../shared/types.js';

/**
 * Default feedback collector placeholder implementation.
 */
export class FeedbackCollectorImpl implements FeedbackCollector {
  private readonly feedbackDir: string;

  private readonly cache: Map<string, FeedbackEvent[]>;

  public constructor(feedbackDir: string) {
    this.feedbackDir = feedbackDir;
    this.cache = new Map<string, FeedbackEvent[]>();
  }

  /**
   * Collects a feedback event.
   */
  public async collect(event: FeedbackEvent): Promise<void> {
    await ensureDir(this.feedbackDir);
    const sessionFilePath = this.getSessionFilePath(event.sessionId);

    if (!this.cache.has(event.sessionId) && (await fileExists(sessionFilePath))) {
      const existingEvents = await this.readSessionEventsFromDisk(sessionFilePath);
      this.cache.set(event.sessionId, existingEvents);
    }

    await appendFile(sessionFilePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });

    const sessionEvents = this.cache.get(event.sessionId) ?? [];
    sessionEvents.push({ ...event });
    this.cache.set(event.sessionId, sessionEvents);
  }

  /**
   * Retrieves all feedback events for a session.
   */
  public async getSessionFeedback(sessionId: string): Promise<FeedbackEvent[]> {
    const cached = this.cache.get(sessionId);
    if (cached !== undefined) {
      return cached.map((event) => ({ ...event }));
    }

    const sessionFilePath = this.getSessionFilePath(sessionId);
    if (!(await fileExists(sessionFilePath))) {
      return [];
    }

    const events = await this.readSessionEventsFromDisk(sessionFilePath);

    this.cache.set(sessionId, events);
    return events.map((event) => ({ ...event }));
  }

  private getSessionFilePath(sessionId: string): string {
    return join(this.feedbackDir, `${sessionId}.jsonl`);
  }

  private async readSessionEventsFromDisk(sessionFilePath: string): Promise<FeedbackEvent[]> {
    const fileContent = await readFile(sessionFilePath);
    return fileContent
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FeedbackEvent);
  }
}

export default FeedbackCollectorImpl;
