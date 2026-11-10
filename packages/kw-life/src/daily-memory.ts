import { PersistenceError, type Role, type Store } from '@kwagent/core';

/** 每个角色每日领取一次02:00整理机会，领取记录与角色状态分别保存。 */
export class DailyMemory {
  private readonly enabledAt: number;
  constructor(readonly store: Store, readonly timeZone: string, at = new Date()) {
    const saved = store.meta('daily-memory-enabled-at');
    this.enabledAt = Date.parse(saved ?? at.toISOString());
    if (!Number.isFinite(this.enabledAt)) throw new PersistenceError('每日记忆整理启用时间无效');
    if (!saved) store.setMeta('daily-memory-enabled-at', at.toISOString());
  }
  private local(at: Date) {
    return {
      day: new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone }).format(at),
      clock: new Intl.DateTimeFormat('en-GB', { timeZone: this.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at),
    };
  }
  due(role: Pick<Role, 'id' | 'createdAt'>, at = new Date()): boolean {
    const current = this.local(at);
    if (current.clock < '02:00') return false;
    const key = `daily-memory-day:${role.id}`;
    let lastDay = this.store.meta(key);
    if (lastDay === undefined) {
      const anchor = this.local(new Date(Math.max(this.enabledAt, Date.parse(role.createdAt))));
      lastDay = anchor.clock >= '02:00' ? anchor.day : '';
      this.store.setMeta(key, lastDay);
    }
    if (lastDay && !/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) throw new PersistenceError('每日记忆整理日期无效');
    return lastDay < current.day;
  }
  claim(role: Pick<Role, 'id' | 'createdAt'>, at = new Date()): boolean {
    return this.store.transaction(() => {
      if (!this.due(role, at)) return false;
      this.store.setMeta(`daily-memory-day:${role.id}`, this.local(at).day);
      return true;
    });
  }
}
