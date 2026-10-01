import { computed, ref } from 'vue';

export interface DeviceProfile {
  id: string;
  label: string;
  role: string;
  color: string;
}

export const DEVICES: DeviceProfile[] = [
  { id: 'keeper', label: '保管员平板', role: '保管员', color: 'teal' },
  { id: 'lender', label: '借展方平板', role: '借展方', color: 'orange' },
];

const CURRENT_KEY = 'yf54-device';
const FORCE_OFFLINE_PREFIX = 'yf54-force-offline:';

export const currentDeviceId = ref<string>(localStorage.getItem(CURRENT_KEY) || DEVICES[0].id);
export const currentDevice = computed(() => DEVICES.find((d) => d.id === currentDeviceId.value) ?? DEVICES[0]);

export function switchDevice(id: string) {
  if (id === currentDeviceId.value) return;
  localStorage.setItem(CURRENT_KEY, id);
  // 两块平板各自维护独立的本地库与队列，整页重载最贴近真实换设备
  window.location.reload();
}

export function storageKey(deviceId: string) {
  return `yf54-local-v1:${deviceId}`;
}

export function forceOffline(deviceId: string): boolean {
  return localStorage.getItem(FORCE_OFFLINE_PREFIX + deviceId) === '1';
}
export function setForceOffline(deviceId: string, v: boolean) {
  localStorage.setItem(FORCE_OFFLINE_PREFIX + deviceId, v ? '1' : '0');
}
