import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import vuetify from 'vite-plugin-vuetify';

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  server: { host: '0.0.0.0', port: 62019 },
  preview: { host: '0.0.0.0', port: 62019 }
});
