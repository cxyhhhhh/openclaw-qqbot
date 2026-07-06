import { MemoryHistoryStore } from '@tencent-connect/qqbot-nodejs';
import type { HistoryStore } from '@tencent-connect/qqbot-nodejs';

let _store: HistoryStore | null = null;

export function getHistoryStore(): HistoryStore {
  if (!_store) _store = new MemoryHistoryStore();
  return _store;
}

/** 清空群历史（dispatch 完成后调用） */
export function clearGroupHistory(groupId: string): void {
  _store?.clear?.(groupId);
}
