/** Exercise the terminal renderer against the sequences a piped command actually emits.
 *
 * These are the cases that decided against vendoring an emulator: a carriage return rewriting a
 * progress line, a backspace, a tab stop, SGR colour and its reset, an erase-to-end-of-line, and an
 * escape sequence cut in half by a read boundary. If any of them were wrong the screen would fill
 * with escape soup, which is the failure mode the library exists to prevent — so they are tested
 * rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { blank, hex, limits, styleOf, textOf, write } from './surface/screen.js';

const ESC = '\u001b';

await test('the characters a shell writes land where a terminal would put them', () => {
  const screen = blank();
  write(screen, 'one\r\ntwo\n');
  write(screen, 'downloading 10%\rdownloading 100%\n');
  write(screen, 'ab\bc\n');
  write(screen, 'a\tb\n');
  assert.equal(textOf(screen), 'one\ntwo\ndownloading 100%\nac\na       b\n');
});

await test('colour is carried until it is reset, and never reaches the text itself', () => {
  const screen = blank();
  write(screen, `${ESC}[32mgreen${ESC}[0m plain\n`);
  assert.equal(textOf(screen), 'green plain\n');
  const coloured = screen.lines[0]?.keys ?? [];
  assert.equal(coloured[0], '2|-1|0', 'green is foreground colour two');
  assert.equal(coloured[6], '-1|-1|0', 'the reset puts the rest back to plain');
  assert.deepEqual(styleOf('2|-1|1'), { classes: ['bold', 'f-green'], literal: {} });
  assert.deepEqual(styleOf('-1|-1|16').literal, { color: 'var(--term-bg)', 'background-color': 'var(--term-fg)' });
});

await test('a colour outside the sixteen named ones resolves to a literal the CSP allows', () => {
  assert.equal(hex(196), '#ff0000');
  assert.equal(hex(232), '#080808');
  assert.equal(styleOf('196|-1|0').literal['color'], '#ff0000');
  const screen = blank();
  write(screen, `${ESC}[38;2;18;52;86mtrue${ESC}[m\n`);
  assert.equal(styleOf(screen.lines[0]?.keys[0] ?? '').literal['color'], '#123456');
});

await test('erasing a line and the screen clears what a command expects to have cleared', () => {
  const screen = blank();
  write(screen, `keep this\rgone${ESC}[K\n`);
  assert.equal(textOf(screen), 'gone\n');
  write(screen, `and more${ESC}[2J`);
  assert.equal(textOf(screen), '');
});

await test('a sequence split across two reads is finished by the next one, not printed', () => {
  const screen = blank();
  write(screen, `red${ESC}[3`);
  assert.equal(textOf(screen), 'red');
  write(screen, '1mtail');
  assert.equal(textOf(screen), 'redtail');
  assert.equal(screen.lines[0]?.keys[3], '1|-1|0');
});

await test('what a command means for a screen this does not have is dropped, not drawn', () => {
  const screen = blank();
  write(screen, `${ESC}[?25lhidden${ESC}[?25h${ESC}]0;a window title after\n`);
  assert.equal(textOf(screen), 'hidden after\n');
});

await test('scrollback is bounded, so a command that never stops cannot fill the tab', () => {
  const screen = blank();
  write(screen, 'line\n'.repeat(limits.lines + 500));
  assert.equal(screen.lines.length, limits.lines);
  assert.ok(screen.row < limits.lines);
});
