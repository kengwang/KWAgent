export interface Page<T> { items: T[]; nextCursor: number | null }

export function appendPage<T>(previous: Page<T>, next: Page<T>, key: (item: T) => string): Page<T> {
  const records = new Map(previous.items.map(item => [key(item), item]));
  for (const item of next.items) records.set(key(item), item);
  return { items: [...records.values()], nextCursor: next.nextCursor };
}
