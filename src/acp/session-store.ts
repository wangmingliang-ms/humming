/**
 * Persist user→sessionId mappings to disk so sessions can be resumed
 * after lark-acp restarts.
 */

import fs from "node:fs";
import path from "node:path";

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

export class SessionStore {
  private filePath: string;
  private data: Record<string, SessionRecord> = {};

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "sessions.json");
    this.load();
  }

  get(userId: string): SessionRecord | undefined {
    return this.data[userId];
  }

  set(userId: string, record: SessionRecord): void {
    this.data[userId] = record;
    this.save();
  }

  remove(userId: string): void {
    delete this.data[userId];
    this.save();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.data = JSON.parse(raw) as Record<string, SessionRecord>;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }
}
