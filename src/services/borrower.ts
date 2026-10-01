import type { ClientState } from '../types';
import { api } from './api';
import { applyEntityChange, applyEntityCreate, BORROWER_CLIENT_KEY, saveClientState } from './client';
import { processOutbox } from './syncEngine';

/**
 * 模拟“借展方平板”在断网期间改过同一批展品，并先于保管员平板同步。
 * 它从服务器拉取最新状态作为基线，离线改完后整队同步；
 * 保管员平板随后同步时就会在签字/状态等字段上被服务器版本检测到，触发三方合并与冲突。
 */
export async function simulateBorrowerSync(): Promise<{ processed: number; failed: boolean }> {
  const res = await api.get('/state');
  const serverState = res.data as { exhibits: Array<Record<string, any>>; discrepancies: Array<Record<string, any>> };

  const state: ClientState = {
    exhibits: serverState.exhibits.map((item) => {
      const { version: _v, ...rest } = item;
      return rest;
    }) as ClientState['exhibits'],
    discrepancies: serverState.discrepancies.map((item) => {
      const { version: _v, ...rest } = item;
      return rest;
    }) as ClientState['discrepancies'],
    outbox: [],
    versions: {},
    forcedOffline: false
  };
  for (const item of serverState.exhibits) state.versions[`exhibit:${item.id}`] = item.version;
  for (const item of serverState.discrepancies) state.versions[`discrepancy:${item.id}`] = item.version;

  // 借展方在自己平板上的离线改动（ex-11 基线无签字、待核验；ex-12 无签字）
  applyEntityChange(state, 'exhibit', 'ex-11', { signed: ['保管员', '借展方'] }, '借展方');
  applyEntityChange(state, 'exhibit', 'ex-11', { status: 'issue', hall: 'A1 恒温展柜' }, '借展方');
  applyEntityChange(state, 'exhibit', 'ex-12', { signed: ['保管员', '借展方'] }, '借展方');
  applyEntityCreate(
    state,
    'discrepancy',
    {
      id: 'd-borrower-1',
      exhibitId: 'ex-12',
      title: '温湿度连续记录缺失',
      severity: 'major',
      resolved: false
    },
    '借展方'
  );
  applyEntityChange(state, 'exhibit', 'ex-13', { environment: { light: 95 } }, '借展方');

  const result = await processOutbox(state);
  saveClientState(BORROWER_CLIENT_KEY, state);
  return result;
}
