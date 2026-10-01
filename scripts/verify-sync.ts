// 端到端验证（不依赖浏览器，用内存 localStorage 垫片）
import { mockServer, setChaos, SyncTransportError } from '../src/services/mockServer';
import type { OutgoingOp, PullSnapshot } from '../src/services/sync-types';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

let counter = 0;
function makeOp(partial: Partial<OutgoingOp> & { clientId: string; targetId: string }): OutgoingOp {
  counter += 1;
  return { opId: `op-test-${counter}`, kind: 'patch', createdAt: Date.now() + counter, changes: {}, bases: {}, ...partial };
}

async function main() {
  // 场景 1：两边改同一展品的不同字段 + 各自签字 -> 字段级自动合并、签字并集
  console.log('\n[场景1] 不同字段离线并发 + 签字并集');
  let snap: PullSnapshot = await mockServer.pull('keeper');
  const before = snap.docs.find((d) => d.id === 'ex-1') as any;
  console.log('    初始:', JSON.stringify({ t: before.envTemperature, h: before.envHumidity, signed: before.signed }));

  // 保管员离线改湿度 + 签字
  const keeperOp = makeOp({
    clientId: 'keeper', targetId: 'ex-1',
    changes: { envHumidity: 44, signed: ['保管员'] },
    bases: { envHumidity: before.envHumidity, signed: before.signed },
  });
  // 借展方离线改温度 + 签字（先用不同 base 模拟各自分叉）
  const lenderOp = makeOp({
    clientId: 'lender', targetId: 'ex-1',
    changes: { envTemperature: 25, signed: ['借展方'] },
    bases: { envTemperature: before.envTemperature, signed: before.signed },
  });

  const lenderRes = await mockServer.submit(lenderOp);
  assert(lenderRes.conflicts.length === 0, '借展方先同步：无冲突');

  const keeperRes = await mockServer.submit(keeperOp);
  assert(keeperRes.conflicts.length === 0, '保管员后同步：不同字段+签字不产生冲突');

  snap = await mockServer.pull('keeper');
  const merged = snap.docs.find((d) => d.id === 'ex-1') as any;
  assert(merged.envTemperature === 25, `温度采用借展方修改：25（实际 ${merged.envTemperature}）`);
  assert(merged.envHumidity === 44, `湿度保留保管员修改：44（实际 ${merged.envHumidity}）`);
  assert(JSON.stringify(merged.signed) === JSON.stringify(['保管员', '借展方']),
    `签字并集、谁都不丢：${merged.signed.join('+')}`);

  // 场景 2：同一字段两边都改成不同值 -> 冲突双版，字段不动
  console.log('\n[场景2] 同一字段两边都改 -> 保留两版、标冲突');
  snap = await mockServer.pull('keeper');
  const cur = snap.docs.find((d) => d.id === 'ex-2') as any;
  const lender2 = makeOp({
    clientId: 'lender', targetId: 'ex-2',
    changes: { envHumidity: 60 }, bases: { envHumidity: cur.envHumidity },
  });
  await mockServer.submit(lender2);
  const keeper2 = makeOp({
    clientId: 'keeper', targetId: 'ex-2',
    changes: { envHumidity: 33 }, bases: { envHumidity: cur.envHumidity },
  });
  const k2res = await mockServer.submit(keeper2);
  assert(k2res.conflicts.length === 1, '保管员侧挂出 1 个冲突');
  const c = k2res.conflicts[0];
  assert(c.field === 'envHumidity' && c.localValue === 33 && c.remoteValue === 60,
    `冲突记录保留两版本地33/远端60（实际 ${c.localValue}/${c.remoteValue}）`);
  assert(c.base === cur.envHumidity, '冲突记录保留共同 base');
  const after2 = (await mockServer.pull('keeper')).docs.find((d) => d.id === 'ex-2') as any;
  assert(after2.envHumidity === 60, '冲突字段服务器维持对方版本，不被后到的整份状态覆盖');

  // 保管员裁定采用本版 33
  const resolveOp = makeOp({
    clientId: 'keeper', targetId: 'ex-2', kind: 'resolve-conflict',
    field: 'envHumidity', resolution: 33,
  });
  const rres = await mockServer.submit(resolveOp);
  assert(rres.conflicts.length === 0, '裁定后冲突清除');
  const after3 = (await mockServer.pull('keeper')).docs.find((d) => d.id === 'ex-2') as any;
  assert(after3.envHumidity === 33, '裁定值 33 落地服务器');

  // 场景 3：途中失败（已落库、响应丢失）-> 重试幂等、不重复入库
  console.log('\n[场景3] 落库后响应丢失 -> opId 幂等重试');
  snap = await mockServer.pull('keeper');
  const beforeCount = snap.appliedCount;
  const keeper3 = makeOp({
    clientId: 'keeper', targetId: 'ex-3',
    changes: { envLight: 999 }, bases: { envLight: (snap.docs.find((d) => d.id === 'ex-3') as any).envLight },
  });
  setChaos(true);
  let threw = false;
  try {
    await mockServer.submit(keeper3);
  } catch (e) {
    threw = e instanceof SyncTransportError && e.applied;
  }
  assert(threw, '首次提交：服务器已落库但响应丢失，抛出 applied 错误');
  setChaos(false);
  const retry = await mockServer.submit(keeper3);
  assert(retry.duplicate === true, '同 opId 重试被识别为重复');
  const afterRetry = (await mockServer.pull('keeper'));
  assert(afterRetry.appliedCount === beforeCount + 1,
    `收录计数只增加 1（${beforeCount} -> ${afterRetry.appliedCount}），没有重复入库`);
  assert((afterRetry.docs.find((d) => d.id === 'ex-3') as any).envLight === 999, '重试后值正确');

  // 场景 4：队列中途失败 -> 已确认出队、未确认保留；恢复后从断点续传
  console.log('\n[场景4] 批量队列中途失败 -> 断点续传');
  snap = await mockServer.pull('keeper');
  const ex4 = snap.docs.find((d) => d.id === 'ex-4') as any;
  const ops = [
    makeOp({ clientId: 'keeper', targetId: 'ex-4', changes: { envTemperature: 30 }, bases: { envTemperature: ex4.envTemperature } }),
    makeOp({ clientId: 'keeper', targetId: 'ex-4', changes: { status: 'passed' }, bases: { status: ex4.status } }),
    makeOp({ clientId: 'keeper', targetId: 'ex-4', changes: { envLight: 50 }, bases: { envLight: ex4.envLight } }),
  ];
  setChaos(true);
  const queue = [...ops];
  let failedAt = -1;
  while (queue.length) {
    try {
      await mockServer.submit(queue[0]);
      queue.shift(); // 只有拿到确认才出队
    } catch {
      failedAt = ops.indexOf(queue[0]);
      break;
    }
  }
  assert(failedAt === 0 && queue.length === 3, `第一条就失败时队列原样保留（剩 ${queue.length} 条）`);

  // 恢复后逐条续传：第一条在失败时其实已落库，应被识别为重复确认；其余正常提交
  setChaos(false);
  for (let i = 0; queue.length; i++) {
    const r = await mockServer.submit(queue[0]);
    queue.shift();
    assert(r.duplicate === (i === 0), i === 0 ? '首条续传命中幂等记录，仅确认不重复入库' : '续传的新操作正常收录');
  }
  const final4 = (await mockServer.pull('keeper')).docs.find((d) => d.id === 'ex-4') as any;
  assert(final4.envTemperature === 30 && final4.status === 'passed' && final4.envLight === 50,
    '断点续传后三个字段全部落地');

  // 场景 5：新建展品幂等
  console.log('\n[场景5] create 操作幂等');
  const createOp = makeOp({
    clientId: 'keeper', targetId: 'ex-new-1', kind: 'create',
    doc: {
      kind: 'exhibit', id: 'ex-new-1', code: 'M999', name: '测试金器', lender: '私人借展方',
      hall: 'C1', stage: 'arrival', status: 'pending', signed: [],
      envTemperature: 20, envHumidity: 50, envLight: 150,
    },
  });
  await mockServer.submit(createOp);
  const dupCreate = await mockServer.submit(createOp);
  assert(dupCreate.duplicate, '重复 create 被识别');
  const list = (await mockServer.pull('keeper')).docs.filter((d) => d.id === 'ex-new-1');
  assert(list.length === 1, '同一条新建操作没有产生重复记录');

  console.log(fail === 0 ? `\n全部通过：${pass} 项断言` : `\n${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
