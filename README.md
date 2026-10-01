# pair-wise-yf-54 博物馆展品点交与布展条件核验

## 源提示词摘要
策展人、保管员、布展负责人和借展方从到场点交、环境条件检查、安装位置确认到闭展归还共同处理展品。系统记录条件、附件、风险等级、照片说明、处理意见和签字结果，差异项未解决时不能进入下一阶段，并支持大量展品与断网暂存。

## 技术栈
Vue 3 + TypeScript + Vite + Vuetify + Pinia + Vue Router + Axios + VueUse + VeeValidate + Zod + Vue I18n。

## 已实现闭环
- 展品、环境检查、差异项三类业务对象。
- 到场点交、布展核验、闭展归还的分阶段签字与推进门禁。
- 未解决差异阻断流转，可单独确认解决。
- `v-virtual-scroll` 大列表、离线队列提示、手动确认同步。
- localStorage 持久化。

## 启动
```bash
npm install
npm run dev
```
开发端口：62019
