<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { DEVICES, currentDevice, currentDeviceId, forceOffline, setForceOffline, switchDevice } from './services/device';
import { setChaos } from './services/mockServer';
import {
  useExhibitionStore,
  fieldLabel,
  formatValue,
  type ExhibitDoc,
} from './stores/exhibition';

const store = useExhibitionStore();
const realOnline = useOnline();
const offlineSwitch = ref(forceOffline(currentDeviceId.value));
const chaosOn = ref(false);
const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'sync'>('checkin');
const dialog = ref(false);
const selected = ref<ExhibitDoc | null>(null);

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');

const online = computed(() => realOnline.value && !offlineSwitch.value);
const deviceItems = DEVICES.map((d) => ({ title: d.label, value: d.id }));
watch(offlineSwitch, (v) => {
  setForceOffline(currentDeviceId.value, v);
  if (!v && store.pendingCount) store.syncNow();
});
watch(chaosOn, (v) => setChaos(v));
watch(online, (v) => {
  // 网络恢复后自动接着重试
  if (v && store.pendingCount) store.syncNow();
});
onMounted(() => {
  store.bootstrap().then(() => {
    if (online.value && store.pendingCount) store.syncNow();
  });
});

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });

function refreshSelected() {
  selected.value = selected.value ? store.exhibitDocs.find((e) => e.id === selected.value!.id) ?? null : null;
}
watch(() => store.exhibitDocs, refreshSelected, { deep: true });

function statusColor(status: ExhibitDoc['status']) {
  return status === 'issue' ? 'red' : status === 'passed' ? 'green' : 'grey';
}
function logColor(level: 'info' | 'warn' | 'error') {
  return level === 'error' ? 'red' : level === 'warn' ? 'orange' : 'grey';
}
function fmtTime(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-select
        :model-value="currentDeviceId"
        :items="deviceItems"
        density="compact" variant="outlined" hide-details color="white"
        style="max-width: 170px" class="mr-3"
        @update:model-value="switchDevice"
      />
      <v-chip class="mr-2" :color="online ? 'green' : 'orange'" theme="dark">
        {{ online ? '在线' : '离线暂存' }}
      </v-chip>
      <v-tooltip text="模拟展柜区断网（每台设备独立）">
        <template #activator="{ props }">
          <v-switch
            v-bind="props" v-model="offlineSwitch" color="white" hide-details
            label="断网" class="mr-3 text-shrink" dense
          />
        </template>
      </v-tooltip>
      <v-tooltip text="故障注入：服务器落库成功但响应丢失，用于验证重试不重复入库">
        <template #activator="{ props }">
          <v-switch
            v-bind="props" v-model="chaosOn" color="amber-text-accent-2" hide-details
            label="途中失败" class="mr-3" dense
          />
        </template>
      </v-tooltip>
      <v-btn prepend-icon="mdi-sync" :loading="store.syncing" @click="store.syncNow()">立即同步</v-btn>
      <v-btn class="ml-2" prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>

    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-4">
          当前为「{{ currentDevice.label }}」，网络不可用。所有改动按展品逐条进入本地队列，恢复后自动续传，不会覆盖对方数据。
        </v-alert>
        <v-alert v-else-if="store.pendingCount" type="info" icon="mdi-cloud-sync-outline" class="mb-4">
          网络已恢复，本地队列有 {{ store.pendingCount }} 条改动待推送，正在与服务器做字段合并。
        </v-alert>
        <v-alert v-if="store.lastError" type="error" dismissible class="mb-4" @click="store.lastError = ''">
          {{ store.lastError }}
          <template #append><v-btn size="small" variant="tonal" @click.stop="store.syncNow()">断点重试</v-btn></template>
        </v-alert>
        <v-alert v-if="store.conflictCount" type="warning" icon="mdi-alert-circle-outline" class="mb-4">
          有 {{ store.conflictCount }} 个字段双方都改过且结果不同，已保留两版。冲突未裁定前相关展品不能推进阶段。
          <template #append><v-btn size="small" variant="tonal" @click="tab = 'sync'">前往裁定</v-btn></template>
        </v-alert>

        <v-row class="mb-4">
          <v-col cols="6" md><v-card><v-card-text><div class="metric-label">到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolvedCount }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md><v-card><v-card-text><div class="metric-label">本地待同步</div><div class="metric">{{ store.pendingCount }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md><v-card><v-card-text><div class="metric-label">待裁定冲突</div><div :class="store.conflictCount ? 'metric warn' : 'metric'">{{ store.conflictCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
            <v-tab value="sync">同步队列 / 冲突</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibitDocs" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend>
                      <v-badge v-if="store.hasConflict(item.id)" color="error" icon="mdi-alert" floating>
                        <v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar>
                      </v-badge>
                      <v-avatar v-else color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar>
                    </template>
                    <v-list-item-title>
                      {{ item.name }} · {{ item.code }}
                      <v-chip v-if="store.hasConflict(item.id)" size="x-small" color="error" class="ml-2">冲突待裁定</v-chip>
                    </v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · 签字：{{ item.signed.join('、') || '未签' }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <v-window-item value="environment">
              <v-table>
                <thead>
                  <tr><th>展品</th><th>温度 ℃</th><th>湿度 %</th><th>照度 lux</th><th>环境结论</th></tr>
                </thead>
                <tbody>
                  <tr v-for="item in store.exhibitDocs" :key="item.id">
                    <td>{{ item.code }}</td>
                    <td style="width: 110px">
                      <v-text-field :model-value="item.envTemperature" type="number" density="compact" hide-details
                        @update:model-value="(v: string) => store.setEnv(item.id, 'envTemperature', Number(v))" />
                    </td>
                    <td style="width: 110px">
                      <v-text-field :model-value="item.envHumidity" type="number" density="compact" hide-details
                        @update:model-value="(v: string) => store.setEnv(item.id, 'envHumidity', Number(v))" />
                    </td>
                    <td style="width: 110px">
                      <v-text-field :model-value="item.envLight" type="number" density="compact" hide-details
                        @update:model-value="(v: string) => store.setEnv(item.id, 'envLight', Number(v))" />
                    </td>
                    <td>
                      <v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn>
                      <v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </v-window-item>

            <v-window-item value="discrepancy">
              <v-list>
                <v-list-item v-for="item in store.discrepancyDocs" :key="item.id">
                  <template #prepend>
                    <v-badge v-if="store.hasConflict(item.id)" color="error" icon="mdi-alert" floating>
                      <v-icon :color="item.severity === 'major' ? 'red' : 'amber'">mdi-file-document-alert</v-icon>
                    </v-badge>
                    <v-icon v-else :color="item.severity === 'major' ? 'red' : 'amber'">mdi-file-document-alert</v-icon>
                  </template>
                  <v-list-item-title>{{ item.title }}</v-list-item-title>
                  <v-list-item-subtitle>
                    展品 {{ store.targetTitle(item.exhibitId) }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}
                  </v-list-item-subtitle>
                  <template #append>
                    <v-btn :disabled="item.resolved" color="green" variant="tonal" @click="store.resolveDiscrepancy(item.id)">
                      {{ item.resolved ? '已解决' : '确认解决' }}
                    </v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </v-window-item>

            <v-window-item value="sync">
              <v-row>
                <v-col cols="12" md="6">
                  <div class="pa-4">
                    <h3 class="mb-3">断网改动队列（按展品逐条排队）</h3>
                    <v-list lines="two" v-if="store.queueGroups.length">
                      <v-list-item v-for="group in store.queueGroups" :key="group.op.opId">
                        <template #prepend><v-icon color="deep-purple">mdi-clock-outline</v-icon></template>
                        <v-list-item-title>{{ store.targetTitle(group.op.targetId) }}</v-list-item-title>
                        <v-list-item-subtitle>
                          <v-chip v-for="f in group.fields" :key="f" size="x-small" class="mr-1">{{ fieldLabel(f) }}</v-chip>
                          {{ fmtTime(group.op.createdAt) }} · op {{ group.op.opId.slice(-6) }}
                        </v-list-item-subtitle>
                      </v-list-item>
                    </v-list>
                    <v-alert v-else type="success" variant="tonal" icon="mdi-check-circle-outline">
                      队列已清空，本地改动全部被服务器收录。
                    </v-alert>
                    <v-progress-linear v-if="store.syncing" indeterminate color="deep-purple" class="mt-3" />
                  </div>
                </v-col>
                <v-col cols="12" md="6">
                  <div class="pa-4">
                    <h3 class="mb-3">字段冲突（同一展品两边都改过，两版都保留）</h3>
                    <v-card v-for="c in store.conflicts" :key="c.id" class="mb-3" variant="tonal" color="amber">
                      <v-card-item>
                        <v-card-title class="text-body-1">
                          {{ store.targetTitle(c.targetId) }} · 字段「{{ fieldLabel(c.field) }}」
                        </v-card-title>
                        <v-card-text>
                          <v-row dense>
                            <v-col cols="12" class="text-caption grey--text">共同版本：{{ formatValue(c.base, c.field) }}</v-col>
                            <v-col cols="12" md="6">
                              <v-card variant="flat" class="pa-3 conflict-cell">
                                <div class="text-caption text-primary">{{ currentDevice.label }}改的</div>
                                <div class="text-subtitle-2">{{ formatValue(c.localValue, c.field) }}</div>
                                <v-btn size="small" class="mt-2" color="primary" variant="tonal"
                                  @click="store.resolveConflict(c.id, 'local')">保留本版</v-btn>
                              </v-card>
                            </v-col>
                            <v-col cols="12" md="6">
                              <v-card variant="flat" class="pa-3 conflict-cell alt">
                                <div class="text-caption text-orange-darken-2">对方（服务器）改的</div>
                                <div class="text-subtitle-2">{{ formatValue(c.remoteValue, c.field) }}</div>
                                <v-btn size="small" class="mt-2" color="orange" variant="tonal"
                                  @click="store.resolveConflict(c.id, 'remote')">采用对方版</v-btn>
                              </v-card>
                            </v-col>
                          </v-row>
                        </v-card-text>
                      </v-card-item>
                    </v-card>
                    <v-alert v-if="!store.conflicts.length" type="success" variant="tonal" icon="mdi-shield-check-outline">
                      没有待裁定冲突。字段级合并正常时，双方改不同字段或补签字会自动合并、互不丢失。
                    </v-alert>
                  </div>
                </v-col>
              </v-row>
              <v-divider />
              <div class="pa-4">
                <h3 class="mb-2">同步日志 <span class="text-caption grey--text">服务器累计收录 {{ store.appliedCount }} 条</span></h3>
                <v-list density="compact" v-if="store.log.length">
                  <v-list-item v-for="(entry, i) in store.log" :key="i">
                    <template #prepend>
                      <v-icon :color="logColor(entry.level)" size="small">
                        {{ entry.level === 'error' ? 'mdi-alert-circle' : entry.level === 'warn' ? 'mdi-alert' : 'mdi-check' }}
                      </v-icon>
                    </template>
                    <v-list-item-title class="text-body-2">{{ entry.text }}</v-list-item-title>
                    <template #append><span class="text-caption grey--text">{{ fmtTime(entry.at) }}</span></template>
                  </v-list-item>
                </v-list>
                <div v-else class="text-caption grey--text">暂无记录。</div>
              </div>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品（断网也可操作，自动排队）">
            <v-card-text>
              <v-form @submit.prevent="submit">
                <v-text-field v-model="code" label="展品编号" :error-messages="errors.code" />
                <v-text-field v-model="name" label="展品名称" :error-messages="errors.name" />
                <v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" />
                <v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" />
                <v-btn type="submit" color="deep-purple" block>写入本地队列</v-btn>
              </v-form>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="(v: boolean) => !v && (selected = null)">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="store.hasConflict(selected.id)" type="warning" density="compact" class="mb-3">
                该展品有未裁定的字段冲突，冲突处理完之前不能推进阶段。
              </v-alert>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green">
                  <b>保管员点收</b>
                  <p>核对包装、封条和附件清单。</p>
                  <v-btn size="small" :disabled="selected.signed.includes('保管员')"
                    @click="store.sign(selected.id, '保管员')">
                    {{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="orange">
                  <b>借展方确认</b>
                  <p>确认差异项及后续责任。双方签字按数组并集合并，谁都不会被覆盖。</p>
                  <v-btn size="small" :disabled="selected.signed.includes('借展方')"
                    @click="store.sign(selected.id, '借展方')">
                    {{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="purple">
                  <b>推进阶段</b>
                  <p>缺少借展方签字、存在未解决差异或未裁定冲突时不能推进。</p>
                  <v-btn size="small" color="deep-purple"
                    :disabled="store.hasConflict(selected.id)"
                    @click="store.advance(selected.id)">推进到下一阶段</v-btn>
                </v-timeline-item>
              </v-timeline>
            </v-card-text>
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
.conflict-cell { border: 1px dashed #d6d3d1; height: 100%; }
.conflict-cell.alt { border-color: #fdba74; background: #fff7ed; }
.text-shrink :deep(.v-label) { font-size: 12px; }
</style>
