// 纯函数：字段级三方合并。服务器与客户端共用，保证两边规则一致。
//
// 规则（逐字段、只处理 patch 里本方动过的字段）：
// 1. 只有一方改动            -> 采用改动方的值（签字类数组取并集，追加不覆盖）
// 2. 双方都改但改成相同值     -> 收敛为该值
// 3. 双方都改且结果不同       -> 字段不落地，产出冲突记录，保留两版
// 4. 任何一端把值改回 base    -> 视为该端未改动（回退不阻塞对方）

import { fget, fset, UNION_ARRAY_FIELDS, type ConflictRecord, type Doc, type FieldValue, type OutgoingOp } from './sync-types';

export type MergeOutcome =
  | { status: 'applied'; doc: Doc; conflicts: ConflictRecord[] }
  | { status: 'conflict'; doc: Doc; conflicts: ConflictRecord[] }
  | { status: 'missing' };

function equal(a: FieldValue | null, b: FieldValue | null): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function union(a: FieldValue, b: FieldValue): FieldValue {
  const merged = [...(Array.isArray(a) ? a : [])];
  for (const v of Array.isArray(b) ? b : []) if (!merged.includes(v)) merged.push(v);
  return merged;
}

export function mergePatch(
  doc: Doc | undefined,
  baseDoc: Doc,
  op: OutgoingOp,
  now: number,
  cid: (op: OutgoingOp, field: string) => string,
): MergeOutcome {
  if (!doc) return { status: 'missing' };
  const changes = op.changes ?? {};
  const bases = op.bases ?? {};
  const next: Doc = structuredClone(doc);
  const conflicts: ConflictRecord[] = [];

  for (const field of Object.keys(changes)) {
    const localValue = changes[field];
    const remoteValue = fget(doc, field);
    const base = field in bases ? bases[field] ?? null : fget(baseDoc, field);
    const localChanged = !equal(localValue, base);
    const remoteChanged = !equal(remoteValue, base);

    // 数组并集字段（签字）：各自追加的签名都保留，仅当双方都改出非并集关系时才理论上冲突，
    // 并集天然可收敛，因此直接合并。
    if (UNION_ARRAY_FIELDS.has(field)) {
      fset(next, field, union(localValue, remoteValue));
      continue;
    }

    if (!localChanged) {
      // 本方回退到了共同版本，保留服务器现状
      continue;
    }
    if (!remoteChanged || equal(localValue, remoteValue)) {
      fset(next, field, localValue);
      continue;
    }
    // 双方都改且不一致：服务器字段不动，挂出冲突，两版都保留
    conflicts.push({
      id: cid(op, field),
      clientId: op.clientId,
      targetId: op.targetId,
      field,
      base,
      localValue: structuredClone(localValue),
      remoteValue: structuredClone(remoteValue),
      since: now,
    });
  }

  return { status: conflicts.length ? 'conflict' : 'applied', doc: next, conflicts };
}
