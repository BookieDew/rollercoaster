import db from '../connection';
import { v4 as uuidv4 } from 'uuid';

export interface AuditLogEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  payload: Record<string, unknown> | null;
  timestamp: string;
  createdAt: string;
}

export interface CreateAuditLogInput {
  entityType: string;
  entityId: string;
  action: string;
  payload?: Record<string, unknown>;
}

const TABLE = 'audit_logs';

export async function append(input: CreateAuditLogInput): Promise<AuditLogEntry> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const record = {
    id,
    entity_type: input.entityType,
    entity_id: input.entityId,
    action: input.action,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    timestamp: now,
    created_at: now,
  };

  await db(TABLE).insert(record);
  return mapToEntity(record);
}

export async function findByEntity(entityType: string, entityId: string): Promise<AuditLogEntry[]> {
  const records = await db(TABLE)
    .where({ entity_type: entityType, entity_id: entityId })
    .orderBy('timestamp', 'desc');
  return records.map(mapToEntity);
}

export async function findByEntityType(entityType: string, limit = 100): Promise<AuditLogEntry[]> {
  const records = await db(TABLE)
    .where({ entity_type: entityType })
    .orderBy('timestamp', 'desc')
    .limit(limit);
  return records.map(mapToEntity);
}

export async function findByDateRange(startDate: string, endDate: string): Promise<AuditLogEntry[]> {
  const records = await db(TABLE)
    .where('timestamp', '>=', startDate)
    .where('timestamp', '<=', endDate)
    .orderBy('timestamp', 'desc');
  return records.map(mapToEntity);
}

function mapToEntity(record: Record<string, unknown>): AuditLogEntry {
  const payload = record.payload
    ? (typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload)
    : null;

  return {
    id: record.id as string,
    entityType: record.entity_type as string,
    entityId: record.entity_id as string,
    action: record.action as string,
    payload,
    timestamp: record.timestamp as string,
    createdAt: record.created_at as string,
  };
}

export const auditLogRepository = {
  append,
  findByEntity,
  findByEntityType,
  findByDateRange,
};
