import { api } from './api';
import type { ClientState, ConflictInfo, EntityType, OutboxOp } from '../types';

export const entityKey = (type: EntityType, id: string) => `${type}:${id}`;

export const isPlainObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function unionArrays(a: string[], b: string[]): string[] {
  const result = [...a];
  for (const item of b) if (!result.includes(item)) result.push(item);
  return result;
}

export function getPath(obj: Record<string, any>, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

export function setPath(obj: Record<string, any>, path: string, value: unknown) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!isPlainObject(current[keys[i]])) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

/** 去掉实体上的 conflict 字段，得到纯净快照 */
export function snapshot<T extends { conflict?: ConflictInfo }>(entity: T): Record<string, any> {
  const { conflict: _conflict, ...rest } = entity;
  return rest;
}

export function enqueueOp(
  state: ClientState,
  entityType: EntityType,
  entityId: string,
  kind: 'upsert' | 'create',
  baseVersion: number | null,
  base: Record<string, any>,
  changes: Record<string, any>,
  actor: string
): OutboxOp {
  const op: OutboxOp = {
    id: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    key: `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    entityType,
    entityId,
    kind,
    baseVersion,
    base: JSON.parse(JSON.stringify(base)),
    changes: JSON.parse(JSON.stringify(changes)),
    actor,
    clientTs: Date.now(),
    status: 'pending',
    attempts: 0
  };
  state.outbox.push(op);
  return op;
}

function findEntity(state: ClientState, type: EntityType, id: string): Record<string, any> | undefined {
  const list = type === 'exhibit' ? state.exhibits : state.discrepancies;
  return list.find((item) => item.id === id) as Record<string, any> | undefined;
}

/**
 * 三方字段合并：base 是双方共同基线，local 是本机（保管员），server 是服务器（借展方先同步）。
 * - 只有一边改过的字段，自动采用改过的一边
 * - 两边都改：字符串数组合并（如签字）；嵌套对象按字段继续合并；其余标为冲突，保留两版
 */
export function merge3(
  base: Record<string, any>,
  local: Record<string, any>,
  server: Record<string, any>,
  prefix = ''
): { merged: Record<string, any>; conflicts: string[] } {
  const merged: Record<string, any> = {};
  const conflicts: string[] = [];
  const fields = new Set([...Object.keys(base ?? {}), ...Object.keys(local ?? {}), ...Object.keys(server ?? {})]);

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field}` : field;
    const b = base?.[field];
    const l = local?.[field];
    const s = server?.[field];
    const localChanged = !deepEqual(l, b);
    const serverChanged = !deepEqual(s, b);

    if (localChanged && serverChanged) {
      if (deepEqual(l, s)) {
        merged[field] = l;
      } else if (Array.isArray(l) && Array.isArray(s) && l.every((x) => typeof x === 'string') && s.every((x) => typeof x === 'string')) {
        merged[field] = unionArrays(l as string[], s as string[]);
      } else if (isPlainObject(l) && isPlainObject(s) && isPlainObject(b)) {
        const sub = merge3(b, l, s, path);
        merged[field] = sub.merged;
        conflicts.push(...sub.conflicts);
      } else {
        conflicts.push(path);
        merged[field] = l;
      }
    } else if (localChanged) {
      merged[field] = l;
    } else if (serverChanged) {
      merged[field] = s;
    } else {
      merged[field] = b;
    }
  }

  return { merged, conflicts };
}

/** 计算 target 相对 base 发生变化的字段（嵌套对象只返回变化的叶子） */
export function diffFields(base: Record<string, any>, target: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const fields = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const field of fields) {
    if (isPlainObject(base[field]) && isPlainObject(target[field])) {
      const sub = diffFields(base[field], target[field]);
      if (Object.keys(sub).length) out[field] = sub;
    } else if (!deepEqual(base[field], target[field])) {
      out[field] = target[field];
    }
  }
  return out;
}

function handleConflict(state: ClientState, op: OutboxOp, serverEntity: Record<string, any>, serverVersion: number) {
  const entity = findEntity(state, op.entityType, op.entityId);
  if (!entity) {
    op.status = 'failed';
    op.error = '本地缺少对应实体';
    return;
  }
  const localSnapshot = snapshot(entity);
  const { merged, conflicts } = merge3(op.base ?? {}, localSnapshot, serverEntity);
  Object.assign(entity, merged);
  state.versions[entityKey(op.entityType, op.entityId)] = serverVersion;

  if (conflicts.length) {
    entity.conflict = {
      opId: op.id,
      detectedAt: Date.now(),
      baseVersion: op.baseVersion ?? 0,
      serverVersion,
      local: localSnapshot,
      server: serverEntity,
      fields: conflicts
    };
    op.status = 'conflict';
    // 同一实体上排队更晚的操作已包含在本机快照里，冲突解决后由解决操作统一提交
    for (const later of state.outbox) {
      if (
        later !== op &&
        later.entityType === op.entityType &&
        later.entityId === op.entityId &&
        (later.status === 'pending' || later.status === 'failed')
      ) {
        later.status = 'superseded';
      }
    }
  } else {
    // 自动合并成功：若合并结果里有服务器尚未收到的本机改动，补一条基于服务器版本的操作提交，
    // 不能直接标记 acked，否则本机这一边的改动会在服务器上丢失
    const changes = diffFields(serverEntity, merged);
    if (Object.keys(changes).length) {
      op.status = 'superseded';
      enqueueOp(state, op.entityType, op.entityId, 'upsert', serverVersion, serverEntity, changes, op.actor);
    } else {
      op.status = 'acked';
    }
  }
}

/**
 * 按队列顺序处理 outbox。中途网络失败立即停止，已失败的操作保留状态，
 * 下次调用从失败处继续；幂等 key 保证服务器不会重复入库。
 */
export async function processOutbox(state: ClientState): Promise<{ failed: boolean; processed: number }> {
  let processed = 0;
  for (const op of state.outbox) {
    if (op.status !== 'pending' && op.status !== 'failed') continue;
    op.status = 'inflight';
    op.attempts += 1;
    op.error = undefined;
    try {
      const res = await api.post('/ops', { op: JSON.parse(JSON.stringify(op)) });
      const body = res.data as { status: 'applied' | 'created' | 'duplicate' | 'conflict'; version: number; entity: Record<string, any> };

      if (body.status === 'conflict') {
        handleConflict(state, op, body.entity, body.version);
      } else {
        op.status = 'acked';
        op.resultVersion = body.version;
        state.versions[entityKey(op.entityType, op.entityId)] = body.version;
        processed += 1;
      }
    } catch (error: any) {
      op.status = 'failed';
      op.error = error?.message ?? '网络错误';
      return { failed: true, processed };
    }
  }
  return { failed: false, processed };
}

function stripVersion<T extends Record<string, any>>(entity: T): Record<string, any> {
  const { version: _version, ...rest } = entity;
  return rest;
}

/** 同步后拉取服务器状态：补齐本机没有的实体（如对方新建的差异项），快进无未决变更的实体 */
export async function reconcile(state: ClientState) {
  const res = await api.get('/state');
  const serverState = res.data as { exhibits: Array<Record<string, any>>; discrepancies: Array<Record<string, any>> };

  for (const serverEntity of serverState.exhibits) {
    pullOne(state, 'exhibit', serverEntity);
  }
  for (const serverEntity of serverState.discrepancies) {
    pullOne(state, 'discrepancy', serverEntity);
  }
}

function pullOne(state: ClientState, type: EntityType, serverEntity: Record<string, any>) {
  const key = entityKey(type, serverEntity.id);
  const list = type === 'exhibit' ? state.exhibits : state.discrepancies;
  const local = list.find((item) => item.id === serverEntity.id) as Record<string, any> | undefined;
  const serverSnapshot = stripVersion(serverEntity);

  if (!local) {
    list.push({ ...serverSnapshot } as never);
    state.versions[key] = serverEntity.version;
    return;
  }
  if (local.conflict) return;
  const busy = state.outbox.some(
    (op) => op.entityType === type && op.entityId === serverEntity.id && ['pending', 'failed', 'inflight', 'conflict'].includes(op.status)
  );
  if (!busy && (state.versions[key] ?? 0) < serverEntity.version) {
    Object.assign(local, serverSnapshot);
    state.versions[key] = serverEntity.version;
  }
}

/**
 * 冲突解决：choices 中每个冲突字段选 'local'（保管员平板）或 'server'（借展方版本）。
 * 生成一条基于服务器版本的解决操作；若选择结果与服务器一致，则直接本机接受服务器版本。
 */
export function resolveConflict(
  state: ClientState,
  type: EntityType,
  id: string,
  choices: Record<string, 'local' | 'server'>
): { enqueued: boolean } {
  const entity = findEntity(state, type, id);
  const conflict = entity?.conflict;
  if (!entity || !conflict) return { enqueued: false };

  // 从当前实体状态出发（非冲突字段已在三方合并时自动合并），
  // 仅对冲突字段按用户选择覆盖为本机或服务器版本
  const merged = snapshot(entity);
  for (const field of conflict.fields) {
    const choice = choices[field] ?? 'local';
    setPath(merged, field, choice === 'server' ? getPath(conflict.server, field) : getPath(conflict.local, field));
  }

  // 被取代的操作（冲突操作本身 + 同实体上被跳过的操作）标记为 superseded
  for (const op of state.outbox) {
    if (op.entityType === type && op.entityId === id && (op.status === 'conflict' || op.status === 'superseded')) {
      op.status = 'superseded';
    }
  }

  entity.conflict = undefined;
  state.versions[entityKey(type, id)] = conflict.serverVersion;

  if (deepEqual(merged, conflict.server)) {
    Object.assign(entity, conflict.server);
    return { enqueued: false };
  }

  const changes = diffFields(conflict.server, merged);
  const op: OutboxOp = {
    id: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    key: `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    entityType: type,
    entityId: id,
    kind: 'upsert',
    baseVersion: conflict.serverVersion,
    base: JSON.parse(JSON.stringify(conflict.server)),
    changes,
    actor: '冲突解决',
    clientTs: Date.now(),
    status: 'pending',
    attempts: 0
  };
  state.outbox.push(op);
  Object.assign(entity, merged);
  return { enqueued: true };
}
