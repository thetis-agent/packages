/** Change declared variables while preserving retrieval vocabulary and the paired seed; EV-001, SK-013. */
import { replace } from '../../lib/evaluation/replace.ts';
import { seed } from '../../lib/evaluation/index.ts';
import type { Task } from '../../lib/evaluation/index.ts';
import { failure } from '../../lib/result/index.ts';
import type { Result } from '../../lib/result/index.ts';

export interface Variant { request: string; replacements: Readonly<Record<string, string>> }
export const mutationLimits = { stopWords: 65536, requestBytes: 65536, variables: 513 };

export function vocabulary(cards: readonly { name: string; description: string; tags: readonly string[] }[]): Result<Set<string>, 'budget'> {
  const words = new Set<string>();
  for (const card of cards) for (const field of [card.name, card.description, ...card.tags]) for (const word of field.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    words.add(word); if (words.size > mutationLimits.stopWords) return failure('budget', 'The card vocabulary exceeds its word limit.');
  }
  return { ok: true, value: words };
}


export function mutate(task: Task, secret: string, run: number, stoplist: ReadonlySet<string>): Result<Variant, 'invalid-args' | 'budget'> {
  if (Buffer.byteLength(task.request) > mutationLimits.requestBytes || stoplist.size > mutationLimits.stopWords) return failure('budget', 'The mutation exceeds its input limit.');
  const hash = seed(secret, task.id, run); const replacements: Record<string, string> = {};
  const protectedWord = (value: string): boolean => task.family === 'skill' && (value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) ?? []).some(word => stoplist.has(word));
  for (const [index, name] of (task.mutable.names ?? []).entries()) if (name && !protectedWord(name)) replacements[name] = `Person${String(index)}${hash.slice(index % 48, index % 48 + 12)}`;
  for (const [index, number] of (task.mutable.numbers ?? []).entries()) if (number && !protectedWord(number)) replacements[number] = `${String(1000 + index)}${String(Number.parseInt(hash.slice(index % 48, index % 48 + 6), 16)).padStart(8, '0')}`;
  const path = task.mutable.path;
  if (path && !protectedWord(path)) replacements[`{${path}}`] = `/space/variant-${hash.slice(0, 16)}`;
  const names = Object.keys(replacements).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (names.length > mutationLimits.variables) return failure('budget', 'The mutation exceeds its variable limit.');
  if (!names.length) return failure('invalid-args', 'The task has no mutable variable outside its protected vocabulary.');
  const request = replace(task.request, replacements);
  if (request === task.request) return failure('invalid-args', 'The task has no declared mutable variable in its request.');
  if (Buffer.byteLength(request) > mutationLimits.requestBytes) return failure('budget', 'The mutated request exceeds its byte limit.');
  return { ok: true, value: { request, replacements } };
}
