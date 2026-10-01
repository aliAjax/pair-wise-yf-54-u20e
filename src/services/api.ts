import axios from 'axios';
import { serverRequest } from './server';

export const api = axios.create({ baseURL: '/api', timeout: 8000 });

// 开发环境用浏览器内“服务器”接管 /api 请求，模拟真实网络往返与失败
api.defaults.adapter = async (config) => {
  const body = config.data ? JSON.parse(String(config.data)) : undefined;
  try {
    const data = await serverRequest((config.method ?? 'get').toUpperCase(), config.url ?? '', body);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  } catch {
    return Promise.reject({ config, code: 'ERR_NETWORK', message: '网络连接不可用或已中断', name: 'AxiosError' });
  }
};
