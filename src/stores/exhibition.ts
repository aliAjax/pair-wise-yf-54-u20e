import { defineStore } from 'pinia';
import { currentDeviceId } from '../services/device';
import { storageKey } from '../services/device';
import { mockServer, SyncTransportError } from '../services/mockServer';
import {
  editableFields,
  fget,
  fset,
  type ConflictRecord,
  type DiscrepancyDoc,
  type Doc,
  type ExhibitDoc,
  type FieldValue,
  type OutgoingOp,
  type PullSnapshot,
} from '../services/sync-types';

export type { ExhibitDoc, DiscrepancyDoc, ConflictRecord, FieldValue, Doc };

interface LocalState {
  docs: Record<string, Doc>;
  order: string[];
  /** 断网期间按展品逐条排队的待同步操作（同一展品的字段修改合并进同一条） */
  outbox: OutgoingOp[];
  conflicts: ConflictRecord[];
  pulledAt: number;
  appliedCount: number;
  log: LogEntry[];
}

interface LogEntry { at: number; level: 'info' | 'warn' | 'error'; text: string; }

function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function load(): LocalState {
  const raw = localStorage.getItem(storageKey(currentDeviceId.value));
  if (raw) return JSON.parse(raw) as LocalState;
  return { docs: {}, order: [], outbox: [], conflicts: [], pulledAt: 0, appliedCount: 0, log: [] };
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => ({
    ...load(),
    syncing: false,
    lastError: '' as string,
  }),
  getters: {
    exhibitDocs(state): ExhibitDoc[] {
      return state.order
        .map((id) => state.docs[id])
        .filter((d): d is ExhibitDoc => !!d && d.kind === 'exhibit');
    },
    discrepancyDocs(state): DiscrepancyDoc[] {
      return Object.values(state.docs).filter((d): d is DiscrepancyDoc => d.kind === 'discrepancy');
    },
    unresolvedCount(state): number {
      return this.discrepancyDocs.filter((d: DiscrepancyDoc) => !d.resolved).length;
    },
    stageCounts(): { arrival: number; install: number; return: number } {
      const count = (s: ExhibitDoc['stage']) => this.exhibitDocs.filter((e: ExhibitDoc) => e.stage === s).length;
      return { arrival: count('arrival'), install: count('install'), return: count('return') };
    },
    pendingCount(state): number {
      return state.outbox.length;
    },
    conflictCount(state): number {
      return state.conflicts.length;
    },
    /** 队列按展品分组：逐条排队、逐条重试的可视化依据 */
    queueGroups(state): { op: OutgoingOp; doc?: Doc; fields: string[] }[] {
      return state.outbox.map((op) => ({
        op,
        doc: state.docs[op.targetId],
        fields: op.kind === 'create'
          ? ['新建登记']
          : op.kind === 'resolve-conflict'
            ? [`解决冲突：${op.field}`]
            : Object.keys(op.changes ?? {}),
      }));
    },
    targetTitle: (state) => (id: string): string => {
      const d = state.docs[id];
      if (!d) return id;
      return d.kind === 'exhibit' ? `${d.code} · ${d.name}` : d.title;
    },
    hasConflict: (state) => (targetId: string): boolean =>
      state.conflicts.some((c) => c.targetId === targetId),
    conflictsOf: (state) => (targetId: string): ConflictRecord[] =>
      state.conflicts.filter((c) => c.targetId === targetId),
  },
  actions: {
    persist() {
      localStorage.setItem(storageKey(currentDeviceId.value), JSON.stringify({
        docs: this.docs, order: this.order, outbox: this.outbox,
        conflicts: this.conflicts, pulledAt: this.pulledAt, appliedCount: this.appliedCount, log: this.log,
      } satisfies Omit<LocalState, never>));
    },
    addLog(level: LogEntry['level'], text: string) {
      this.log.unshift({ at: Date.now(), level, text });
      if (this.log.length > 30) this.log.length = 30;
    },

    // ---- 首次进入 / 拉取服务器版本 ----
    async bootstrap() {
      if (this.pulledAt) return;
      try {
        await this.pullAndReconcile(await mockServer.pull(currentDeviceId.value));
        this.addLog('info', `已接入服务器版本，共 ${Object.keys(this.docs).length} 条记录`);
      } catch {
        this.addLog('warn', '离线启动：本地暂无快照，恢复网络后同步');
      }
    },

    // ---- 本地修改：改前先抓 base，按展品并入队列 ----
    enqueueCreate(doc: Doc) {
      this.docs[doc.id] = structuredClone(doc);
      this.order.unshift(doc.id);
      this.outbox.push({
        opId: newId('op'), clientId: currentDeviceId.value, targetId: doc.id,
        kind: 'create', createdAt: Date.now(), doc: structuredClone(doc),
      });
      this.addLog('info', `已排队：新建 ${this.targetTitle(doc.id)}`);
      this.persist();
    },

    enqueuePatch(targetId: string, field: string, value: FieldValue) {
      const doc = this.docs[targetId];
      if (!doc) return;
      const pending = this.outbox.find((o) => o.targetId === targetId && o.kind === 'patch');
      // 新建尚未同步的展品，后续编辑直接并入 create 的文档
      const pendingCreate = this.outbox.find((o) => o.targetId === targetId && o.kind === 'create');

      if (pendingCreate?.doc) {
        fset(pendingCreate.doc, field, value);
      } else if (pending) {
        pending.changes = pending.changes ?? {};
        pending.bases = pending.bases ?? {};
        if (!(field in pending.bases)) pending.bases[field] = fget(doc, field);
        pending.changes[field] = value;
      } else {
        this.outbox.push({
          opId: newId('op'), clientId: currentDeviceId.value, targetId,
          kind: 'patch', createdAt: Date.now(),
          changes: { [field]: value }, bases: { [field]: fget(doc, field) },
        });
      }
      fset(doc, field, value);
      this.persist();
    },

    // 业务操作
    setCondition(id: string, status: ExhibitDoc['status']) {
      this.enqueuePatch(id, 'status', status);
    },
    setEnv(id: string, field: 'envTemperature' | 'envHumidity' | 'envLight', value: number) {
      if (Number.isNaN(value)) return;
      this.enqueuePatch(id, field, value);
    },
    sign(id: string, role: string) {
      const doc = this.docs[id];
      if (doc?.kind !== 'exhibit' || doc.signed.includes(role)) return;
      this.enqueuePatch(id, 'signed', [...doc.signed, role]);
    },
    resolveDiscrepancy(id: string) {
      this.enqueuePatch(id, 'resolved', true);
    },
    addExhibit(payload: Pick<ExhibitDoc, 'code' | 'name' | 'lender' | 'hall'>) {
      const doc: ExhibitDoc = {
        kind: 'exhibit', id: newId('ex'), ...payload,
        stage: 'arrival', status: 'pending', signed: [],
        envTemperature: 20, envHumidity: 50, envLight: 150,
      };
      this.enqueueCreate(doc);
    },
    /** 冲突未处理完不能推进阶段 */
    advance(id: string) {
      const doc = this.docs[id];
      if (doc?.kind !== 'exhibit') return;
      if (this.hasConflict(id)) { this.addLog('warn', `「${this.targetTitle(id)}」存在未处理冲突，禁止推进阶段`); return; }
      if (!doc.signed.includes('借展方')) return;
      if (this.discrepancyDocs.some((d) => d.exhibitId === id && !d.resolved)) return;
      const next = doc.stage === 'arrival' ? 'install' : doc.stage === 'install' ? 'return' : 'return';
      this.enqueuePatch(id, 'stage', next);
    },

    // ---- 冲突解决：选择留哪个版本，同样进队列、幂等提交 ----
    resolveConflict(conflictIdValue: string, choose: 'local' | 'remote') {
      const c = this.conflicts.find((x) => x.id === conflictIdValue);
      if (!c) return;
      const resolution = choose === 'local' ? c.localValue : c.remoteValue;
      const op: OutgoingOp = {
        opId: newId('op'), clientId: currentDeviceId.value, targetId: c.targetId,
        kind: 'resolve-conflict', createdAt: Date.now(), field: c.field, resolution: structuredClone(resolution),
      };
      this.outbox.push(op);
      const doc = this.docs[c.targetId];
      if (doc) fset(doc, c.field, structuredClone(resolution));
      this.conflicts = this.conflicts.filter((x) => x.id !== c.id);
      this.addLog('info', `冲突已裁定（${choose === 'local' ? '保留本版' : '采用对方版'}）：${this.targetTitle(c.targetId)} / ${c.field}`);
      this.persist();
    },

    // ---- 同步：先逐条推送队列，再拉服务器快照做字段合并 ----
    async syncNow() {
      if (this.syncing) return;
      this.syncing = true;
      this.lastError = '';
      try {
        // 队列按入队时间排序，从第一条未确认的操作接着推（断点续传）
        this.outbox.sort((a, b) => a.createdAt - b.createdAt);
        let pushed = 0;
        while (this.outbox.length) {
          const op = this.outbox[0];
          try {
            const result = await mockServer.submit(op);
            // 收到确认才出队；duplicate 表示之前已落库，本次不重复入库
            this.outbox.shift();
            this.appliedCount = result.appliedCount;
            pushed += 1;
            this.conflicts = result.conflicts;
            if (result.duplicate) {
              this.addLog('warn', `重试命中幂等记录 ${op.opId.slice(-6)}，服务器未重复入库`);
            } else if (result.conflicts.length) {
              this.addLog('warn', `已提交：${this.describeOp(op)}，存在 ${result.conflicts.length} 项字段冲突待裁定`);
            } else {
              this.addLog('info', `已提交：${this.describeOp(op)}`);
            }
            this.persist();
          } catch (err) {
            // 中途失败：已确认的操作已出队，未确认的原样保留，下次从这里继续
            const applied = err instanceof SyncTransportError && err.applied;
            this.lastError = applied
              ? '网络中断，服务器可能已收录本条操作；稍后重试将自动去重'
              : '同步中途失败，已保留队列，恢复后从断点继续';
            this.addLog('error', `${this.lastError}（${this.describeOp(op)}）`);
            this.persist();
            return;
          }
        }

        // 推送完成（或本次无推送）后，拉取服务器版本做字段合并
        const snapshot = await mockServer.pull(currentDeviceId.value);
        this.pullAndReconcile(snapshot);
        if (pushed) this.addLog('info', `本轮同步完成，提交 ${pushed} 条，服务器累计收录 ${this.appliedCount} 条`);
      } catch {
        this.lastError = '拉取服务器版本失败，本地数据未受影响';
        this.addLog('error', this.lastError);
      } finally {
        this.syncing = false;
        this.persist();
      }
    },

    pullAndReconcile(snap: PullSnapshot) {
      const dirty = new Set<string>();
      for (const op of this.outbox) {
        if (op.kind === 'patch') Object.keys(op.changes ?? {}).forEach((f) => dirty.add(`${op.targetId}::${f}`));
      }
      const openConflictFields = new Set(this.conflicts.map((c) => `${c.targetId}::${c.field}`));

      for (const r of snap.docs) {
        const local = this.docs[r.id];
        if (!local) {
          this.docs[r.id] = structuredClone(r);
          continue;
        }
        // 字段级合并：本地队列里还没推上去的改动字段保留本地值；冲突字段保留本版等裁定；
        // 其余字段以服务器版本为准——整份状态不再互相覆盖。
        for (const field of editableFields(r.kind)) {
          if (dirty.has(`${r.id}::${field}`) || openConflictFields.has(`${r.id}::${field}`)) continue;
          fset(local, field, structuredClone(fget(r, field)));
        }
      }
      // 服务器已不存在的记录暂不清本地（保守策略）；本地新建未同步的记录追加在权威顺序末尾
      const localOnly = this.order.filter((id) => !snap.order.includes(id) && this.docs[id]);
      this.order = [...snap.order, ...localOnly];
      // 服务器是冲突全集的权威：对方已裁定的冲突自动撤销
      this.conflicts = snap.conflicts;
      this.appliedCount = snap.appliedCount;
      this.pulledAt = snap.at;
      this.persist();
    },

    describeOp(op: OutgoingOp): string {
      if (op.kind === 'create') return `新建展品 ${this.targetTitle(op.targetId)}`;
      if (op.kind === 'resolve-conflict') return `裁定冲突 ${this.targetTitle(op.targetId)}/${op.field}`;
      return `更新 ${this.targetTitle(op.targetId)} 的 ${Object.keys(op.changes ?? {}).join('、')}`;
    },
  },
});

export const FIELD_LABELS: Record<string, string> = {
  code: '编号', name: '名称', lender: '借展方', hall: '展厅/柜位',
  stage: '阶段', status: '核验结论', signed: '签字',
  envTemperature: '温度', envHumidity: '湿度', envLight: '照度',
  title: '差异描述', severity: '严重程度', resolved: '是否解决',
};

export const STAGE_LABELS: Record<ExhibitDoc['stage'], string> = {
  arrival: '到场点交', install: '布展核验', return: '闭展归还',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function formatValue(value: FieldValue | null | undefined, field?: string): string {
  if (value === null || value === undefined) return '（空）';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（未签字）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (field === 'stage') return STAGE_LABELS[value as ExhibitDoc['stage']] ?? String(value);
  if (field === 'envTemperature') return `${value}℃`;
  if (field === 'envHumidity') return `${value}%`;
  if (field === 'envLight') return `${value} lux`;
  return String(value);
}
