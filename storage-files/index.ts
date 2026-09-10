/** Provide file storage within the caller's existing filesystem grants; contract/storage, ADR 0040. */
export { storage, defaults } from '../../lib/storage/index.ts';
export type { Storage, StorageProvider, AppendLog, Limits } from '../../contracts/storage/index.ts';
export const stages = {};
