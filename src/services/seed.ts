import type { Discrepancy, Exhibit } from '../types';

export function seedExhibits(): Exhibit[] {
  return Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + (index % 3), humidity: 48 + (index % 8), light: 120 + index * 3 }
  }));
}

export function seedDiscrepancies(): Discrepancy[] {
  return [
    { id: 'd-1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd-2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ];
}
