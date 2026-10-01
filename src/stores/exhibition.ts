import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  environment: { temperature: number; humidity: number; light: number };
}
export interface Discrepancy { id: string; exhibitId: string; title: string; severity: 'minor' | 'major'; resolved: boolean; }
interface State { exhibits: Exhibit[]; discrepancies: Discrepancy[]; queued: number; }

const seed: State = {
  exhibits: Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 }
  })),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  queued: 0
};

function load(): State {
  const saved = localStorage.getItem('yf54-exhibition-state');
  return saved ? JSON.parse(saved) as State : seed;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length })
  },
  actions: {
    persist() { localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    setCondition(id: string, status: CheckStatus) { const exhibit = this.exhibits.find((item) => item.id === id); if (exhibit) { exhibit.status = status; this.markQueued(); } },
    sign(id: string, role: string) { const exhibit = this.exhibits.find((item) => item.id === id); if (!exhibit || exhibit.signed.includes(role)) return; exhibit.signed.push(role); this.markQueued(); },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.signed.includes('借展方') || this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) { const item = this.discrepancies.find((entry) => entry.id === id); if (item) { item.resolved = true; this.markQueued(); } },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({ id: `ex-${Date.now()}`, ...payload, stage: 'arrival', status: 'pending', signed: [], environment: { temperature: 20, humidity: 50, light: 150 } });
      this.markQueued();
    },
    syncQueue() { this.queued = 0; this.persist(); }
  }
});
