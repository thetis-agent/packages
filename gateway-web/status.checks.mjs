/* Branch coverage for assets/lib/status.js, the status bar's wording and arithmetic.
 *
 * Run as a child process by activity.test.ts alongside activity.checks.mjs, and for the same
 * reason: the served assets are plain ES modules with no declarations, and this repository
 * type-checks `.ts` only (tsconfig.base.json has no `allowJs`), so a `.ts` test cannot import one
 * without a silencing cast the house rules forbid.
 *
 * Two things are being defended here. One is the arithmetic — a meter that is wrong is worse than
 * no meter, and every threshold has an off-by-one available to it. The other is the vocabulary:
 * this bar is on screen permanently, and the house rule is that nothing on it teaches a person the
 * system's private words for its own machinery. That rule is only enforceable if something checks
 * it, so the last case below reads every string this module can return and refuses the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_ROWS, POLL_MS, bytes, canShowLogs, describeAgent, describeCounts, describeEnv, describeLoad,
  describeLogRow, describeLogs, describeMemory, describeOverall, describeSetup, figure, logDetail
} from './assets/lib/status.js';

const GiB = 1024 ** 3;

await test('the poll and the log window are bounded by named settings', () => {
  assert.ok(POLL_MS >= 1000, 'a sub-second poll would cost the host more than the bar is worth.');
  assert.ok(LOG_ROWS > 0 && LOG_ROWS <= 200, 'the ask must stay inside the kernel’s own row cap.');
});

await test('the environment item says what the machine means in words a person already knows', () => {
  assert.equal(describeEnv(undefined), null, 'no status sent means no item drawn.');
  assert.deepEqual(describeEnv({ target: 'admin', ready: true, state: 'LIVE' }).word, 'ready');
  assert.equal(describeEnv({ target: 'admin', ready: true, state: 'LIVE' }).tone, null);
  assert.equal(describeEnv({ target: 'admin', ready: false, state: 'APPLYING' }).word, 'updating');
  assert.equal(describeEnv({ target: 'admin', ready: false, state: 'APPLYING' }).tone, 'warn');
  assert.equal(describeEnv({ target: 'admin', ready: false, state: 'FAILED' }).tone, 'err');
  assert.equal(describeEnv({ ready: true, state: 'LIVE' }).name, null, 'a status without a target names nothing, rather than repeating the item\'s own label beside it.');
  assert.equal(describeEnv({ target: 'admin', ready: true, state: 'INVENTED' }).word, 'ready',
    'a newer host inventing a state must not blank the item.');
  assert.equal(describeEnv({ target: 'admin', ready: false, state: 'INVENTED' }).word, 'not ready');
  assert.match(describeEnv({ target: 'a', ready: false, state: 'FAILED', reason: 'disk quota exceeded' }).title,
    /disk quota exceeded/u, 'the host’s own reason is carried verbatim, never reworded.');
});

await test('the left-hand word follows work first and the environment second', () => {
  assert.equal(describeOverall(null, 0).word, 'connecting');
  assert.equal(describeOverall({ ready: true, state: 'LIVE' }, 0).word, 'running');
  assert.equal(describeOverall({ ready: true, state: 'LIVE' }, 2).word, 'working', 'a turn in flight outranks a healthy environment.');
  assert.equal(describeOverall({ ready: true, state: 'LIVE' }, 2).title, '2 turns are running.');
  assert.equal(describeOverall({ ready: true, state: 'LIVE' }, 1).title, 'A turn is running.');
  assert.equal(describeOverall({ ready: false, state: 'FAILED' }, 0).word, 'problem');
  assert.equal(describeOverall({ ready: false, state: 'FAILED', reason: 'it stopped' }, 0).title, 'it stopped');
  assert.equal(describeOverall({ ready: false, state: 'SWITCHING' }, 0).word, 'updating');
  /* One frame, one answer. `state` decides and readiness only stands in for a state this does not
   * know, which is the order describeEnv reads them in too — reading readiness first made the bar
   * say "updating" at the left and "ready" three items along, about the same environment. */
  assert.equal(describeOverall({ state: 'LIVE' }, 0).word, 'running', 'a live environment that did not also say ready is still running.');
  assert.equal(describeEnv({ state: 'LIVE' }).word, describeOverall({ state: 'LIVE' }, 0).word === 'running' ? 'ready' : 'x');
  assert.equal(describeOverall({ ready: true }, 0).word, 'running', 'readiness alone still answers when no state was sent.');
});

await test('versions and counts are drawn only when the host actually sent them', () => {
  assert.equal(describeSetup(null), null);
  assert.equal(describeSetup({}), null);
  assert.equal(describeSetup({ setup: '' }), null, 'an empty string is an absent datum, not a version.');
  assert.equal(describeSetup({ setup: '1.4.2' }), '1.4.2');
  assert.equal(describeAgent({ agent: '1.0.0' }), '1.0.0');
  assert.equal(describeAgent({ agent: 4 }), null);
  assert.equal(describeCounts(null), null);
  assert.equal(describeCounts({ conversations: -1 }), null);
  assert.deepEqual(describeCounts({ conversations: 1, turns: 0 }),
    { open: '1', label: 'conversation', busy: null, title: '1 conversation open on this connection.' });
  assert.equal(describeCounts({ conversations: 3, turns: 2 }).label, 'conversations');
  assert.equal(describeCounts({ conversations: 3, turns: 2 }).busy, '2 working');
  assert.equal(describeCounts({ conversations: 3 }).busy, null, 'a host that counts no turns claims none.');
});

await test('sizes take one unit for the pair and lose their decimal where it would be noise', () => {
  assert.equal(figure(7.5 * GiB, GiB), '7.5');
  assert.equal(figure(16 * GiB, GiB), '16');
  assert.equal(figure(10 * GiB, GiB), '10', 'ten is the boundary, and takes the rounded form.');
  assert.equal(bytes(512), '512B');
  assert.equal(bytes(2048), '2.0K');
  assert.equal(bytes(5 * 1024 ** 2), '5.0M');
  assert.equal(bytes(4 * GiB), '4.0G');
});

await test('memory reports what is used against the whole machine, and refuses nonsense', () => {
  assert.equal(describeMemory(undefined), null);
  assert.equal(describeMemory({ memTotal: 0, memAvailable: 0 }), null);
  assert.equal(describeMemory({ memTotal: GiB, memAvailable: 2 * GiB }), null, 'more free than exists is not a reading.');
  const half = describeMemory({ memTotal: 16 * GiB, memAvailable: 8.5 * GiB });
  assert.equal(half.text, '7.5/16G');
  assert.equal(half.percent, 47);
  assert.equal(half.tone, null);
  assert.equal(describeMemory({ memTotal: 16 * GiB, memAvailable: 3 * GiB }).tone, 'warn');
  assert.equal(describeMemory({ memTotal: 16 * GiB, memAvailable: GiB }).tone, 'err');
  assert.match(describeMemory({ memTotal: 16 * GiB, memAvailable: 8 * GiB }).title, /still free/u);
});

await test('load is measured against the cores that can actually run it', () => {
  assert.equal(describeLoad(undefined), null);
  assert.equal(describeLoad({ load1: 1 }), null, 'a load average with no core count means nothing.');
  assert.equal(describeLoad({ load1: -1, cpus: 4 }), null);
  const idle = describeLoad({ load1: 0, cpus: 8 });
  assert.equal(idle.text, '0.00', 'an idle machine is a measurement, not a missing one.');
  assert.equal(idle.percent, 0);
  assert.equal(idle.tone, null);
  assert.equal(describeLoad({ load1: 2.84, cpus: 4 }).text, '2.84');
  assert.equal(describeLoad({ load1: 2.84, cpus: 4 }).percent, 71);
  assert.equal(describeLoad({ load1: 2.84, cpus: 4 }).tone, 'warn');
  assert.equal(describeLoad({ load1: 9, cpus: 4 }).tone, 'err');
  assert.equal(describeLoad({ load1: 9, cpus: 4 }).percent, 100, 'the meter never runs past its own width.');
  assert.match(describeLoad({ load1: 9, cpus: 4 }).title, /everything is slower/u);
  assert.match(describeLoad({ load1: 0.5, cpus: 1 }).title, /1 processor\./u);
});

await test('the log affordance is offered only where the host said output can be had', () => {
  assert.equal(canShowLogs(null), false);
  assert.equal(canShowLogs({ ready: true }), false);
  assert.equal(canShowLogs({ ready: true, logs: true }), true);
});

await test('a log line keeps the machine’s own words, bounded and timestamped', () => {
  const row = describeLogRow({ cursor: 4, at: Date.UTC(2026, 0, 2, 3, 4, 5), kind: 'process.start', data: { pid: 7 } }, 0);
  assert.match(row.at, /^\d{2}:\d{2}:\d{2}$/u);
  assert.equal(row.kind, 'process.start');
  assert.equal(row.detail, 'pid=7');
  assert.equal(describeLogRow({ cursor: 9, at: 12, kind: 'x', data: {} }, 3).at, '#9',
    'a stamp that cannot be a date shows the line number rather than 1970.');
  assert.equal(describeLogRow({ at: 12 }, 3).at, '#3');
  assert.equal(describeLogRow({}, 0).kind, '');
  assert.equal(logDetail(null), '');
  assert.equal(logDetail('text'), '');
  assert.equal(logDetail({ a: { b: 1 } }), 'a={"b":1}');
  const long = logDetail({ note: 'x'.repeat(400) });
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'), 'an over-long line is cut, not wrapped.');
});

await test('the log panel always says something, including when there is nothing', () => {
  assert.deepEqual(describeLogs(null), { note: 'Asking the environment for recent activity…', rows: [] });
  assert.deepEqual(describeLogs({ rows: [] }).rows, []);
  assert.match(describeLogs({ rows: [] }).note, /has not recorded anything yet/u);
  const some = describeLogs({ rows: [{ cursor: 1, at: 1, kind: 'a', data: {} }], truncated: false });
  assert.equal(some.rows.length, 1);
  assert.match(some.note, /all 1 recorded lines/u);
  assert.match(describeLogs({ rows: [{ cursor: 1, at: 1, kind: 'a', data: {} }], truncated: true }).note, /older ones/u);
});

/* The house rule for this screen, enforced rather than trusted. Every string the module can hand to
 * the bar is collected and searched for the words the system uses for its own internals — they
 * belong in comments, commit messages and ADRs, and nowhere a person reads. The log rows are the
 * documented exception and are not collected: they are the environment's own output, shown
 * verbatim for the same reason views/environment.js never rewords a failure reason. */
await test('nothing this bar can say teaches a person the system’s private vocabulary', () => {
  const said = [];
  const collect = value => {
    if (typeof value === 'string') said.push(value);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
  };
  for (const state of ['LIVE', 'QUIESCING', 'FROZEN', 'APPLYING', 'PROBING', 'SWITCHING', 'DRAINING', 'ROLLING_BACK', 'FAILED', 'INVENTED']) {
    for (const ready of [true, false]) {
      collect(describeEnv({ target: 'admin', ready, state }));
      collect(describeOverall({ ready, state }, 0));
      collect(describeOverall({ ready, state }, 1));
    }
  }
  collect(describeOverall(null, 0));
  collect(describeCounts({ conversations: 2, turns: 1 }));
  collect(describeMemory({ memTotal: 16 * GiB, memAvailable: GiB }));
  collect(describeLoad({ load1: 9, cpus: 4 }));
  collect(describeLogs(null));
  collect(describeLogs({ rows: [], truncated: true }));
  assert.ok(said.length > 20, 'the sweep must actually reach the strings it is judging.');
  for (const word of ['generation', 'drain', 'probe', 'digest', 'socket', 'envelope', 'profile', 'ADR', 'kernel', 'quiesc']) {
    for (const line of said) assert.doesNotMatch(line, new RegExp(word, 'iu'), `"${line}" uses the word "${word}".`);
  }
});
