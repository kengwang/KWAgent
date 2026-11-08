import { type Memory, type Recall, type Store } from '@kwagent/core';

/** 本地分词只生成检索候选，不解释经历或推断关系。 */
export function queryTerms(text: string): string[] {
  const counts = new Map<string, number>();
  const metadata = new Set(['id', 'type', 'text', 'source', 'payload', 'seq', 'self', 'scene', 'accountid', 'roleid', 'peerid', 'senderid', 'occurredat', 'receivedat', 'messageseq', 'true', 'false', 'null', 'result', 'message', 'content', 'sources', 'payloadid']);
  for (const item of new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)) {
    const term = item.segment.toLowerCase();
    if (item.isWordLike && term.length >= 2 && !/^\d+$/.test(term) && !/^[a-f0-9]{6,}$/.test(term) && !metadata.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 24).map(([term]) => term);
}

export function mergeRecall(lists: Memory[][], limit: number): Memory[] {
  const scores = new Map<string, { memory: Memory; score: number }>();
  for (const list of lists) list.forEach((memory, index) => {
    const previous = scores.get(memory.id);
    scores.set(memory.id, { memory, score: (previous?.score ?? 0) + 1 / (60 + index) + memory.attention / 1000 });
  });
  return [...scores.values()].sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, limit).map(item => item.memory);
}

export function localRecall(store: Store, query: Recall): Memory[] {
  const terms = [...new Set([query.query.trim(), ...queryTerms(query.query)])].filter(Boolean);
  if (!terms.length) return store.lexical(query).slice(0, query.limit);
  return mergeRecall(terms.map(term => store.lexical({ ...query, query: term, semantic: false })), query.limit);
}
