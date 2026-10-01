import { defineStore } from 'pinia';
import type { ClientState, ConflictInfo, Discrepancy, Exhibit, OutboxOp } from '../types';
import { api } from '../services/api';
import {
  applyEntityChange,
  applyEntityCreate,
  loadClientState,
  MAIN_CLIENT_KEY,
  newId,
  saveClientState
} from '../services/client';
import { armFailure as armServerFailure, resetServer, setOffline } from '../services/server';
import { processOutbox, reconcile, resolveConflict } from '../services/syncEngine';
import { simulateBorrowerSync } from '../services/borrower';

interface State extends ClientState {
  syncing: boolean;
  lastError: string;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => ({
    ...loadClientState(MAIN_CLIENT_KEY),
    syncing: false,
    lastError: ''
  }),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    conflictCount: (state) =>
      state.exhibits.filter((item) => item.conflict).length + state.discrepancies.filter((item) => item.conflict).length,
    pendingCount: (state) =>
      state.outbox.filter((item) => ['pending', 'failed', 'inflight', 'conflict'].includes(item.status)).length,
    failedCount: (state) => state.outbox.filter((item) => item.status === 'failed').length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    conflictItems: (state) => {
      const items: Array<{ type: 'exhibit' | 'discrepancy'; id: string; label: string; conflict: ConflictInfo }> = [];
      for (const exhibit of state.exhibits) {
        if (exhibit.conflict) {
          items.push({ type: 'exhibit', id: exhibit.id, label: `${exhibit.code} · ${exhibit.name}`, conflict: exhibit.conflict });
        }
      }
      for (const discrepancy of state.discrepancies) {
        if (discrepancy.conflict) {
          items.push({ type: 'discrepancy', id: discrepancy.id, label: discrepancy.title, conflict: discrepancy.conflict });
        }
      }
      return items;
    }
  },
  actions: {
    persist() {
      saveClientState(MAIN_CLIENT_KEY, this.$state);
    },
    setError(message: string) {
      this.lastError = message;
    },

    setCondition(id: string, status: Exhibit['status']) {
      applyEntityChange(this.$state, 'exhibit', id, { status }, '保管员');
      this.persist();
    },
    updateEnvironment(id: string, patch: Partial<Exhibit['environment']>) {
      applyEntityChange(this.$state, 'exhibit', id, { environment: patch }, '保管员');
      this.persist();
    },
    sign(id: string, role: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || exhibit.signed.includes(role)) return;
      applyEntityChange(this.$state, 'exhibit', id, { signed: [...exhibit.signed, role] }, role);
      this.persist();
    },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      if (exhibit.conflict) {
        this.lastError = '该展品存在字段冲突未处理，不能推进阶段';
        return;
      }
      if (!exhibit.signed.includes('借展方') || this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) {
        this.lastError = '缺少借展方签字或存在未解决差异项，不能推进阶段';
        return;
      }
      const stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      applyEntityChange(this.$state, 'exhibit', id, { stage }, '保管员');
      this.persist();
    },
    resolveDiscrepancy(id: string) {
      const discrepancy = this.discrepancies.find((item) => item.id === id);
      if (!discrepancy || discrepancy.resolved) return;
      applyEntityChange(this.$state, 'discrepancy', id, { resolved: true }, '保管员');
      this.persist();
    },
    addDiscrepancy(exhibitId: string, title: string, severity: Discrepancy['severity']) {
      const discrepancy: Discrepancy = { id: newId('d'), exhibitId, title, severity, resolved: false };
      applyEntityCreate(this.$state, 'discrepancy', discrepancy, '保管员');
      this.persist();
    },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      const exhibit: Exhibit = {
        id: newId('ex'),
        ...payload,
        stage: 'arrival',
        status: 'pending',
        signed: [],
        environment: { temperature: 20, humidity: 50, light: 150 }
      };
      applyEntityCreate(this.$state, 'exhibit', exhibit, '保管员');
      this.persist();
    },

    /** 网络恢复后按队列同步：失败可重试，已收下的记录靠幂等去重 */
    async sync() {
      if (this.syncing) return;
      this.syncing = true;
      this.lastError = '';
      try {
        const result = await processOutbox(this.$state);
        await reconcile(this.$state);
        if (result.failed) {
          this.lastError = '同步中途网络中断，失败的操作已保留，恢复后可继续重试（不会重复入库）';
        }
      } catch {
        this.lastError = '同步失败：当前网络不可用，变更已在本地队列中排队';
      } finally {
        this.syncing = false;
        this.persist();
      }
    },

    resolveConflict(type: 'exhibit' | 'discrepancy', id: string, choices: Record<string, 'local' | 'server'>) {
      resolveConflict(this.$state, type, id, choices);
      this.persist();
    },

    toggleOffline(value: boolean) {
      this.forcedOffline = value;
      setOffline(value);
      this.persist();
    },
    armFailure() {
      armServerFailure();
    },
    /** 模拟借展方平板断网改完同一批展品并先同步 */
    async simulateBorrower() {
      this.lastError = '';
      try {
        await simulateBorrowerSync();
        await this.sync();
      } catch {
        this.lastError = '模拟借展方同步时网络中断';
      }
    },
    resetAll() {
      resetServer();
      localStorage.removeItem(MAIN_CLIENT_KEY);
      location.reload();
    }
  }
});

export type { Exhibit, Discrepancy, OutboxOp };
