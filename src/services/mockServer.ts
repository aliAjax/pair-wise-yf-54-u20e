// 模拟跨端服务器：独立 localStorage 命名空间，所有平板共享同一份权威数据。
// 关键保证：
//  - opId 幂等：同一条操作重复提交只确认、不重复入库
//  - 字段级三方合并：本端改动与服务器现状按字段合并，冲突返回双版
//  - chaos 模式：随机制造"服务器已落库但响应丢失"，用于验证重试不重复入库

import { mergePatch } from './merge';
import {
  conflictId,
  type ConflictRecord,
  type Doc,
  type ExhibitDoc,
  type OutgoingOp,
  type PullSnapshot,
  type SubmitResult,
} from './sync-types';

const SERVER_KEY = 'yf54-server-v1';
const SEED_FLAG = 'yf54-server-seeded';

interface ServerState {
  docs: Record<string, Doc>;
  order: string[];
  /** 已收录的操作幂等键 -> 提交当时的结果 */
  seenOps: Record<string, { result: SubmitResult }>;
  /** 按 clientId 挂起的冲突 */
  conflicts: ConflictRecord[];
  appliedCount: number;
}

/** 故障注入开关：true 时每条新操作"落库成功、响应失败"，重试即为重复提交 */
let chaos = false;
export function setChaos(v: boolean) { chaos = v; }

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seed(): ServerState {
  const docs: Record<string, Doc> = {};
  const exhibits: ExhibitDoc[] = Array.from({ length: 24 }, (_, index) => ({
    kind: 'exhibit',
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    envTemperature: 20 + (index % 3),
    envHumidity: 48 + (index % 8),
    envLight: 120 + index * 3,
  }));
  for (const e of exhibits) docs[e.id] = e;
  const discrepancies: Doc[] = [
    { kind: 'discrepancy', id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { kind: 'discrepancy', id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false },
  ];
  for (const d of discrepancies) docs[d.id] = d;
  return {
    docs,
    order: exhibits.map((e) => e.id),
    seenOps: {},
    conflicts: [],
    appliedCount: 0,
  };
}

function load(): ServerState {
  if (!localStorage.getItem(SEED_FLAG)) {
    const fresh = seed();
    localStorage.setItem(SEED_FLAG, '1');
    localStorage.setItem(SERVER_KEY, JSON.stringify(fresh));
    return fresh;
  }
  const raw = localStorage.getItem(SERVER_KEY);
  return raw ? (JSON.parse(raw) as ServerState) : seed();
}

let state: ServerState | null = null;
function store(): ServerState {
  if (!state) state = load();
  return state;
}
function persist() {
  localStorage.setItem(SERVER_KEY, JSON.stringify(store()));
}

function clientConflicts(clientId: string): ConflictRecord[] {
  return store().conflicts.filter((c) => c.clientId === clientId);
}

function upsertConflicts(records: ConflictRecord[]) {
  const s = store();
  for (const c of records) {
    const i = s.conflicts.findIndex((x) => x.id === c.id);
    if (i >= 0) s.conflicts[i] = c;
    else s.conflicts.push(c);
  }
}

export class SyncTransportError extends Error {
  /** applied=true 表示服务器很可能已落库（响应丢失），必须靠 opId 幂等重试 */
  constructor(message: string, readonly applied: boolean) {
    super(message);
    this.name = 'SyncTransportError';
  }
}

export const mockServer = {
  async submit(op: OutgoingOp): Promise<SubmitResult> {
    await delay(120 + Math.random() * 180);
    const s = store();

    // 幂等：重试的操作直接返回当时结果，绝不二次入库
    const seen = s.seenOps[op.opId];
    if (seen) return { ...seen.result, duplicate: true };

    let newConflicts: ConflictRecord[] = [];
    let appliedSomething = false;

    if (op.kind === 'create') {
      if (op.doc && !s.docs[op.targetId]) {
        s.docs[op.targetId] = structuredClone(op.doc);
        s.order.unshift(op.targetId);
        appliedSomething = true;
      }
    } else if (op.kind === 'resolve-conflict') {
      const id = conflictId(op.clientId, op.targetId, op.field ?? '');
      const idx = s.conflicts.findIndex((c) => c.id === id);
      if (idx >= 0 && op.resolution !== undefined) {
        s.conflicts.splice(idx, 1);
        const doc = s.docs[op.targetId];
        if (doc) {
          (doc as unknown as Record<string, unknown>)[op.field ?? ''] = structuredClone(op.resolution);
          appliedSomething = true;
        }
      }
    } else {
      const doc = s.docs[op.targetId];
      if (doc) {
        // 以 op 携带的 per-field base 作为分叉共同版本
        const baseDoc = structuredClone(doc);
        const bases = op.bases ?? {};
        for (const field of Object.keys(bases)) {
          if (bases[field] !== null) {
            (baseDoc as unknown as Record<string, unknown>)[field] = structuredClone(bases[field]);
          }
        }
        const outcome = mergePatch(doc, baseDoc, op, Date.now(), (o, field) =>
          conflictId(o.clientId, o.targetId, field),
        );
        if (outcome.status !== 'missing') {
          s.docs[op.targetId] = outcome.doc;
          newConflicts = outcome.conflicts;
          upsertConflicts(newConflicts);
          appliedSomething = true;
        }
      }
    }

    if (appliedSomething) s.appliedCount += 1;
    const result: SubmitResult = {
      opId: op.opId,
      duplicate: false,
      conflicts: clientConflicts(op.clientId),
      appliedCount: s.appliedCount,
    };
    // 先落库、再登记幂等键
    s.seenOps[op.opId] = { result };
    persist();

    if (chaos) throw new SyncTransportError('网络中断：服务器可能已收录本条操作', true);
    return result;
  },

  async pull(clientId: string): Promise<PullSnapshot> {
    await delay(100 + Math.random() * 120);
    const s = store();
    return {
      at: Date.now(),
      docs: structuredClone(Object.values(s.docs)),
      order: [...s.order],
      conflicts: structuredResolve(clientConflicts(clientId)),
      appliedCount: s.appliedCount,
    };
  },
};

function structuredResolve(list: ConflictRecord[]): ConflictRecord[] {
  return structuredClone(list);
}
