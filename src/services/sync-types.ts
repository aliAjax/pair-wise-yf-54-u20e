// 同步层共享类型：展品/差异项文档、排队操作、冲突记录

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type Severity = 'minor' | 'major';
export type DocKind = 'exhibit' | 'discrepancy';

export interface ExhibitDoc {
  kind: 'exhibit';
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  envTemperature: number;
  envHumidity: number;
  envLight: number;
}

export interface DiscrepancyDoc {
  kind: 'discrepancy';
  id: string;
  exhibitId: string;
  title: string;
  severity: Severity;
  resolved: boolean;
}

export type Doc = ExhibitDoc | DiscrepancyDoc;
// 可参与同步合并的字段值
export type FieldValue = string | number | boolean | string[];

// 数组取并集的字段（双方各自追加签字，互不覆盖）
export const UNION_ARRAY_FIELDS = new Set(['signed']);

export function editableFields(kind: DocKind): string[] {
  return kind === 'exhibit'
    ? ['code', 'name', 'lender', 'hall', 'stage', 'status', 'signed', 'envTemperature', 'envHumidity', 'envLight']
    : ['title', 'severity', 'resolved'];
}

export function fget(doc: Doc, field: string): FieldValue {
  return (doc as unknown as Record<string, FieldValue>)[field];
}

export function fset(doc: Doc, field: string, value: FieldValue): void {
  (doc as unknown as Record<string, FieldValue>)[field] = value;
}

export function conflictId(clientId: string, targetId: string, field: string): string {
  return `${clientId}::${targetId}::${field}`;
}

export interface ConflictRecord {
  /** clientId::targetId::field，同一展品同一字段的冲突只保留一条 */
  id: string;
  clientId: string;
  targetId: string;
  field: string;
  /** 双方分叉前的共同版本（最后一次同步的服务器值） */
  base: FieldValue | null;
  /** 本方离线期间改成的值 */
  localValue: FieldValue;
  /** 对方先同步、服务器当前的值 */
  remoteValue: FieldValue;
  since: number;
}

export type OpKind = 'create' | 'patch' | 'resolve-conflict';

export interface OutgoingOp {
  /** 幂等键：服务器据此去重，重试绝不重复入库 */
  opId: string;
  clientId: string;
  targetId: string;
  kind: OpKind;
  createdAt: number;
  /** create：完整的新文档 */
  doc?: Doc;
  /** patch：变更字段值 + 每个字段分叉前的 base（三方合并依据） */
  changes?: Record<string, FieldValue>;
  bases?: Record<string, FieldValue | null>;
  /** resolve-conflict：选定的最终值 */
  field?: string;
  resolution?: FieldValue;
}

export interface SubmitResult {
  opId: string;
  /** true 表示这条 opId 服务器之前已收录，本次只做确认，没有重复入库 */
  duplicate: boolean;
  /** 本次提交后该展品仍挂起的冲突 */
  conflicts: ConflictRecord[];
  appliedCount: number;
}

export interface PullSnapshot {
  at: number;
  docs: Doc[];
  /** 展品的服务器权威顺序 */
  order: string[];
  /** 本方设备挂起的全部冲突 */
  conflicts: ConflictRecord[];
  appliedCount: number;
}
