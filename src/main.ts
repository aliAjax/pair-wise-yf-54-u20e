import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';

const vuetify = createVuetify({ theme: { defaultTheme: 'light' } });
createApp(App).use(createPinia()).use(router).use(i18n).use(vuetify).mount('#app');
