export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';

export interface Environment {
  temperature: number;
  humidity: number;
  light: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  environment: Environment;
  conflict?: ConflictInfo;
}

export type Severity = 'minor' | 'major';

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: Severity;
  resolved: boolean;
  conflict?: ConflictInfo;
}

/** 三方合并后保留的两版内容 */
export interface ConflictInfo {
  opId: string;
  detectedAt: number;
  baseVersion: number;
  serverVersion: number;
  /** 本机（保管员平板）版本快照 */
  local: Record<string, any>;
  /** 服务器（借展方平板先同步后）版本快照 */
  server: Record<string, any>;
  /** 两边都改过且不一致的字段路径，如 status、environment.temperature */
  fields: string[];
}

export type OpStatus = 'pending' | 'inflight' | 'acked' | 'failed' | 'conflict' | 'superseded';
export type EntityType = 'exhibit' | 'discrepancy';

/** 断网期间的一条变更操作，按实体逐条排队 */
export interface OutboxOp {
  id: string;
  /** 客户端生成的幂等 key，重试不变，服务器据此去重 */
  key: string;
  entityType: EntityType;
  entityId: string;
  kind: 'upsert' | 'create';
  /** 生成这条操作时依据的服务器版本；create 为 null */
  baseVersion: number | null;
  /** 基线快照（三方合并用） */
  base: Record<string, any>;
  /** 本操作改动的字段（局部） */
  changes: Record<string, any>;
  actor: string;
  clientTs: number;
  status: OpStatus;
  attempts: number;
  error?: string;
  resultVersion?: number;
}

export interface ClientState {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  outbox: OutboxOp[];
  /** 每个实体最近一次已知的服务器版本，key 为 `exhibit:<id>` / `discrepancy:<id>` */
  versions: Record<string, number>;
  /** 手动模拟断网（展柜区常断网） */
  forcedOffline: boolean;
}
