import { createI18n } from 'vue-i18n';

export const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: { zh: { title: '博物馆展品点交与布展条件核验', checkIn: '展品点交', environment: '环境条件', discrepancies: '差异项' } }
});
