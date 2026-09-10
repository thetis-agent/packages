/** Require the default provider to pass the independent contract suite; ADR 0006, ADR 0040. */
import { test } from 'node:test';
import { persistence, bounds, paths, concurrent, failures, journal, configuration } from '@/contracts/storage/conformance.ts';
import { storage } from './index.ts';

await test('ST-001 file storage preserves existing objects and committed replacements across reopen', () => persistence(storage));
await test('ST-002 keys, values, retained bytes and entry counts are bounded', () => bounds(storage));
await test('ST-003 file storage refuses links, nonregular entries and replaced roots', () => paths(storage));
await test('ST-004 writes reserve one bounded operation and copy caller-owned bytes and limits', () => concurrent(storage));
await test('ST-005 failed replacement preserves the old object and poisons further use until reopen', () => failures(storage));
await test('ST-006 journals preserve ordered durable bytes, reservations and close fencing', () => journal(storage));
await test('ST-007 invalid limits are refused and unknown configuration fields are tolerated', () => configuration(storage));
