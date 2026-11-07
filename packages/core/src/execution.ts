import { AsyncLocalStorage } from 'node:async_hooks';

/** 后台执行保留发起活动，后续模型步骤不会改变其归属。 */
export const executionOrigin = new AsyncLocalStorage<{ roleId: string; activityId: string | null; taskId: string }>();
