import assert from 'node:assert/strict';
import test from 'node:test';
import { csvRecords, csvRows } from '../src/lib/csv.ts';

test('quoted fields: commas, escaped quotes and line breaks inside', () => {
  const rows = [...csvRows('a,"b, c","say ""hi""","line 1\nline 2"\r\nx,y,z,w\n')];
  assert.deepEqual(rows, [
    ['a', 'b, c', 'say "hi"', 'line 1\nline 2'],
    ['x', 'y', 'z', 'w'],
  ]);
});

test('byte order mark and a last line without newline', () => {
  assert.deepEqual(
    [...csvRows('﻿h1,h2\n1,2')],
    [
      ['h1', 'h2'],
      ['1', '2'],
    ],
  );
});

test('finds the header after a notes preamble (as in Connections.csv), keys are lower case', () => {
  const text =
    'Notes:\n"When exporting your connection data, you may notice..."\n\nFirst Name,Last Name,URL,Connected On\nJane,Doe,https://www.linkedin.com/in/jane,08 Oct 2026\n\n';
  const parsed = csvRecords(text, ['First Name', 'URL']);
  assert.ok(parsed);
  assert.deepEqual(
    [...parsed.records],
    [{ 'first name': 'Jane', 'last name': 'Doe', url: 'https://www.linkedin.com/in/jane', 'connected on': '08 Oct 2026' }],
  );
});

test('no header with the required columns → null', () => {
  assert.equal(csvRecords('a,b\n1,2\n', ['URL']), null);
});
