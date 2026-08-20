/**
 * Account Hub — Audit Log Repository
 *
 * Append-only. Sensitive fields MUST be redacted before calling `append`.
 */

import type Database from 'better-sqlite3';
import type { AuditLog } from '../../domain/types.js';
import { generateId, redactSensitive } from '../../domain/utils.js';

export class AuditLogRepository {
  constructor(private db: Database.Database) {}

  append(entry: Omit<AuditLog, 'id' | 'createdAt'>): AuditLog {
    const id = generateId();
    const now = new Date().toISOString();

    // Always redact sensitive data before storing
    const beforeJson = entry.beforeJson
      ? JSON.stringify(redactSensitive(JSON.parse(entry.beforeJson) as Record<string, unknown>))
      : null;
    const afterJson = entry.afterJson
      ? JSON.stringify(redactSensitive(JSON.parse(entry.afterJson) as Record<string, unknown>))
      : null;

    this.db
      .prepare(`
        INSERT INTO audit_logs
          (id, actor, action, entity_type, entity_id, before_json, after_json, source, created_at)
        VALUES
          (@id, @actor, @action, @entityType, @entityId, @beforeJson, @afterJson, @source, @now)
      `)
      .run({
        id,
        actor:      entry.actor ?? null,
        action:     entry.action,
        entityType: entry.entityType,
        entityId:   entry.entityId ?? null,
        beforeJson,
        afterJson,
        source:     entry.source ?? null,
        now,
      });

    return { id, createdAt: now, ...entry, beforeJson, afterJson };
  }

  listByEntity(entityType: string, entityId: string, limit = 50): AuditLog[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM audit_logs
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(entityType, entityId, limit) as Record<string, unknown>[]
    ).map((r) => ({
      id:         r.id as string,
      actor:      r.actor as string | null,
      action:     r.action as string,
      entityType: r.entity_type as string,
      entityId:   r.entity_id as string | null,
      beforeJson: r.before_json as string | null,
      afterJson:  r.after_json as string | null,
      source:     r.source as string | null,
      createdAt:  r.created_at as string,
    }));
  }
}
