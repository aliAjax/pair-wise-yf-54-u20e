import type { Discrepancy, Exhibit, OutboxOp } from '../types';
import { seedDiscrepancies, seedExhibits } from './seed';

/**
 * 浏览器内“服务器”：
 * - 每个实体带版本号，版本不一致拒绝应用（409 conflict）
 * - 持久化幂等 key，已收下的记录重试时返回 duplicate，绝不重复入库
 * - 可模拟断网（setOffline）与响应丢失（armFailure：应用后再抛错）
 * 生产环境这些逻辑在服务端，这里用 localStorage 模拟服务器存储。
 */

export interface ServerExhibit extends Exhibit {
  version: number;
}
export interface ServerDiscrepancy extends Discrepancy {
  version: number;
}

interface IdempotencyRecord {
  entityType: 'exhibit' | 'discrepancy';
  entityId: string;
  version: number;
}

interface ServerState {
  exhibits: ServerExhibit[];
  discrepancies: ServerDiscrepancy[];
  keys: Record<string, IdempotencyRecord>;
}

const SERVER_KEY = 'yf54-server-state';

let state: ServerState | null = null;
let offline = false;
let failNext = false;

function load(): ServerState {
  if (state) return state;
  const raw = localStorage.getItem(SERVER_KEY);
  if (raw) {
    state = JSON.parse(raw) as ServerState;
    return state;
  }
  state = {
    exhibits: seedExhibits().map((item) => ({ ...item, version: 1 })),
    discrepancies: seedDiscrepancies().map((item) => ({ ...item, version: 1 })),
    keys: {}
  };
  save();
  return state;
}

function save() {
  if (state) localStorage.setItem(SERVER_KEY, JSON.stringify(state));
}

export function setOffline(value: boolean) {
  offline = value;
}

/** 下一次请求在服务器正常应用后抛出网络错误（模拟“服务器已收下但响应丢失”） */
export function armFailure() {
  failNext = true;
}

export function resetServer() {
  state = {
    exhibits: seedExhibits().map((item) => ({ ...item, version: 1 })),
    discrepancies: seedDiscrepancies().map((item) => ({ ...item, version: 1 })),
    keys: {}
  };
  save();
}

function deepApply<T extends Record<string, any>>(target: T, changes: Record<string, any>): T {
  const out: Record<string, any> = { ...target };
  for (const [key, value] of Object.entries(changes)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object' && target[key] !== null) {
      out[key] = { ...target[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function applyOp(s: ServerState, op: OutboxOp) {
  // 幂等：同一条记录（同 key）服务器只入库一次
  const seen = s.keys[op.key];
  if (seen) {
    const entity =
      seen.entityType === 'exhibit'
        ? s.exhibits.find((item) => item.id === seen.entityId)
        : s.discrepancies.find((item) => item.id === seen.entityId);
    return { status: 'duplicate' as const, version: seen.version, entity };
  }

  const collection = op.entityType === 'exhibit' ? s.exhibits : s.discrepancies;
  const index = collection.findIndex((item) => item.id === op.entityId);

  if (op.kind === 'create' || index === -1) {
    const entity = { ...op.changes, version: 1 };
    if (index === -1) collection.push(entity as never);
    else collection[index] = entity as never;
    s.keys[op.key] = { entityType: op.entityType, entityId: op.entityId, version: 1 };
    return { status: 'created' as const, version: 1, entity };
  }

  const current = collection[index];
  if (op.baseVersion !== current.version) {
    // 客户端基线过期：不应用，返回服务器当前版本，由客户端做三方合并
    return { status: 'conflict' as const, version: current.version, entity: current };
  }

  const updated = deepApply(current, op.changes);
  updated.version = current.version + 1;
  collection[index] = updated as never;
  s.keys[op.key] = { entityType: op.entityType, entityId: op.entityId, version: updated.version };
  return { status: 'applied' as const, version: updated.version, entity: updated };
}

export async function serverRequest(method: string, url: string, body?: { op?: OutboxOp }): Promise<any> {
  await new Promise((resolve) => setTimeout(resolve, 220 + Math.random() * 380));
  if (offline) throw new Error('OFFLINE');

  const s = load();
  let result: any;
  if (method === 'GET' && url === '/state') {
    result = { exhibits: s.exhibits, discrepancies: s.discrepancies };
  } else if (method === 'POST' && url === '/ops' && body?.op) {
    result = applyOp(s, body.op);
  } else {
    result = { status: 'unknown' };
  }

  save();

  if (failNext) {
    failNext = false;
    throw new Error('NETWORK_LOST_AFTER_APPLY');
  }
  return result;
}
