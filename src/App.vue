<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useExhibitionStore, type Exhibit, type OutboxOp } from './stores/exhibition';

const store = useExhibitionStore();
const navigatorOnline = useOnline();
const online = computed(() => navigatorOnline.value && !store.forcedOffline);

const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'outbox'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const newDiscrepancyTitle = ref('');
const newDiscrepancyExhibit = ref('ex-1');
const newDiscrepancySeverity = ref<'minor' | 'major'>('minor');

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');

const submit = handleSubmit((values) => {
  store.addExhibit(values);
  dialog.value = false;
  resetForm();
});

function stageLabel(stage: Exhibit['stage']) {
  return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage];
}
function statusLabel(status: Exhibit['status']) {
  return { pending: '待核验', passed: '通过', issue: '异常' }[status];
}

// ---- 冲突解决 ----
const conflictDialog = ref<{ type: 'exhibit' | 'discrepancy'; id: string } | null>(null);
const conflictChoices = ref<Record<string, 'local' | 'server'>>({});

const conflictEntity = computed(() => {
  const target = conflictDialog.value;
  if (!target) return null;
  const entity =
    target.type === 'exhibit'
      ? store.exhibits.find((item) => item.id === target.id)
      : store.discrepancies.find((item) => item.id === target.id);
  return entity?.conflict ? entity : null;
});
const conflictLabel = computed(() => {
  const target = conflictDialog.value;
  if (!target) return '';
  if (target.type === 'exhibit') {
    const exhibit = store.exhibits.find((item) => item.id === target.id);
    return exhibit ? `${exhibit.code} · ${exhibit.name}` : '';
  }
  const discrepancy = store.discrepancies.find((item) => item.id === target.id);
  return discrepancy?.title ?? '';
});

function openConflict(type: 'exhibit' | 'discrepancy', id: string) {
  conflictDialog.value = { type, id };
  const entity = type === 'exhibit' ? store.exhibits.find((item) => item.id === id) : store.discrepancies.find((item) => item.id === id);
  const choices: Record<string, 'local' | 'server'> = {};
  for (const field of entity?.conflict?.fields ?? []) choices[field] = 'local';
  conflictChoices.value = choices;
}
function setAllChoices(choice: 'local' | 'server') {
  if (!conflictEntity.value?.conflict) return;
  for (const field of conflictEntity.value.conflict.fields) conflictChoices.value[field] = choice;
}
function confirmResolve() {
  const target = conflictDialog.value;
  if (!target) return;
  store.resolveConflict(target.type, target.id, conflictChoices.value);
  conflictDialog.value = null;
  if (online.value) void store.sync();
}

const FIELD_LABELS: Record<string, string> = {
  status: '核验状态',
  hall: '展厅/柜位',
  signed: '签字',
  stage: '阶段',
  lender: '借展方',
  code: '编号',
  name: '名称',
  title: '差异项标题',
  severity: '严重程度',
  resolved: '已解决',
  'environment.temperature': '环境温度',
  'environment.humidity': '环境湿度',
  'environment.light': '环境照度'
};
function fieldLabel(field: string) {
  return FIELD_LABELS[field] ?? field;
}
function formatValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (field === 'status') return statusLabel(value as Exhibit['status']);
  if (field === 'stage') return stageLabel(value as Exhibit['stage']);
  if (field === 'signed') return Array.isArray(value) && value.length ? value.join('、') : '—';
  if (field === 'resolved') return value ? '是' : '否';
  if (field === 'severity') return value === 'major' ? '重大' : '轻微';
  if (field === 'environment.temperature') return `${value}℃`;
  if (field === 'environment.humidity') return `${value}%`;
  if (field === 'environment.light') return `${value} lux`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---- 同步队列 ----
const OP_STATUS: Record<OutboxOp['status'], { label: string; color: string }> = {
  pending: { label: '待同步', color: 'grey' },
  inflight: { label: '同步中', color: 'blue' },
  acked: { label: '已同步', color: 'green' },
  failed: { label: '失败待重试', color: 'red' },
  conflict: { label: '冲突待处理', color: 'orange' },
  superseded: { label: '已取代', color: 'grey' }
};
function opLabel(op: OutboxOp): string {
  if (op.entityType === 'exhibit') {
    const exhibit = store.exhibits.find((item) => item.id === op.entityId);
    return exhibit ? `${exhibit.code} ${exhibit.name}` : op.entityId;
  }
  const discrepancy = store.discrepancies.find((item) => item.id === op.entityId);
  return discrepancy?.title ?? op.entityId;
}
function opSummary(op: OutboxOp): string {
  if (op.kind === 'create') return '新建';
  const keys = Object.keys(op.changes);
  const labels = keys.map((key) => fieldLabel(key));
  return `修改 ${labels.join('、')}`;
}
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function addDiscrepancy() {
  const title = newDiscrepancyTitle.value.trim();
  if (!title) return;
  store.addDiscrepancy(newDiscrepancyExhibit.value, title, newDiscrepancySeverity.value);
  newDiscrepancyTitle.value = '';
}

// 恢复在线后自动续传队列
watch(online, (value) => {
  if (value && store.pendingCount) void store.sync();
}, { immediate: true });
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert :color="online ? 'deep-purple-lighten-5' : 'orange-lighten-4'" icon="mdi-cloud-off-outline" class="mb-5">
          <template v-if="!online">
            展柜区断网中：所有签字、环境结论和差异项修改都保存在本机队列，网络恢复后按服务器版本做字段合并，不会整份覆盖对方已同步的内容。
          </template>
          <template v-else-if="store.pendingCount">
            在线：本机队列还有 {{ store.pendingCount }} 条变更未完成同步（失败的会保留状态，重试时服务器已收下的记录不会重复入库）。
          </template>
          <template v-else>
            所有变更已同步到服务器，无冲突。
          </template>
          <template #append>
            <v-btn v-if="online" color="deep-purple" variant="flat" :loading="store.syncing" @click="store.sync">确认同步</v-btn>
            <v-switch
              class="ml-3"
              inline
              density="compact"
              label="模拟断网"
              hide-details
              :model-value="store.forcedOffline"
              @update:model-value="(value) => store.toggleOffline(Boolean(value))"
            />
          </template>
        </v-alert>

        <v-alert v-if="store.lastError" type="warning" variant="tonal" class="mb-5" closable @click:close="store.setError('')">
          {{ store.lastError }}
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="2"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="2"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="2"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">本地待同步</div><div class="metric">{{ store.pendingCount }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card :color="store.conflictCount ? 'red-lighten-5' : undefined"><v-card-text><div class="metric-label">字段冲突（未处理不能推进阶段）</div><div class="metric" :class="{ warn: store.conflictCount }">{{ store.conflictCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
            <v-tab value="outbox">
              同步队列<span v-if="store.pendingCount" class="ml-1 text-orange">({{ store.pendingCount }})</span>
            </v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip v-if="item.conflict" size="small" color="red" class="mr-2" @click.stop="openConflict('exhibit', item.id)">字段冲突</v-chip>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ statusLabel(item.status) }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度(℃)</th><th>湿度(%)</th><th>照度(lx)</th><th>核验结论</th></tr></thead>
                <tbody>
                  <tr v-for="item in store.exhibits" :key="item.id">
                    <td>
                      {{ item.code }}
                      <v-chip v-if="item.conflict" size="x-small" color="red" class="ml-1" @click="openConflict('exhibit', item.id)">冲突</v-chip>
                    </td>
                    <td><v-text-field type="number" density="compact" hide-details :model-value="item.environment.temperature" @update:model-value="store.updateEnvironment(item.id, { temperature: Number($event) })" /></td>
                    <td><v-text-field type="number" density="compact" hide-details :model-value="item.environment.humidity" @update:model-value="store.updateEnvironment(item.id, { humidity: Number($event) })" /></td>
                    <td><v-text-field type="number" density="compact" hide-details :model-value="item.environment.light" @update:model-value="store.updateEnvironment(item.id, { light: Number($event) })" /></td>
                    <td>
                      <v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn>
                      <v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </v-window-item>

            <v-window-item value="discrepancy">
              <v-row class="pa-3 pb-0" no-gutters>
                <v-col cols="12" md="4" class="pr-2"><v-text-field v-model="newDiscrepancyTitle" density="compact" hide-details label="新增差异项标题（断网时也会排队）" /></v-col>
                <v-col cols="6" md="2" class="pr-2">
                  <v-select v-model="newDiscrepancySeverity" density="compact" hide-details label="严重程度" :items="[{ value: 'minor', title: '轻微' }, { value: 'major', title: '重大' }]" />
                </v-col>
                <v-col cols="6" md="2"><v-btn color="deep-purple" variant="flat" @click="addDiscrepancy">添加并排队</v-btn></v-col>
              </v-row>
              <v-list>
                <v-list-item v-for="item in store.discrepancies" :key="item.id">
                  <v-list-item-title>
                    {{ item.title }}
                    <v-chip v-if="item.conflict" size="x-small" color="red" class="ml-1" @click="openConflict('discrepancy', item.id)">冲突</v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle>
                  <template #append>
                    <v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </v-window-item>

            <v-window-item value="outbox">
              <v-list v-if="store.outbox.length">
                <v-list-item v-for="op in store.outbox" :key="op.id" class="op-row">
                  <template #prepend>
                    <v-chip size="small" :color="OP_STATUS[op.status].color" variant="flat">{{ OP_STATUS[op.status].label }}</v-chip>
                  </template>
                  <v-list-item-title>{{ opLabel(op) }} · {{ opSummary(op) }}</v-list-item-title>
                  <v-list-item-subtitle>
                    {{ op.actor }} · {{ formatTime(op.clientTs) }} · 第 {{ op.attempts }} 次尝试
                    <span class="op-key">· 幂等 {{ op.key.slice(4, 12) }}</span>
                    <span v-if="op.resultVersion">· 服务器版本 v{{ op.resultVersion }}</span>
                    <span v-if="op.error" class="text-red">· {{ op.error }}</span>
                  </v-list-item-subtitle>
                  <template #append>
                    <v-btn v-if="op.status === 'failed'" size="small" color="deep-purple" variant="flat" @click="store.sync">重试</v-btn>
                    <v-btn v-if="op.status === 'conflict'" size="small" color="red" variant="flat" @click="openConflict(op.entityType, op.entityId)">处理冲突</v-btn>
                  </template>
                </v-list-item>
              </v-list>
              <v-sheet v-else class="pa-8 text-center text-medium-emphasis">队列为空：断网期间的逐条修改会在这里排队，同步状态、失败原因和幂等号都可追溯。</v-sheet>
            </v-window-item>
          </v-window>
        </v-card>

        <v-card class="mt-5">
          <v-card-text>
            <div class="text-subtitle-1 mb-2">演示：断网后两边改了同一批展品</div>
            <v-btn class="mr-3" color="deep-purple" variant="tonal" :loading="store.syncing" @click="store.simulateBorrower">模拟借展方平板先同步</v-btn>
            <v-btn class="mr-3" color="orange" variant="tonal" @click="store.armFailure(); store.setError('已布置下一次请求“服务器已收下但响应丢失”，请点“确认同步”：失败后重试不会重复入库。')">布置一次响应丢失</v-btn>
            <v-btn color="grey" variant="text" @click="store.resetAll">重置全部演示数据</v-btn>
            <div class="text-caption text-medium-emphasis mt-2">
              建议流程：打开“模拟断网” → 在展品上签字/设状态 → 点“模拟借展方平板先同步” → 恢复网络后“确认同步”，即可看到签字自动并集、状态字段标红冲突；冲突处理前不能推进阶段。
            </div>
          </v-card-text>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="selected.conflict" type="error" variant="tonal" class="mb-3">
                双方离线修改后有字段不一致，已同时保留本机版本与服务器版本。冲突未处理前不能推进阶段。
                <template #append><v-btn color="red" variant="flat" @click="openConflict('exhibit', selected.id)">去处理冲突</v-btn></template>
              </v-alert>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green"><b>保管员点收</b><p>核对包装、封条和附件清单。</p><v-btn size="small" :disabled="selected.signed.includes('保管员')" @click="store.sign(selected.id, '保管员')">{{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="orange"><b>借展方确认</b><p>确认差异项及后续责任。</p><v-btn size="small" :disabled="selected.signed.includes('借展方')" @click="store.sign(selected.id, '借展方')">{{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="purple"><b>推进阶段</b><p>存在未解决差异、字段冲突或缺少借展方签字时不能推进。</p><v-btn size="small" color="deep-purple" :disabled="Boolean(selected.conflict)" @click="store.advance(selected.id)">推进到下一阶段</v-btn></v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(conflictEntity)" max-width="820" @update:model-value="(value) => { if (!value) conflictDialog = null; }">
          <v-card v-if="conflictEntity">
            <v-card-title>解决字段冲突 · {{ conflictLabel }}</v-card-title>
            <v-card-text>
              <v-alert type="warning" variant="tonal" class="mb-3">
                断网期间双方都修改了下列字段。请选择以哪一版为准：未选择的字段保留本机版本。解决后会重新排队同步；冲突未处理前相关展品不能推进阶段。
              </v-alert>
              <v-table>
                <thead><tr><th>字段</th><th>本机（保管员平板）</th><th>服务器（借展方先同步）</th><th>采用</th></tr></thead>
                <tbody>
                  <tr v-for="field in conflictEntity.conflict?.fields" :key="field">
                    <td>{{ fieldLabel(field) }}</td>
                    <td>{{ formatValue(field, conflictEntity.conflict?.local[field]) }}</td>
                    <td>{{ formatValue(field, conflictEntity.conflict?.server[field]) }}</td>
                    <td>
                      <v-radio-group v-model="conflictChoices[field]" density="compact" hide-details>
                        <v-radio label="本机" value="local" />
                        <v-radio label="服务器" value="server" />
                      </v-radio-group>
                    </td>
                  </tr>
                </tbody>
              </v-table>
              <v-btn size="small" variant="text" @click="setAllChoices('local')">全部采用本机</v-btn>
              <v-btn size="small" variant="text" @click="setAllChoices('server')">全部采用服务器</v-btn>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn @click="conflictDialog = null">稍后处理</v-btn>
              <v-btn color="deep-purple" variant="flat" @click="confirmResolve">按所选版本解决并同步</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.op-row { border-bottom: 1px solid #f0f0f0; }
.op-key { color: #9ca3af; font-family: monospace; }
</style>
