import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdownOpenings } from '../../analysis/markdown.js';

/**
 * Each line with what it starts inside, as text: "3 ```dart" is line 3 inside a Dart code block,
 * "1 top" the first line, "2 text" a line after it outside them all.
 */
const shown = (lines: string[]) => markdownOpenings(lines.join('\n')).map((open, i) => `${i + 1} ${open.trim() ? open : open ? 'text' : 'top'}`).join('\n');

describe('Given a Markdown file, ', () => {
  it(
    'when code blocks open, between backticks or tildes, with a language or none, '
    + 'then each line inside one starts inside its opening line, up to the fence that closes it.',
    () => {
      assert.equal(shown(['# Admin', '```dart', 'await a();', '```', '', '~~~', 'plain', '~~~', 'after']), [
        '1 top', '2 text', '3 ```dart', '4 ```dart', '5 text', '6 text', '7 ~~~', '8 ~~~', '9 text',
      ].join('\n'));
    },
  );

  it(
    'when a block opens with four backticks, and another indented in a list, '
    + 'then three backticks don’t close the first, and the second closes at its own indent.',
    () => {
      assert.equal(shown(['````md', '```dart', '```', '````', '1. Run it:', '   ```bash', '   dart run', '   ```', 'done']), [
        '1 top', '2 ````md', '3 ````md', '4 ````md', '5 text', '6 text', '7    ```bash', '8    ```bash', '9 text',
      ].join('\n'));
    },
  );

  it(
    'when front matter opens the file, and a comment runs over several lines, '
    + 'then their lines start inside them up to their ends, a fence inside either opens nothing, and dashes further down are no front matter.',
    () => {
      assert.equal(shown(['---', 'title: Admin', '```', '---', '<!-- old:', '```dart', '-->', '<!-- one line -->', '```', 'x', '```', '---', 'after']), [
        '1 top', '2 ---', '3 ---', '4 ---', '5 text', '6 <!-- old:', '7 <!-- old:', '8 text', '9 text', '10 ```', '11 ```', '12 text', '13 text',
      ].join('\n'));
    },
  );
});
