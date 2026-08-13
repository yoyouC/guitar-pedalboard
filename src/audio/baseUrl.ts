/**
 * vite 注入的 BASE_URL;tsx --test 环境没有 import.meta.env,回退 '/'。
 * 生产构建中 import.meta.env 必定存在,此回退不影响线上行为。
 */
export const BASE_URL: string = import.meta.env?.BASE_URL ?? '/';
