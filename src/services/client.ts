import type { ClientState, EntityType } from '../types';
import { seedDiscrepancies, seedExhibits } from './seed';
import { enqueueOp, entityKey, isPlainObject, snapshot } from './syncEngine';

export const MAIN_CLIENT_KEY = 'yf54-exhibition-state';
export const BORROWER_CLIENT_KEY = 'yf54-borrower-state';

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function initialState(): ClientState {
  const exhibits = seedExhibits();
  const discrepancies = seedDiscrepancies();
  const versions: Record<string, number> = {};
  exhibits.forEach((item) => {
    versions[entityKey('exhibit', item.id)] = 1;
  });
  discrepancies.forEach((item) => {
    versions[entityKey('discrepancy', item.id)] = 1;
  });
  return { exhibits, discrepancies, outbox: [], versions, forcedOffline: false };
}

export function loadClientState(storageKey: string): ClientState {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const parsed = JSON.parse(raw) as ClientState;
    if (Array.isArray(parsed.outbox) && parsed.exhibits && parsed.discrepancies) {
      return parsed;
    }
  }
  return initialState();
}

export function saveClientState(storageKey: string, state: ClientState) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function deepApplyLocal(target: Record<string, any>, changes: Record<string, any>) {
  for (const [key, value] of Object.entries(changes)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      target[key] = { ...target[key], ...value };
    } else {
      target[key] = value;
    }
  }
}

/** 本机修改实体：先乐观更新界面，再按实体排队一条 upsert 操作 */
export function applyEntityChange(
  state: ClientState,
  entityType: EntityType,
  entityId: string,
  changes: Record<string, any>,
  actor: string
) {
  const list = entityType === 'exhibit' ? state.exhibits : state.discrepancies;
  const entity = list.find((item) => item.id === entityId) as Record<string, any> | undefined;
  if (!entity) return;
  const base = snapshot(entity);
  deepApplyLocal(entity, changes);
  enqueueOp(state, entityType, entityId, 'upsert', state.versions[entityKey(entityType, entityId)] ?? 1, base, changes, actor);
}

/** 新建实体（登记展品、新增差异项）：排队一条 create 操作 */
export function applyEntityCreate(state: ClientState, entityType: EntityType, entity: Record<string, any>, actor: string) {
  const list = entityType === 'exhibit' ? state.exhibits : state.discrepancies;
  list.unshift(entity as never);
  enqueueOp(state, entityType, entity.id, 'create', null, {}, entity, actor);
}
