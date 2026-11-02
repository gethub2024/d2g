import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatRow,
  generateSnowflake,
  snowflakeToTimestamp,
  isOlderThan48h,
  compareByMessageId,
  formatAuditDateTime,
} from '../src/lib.js';

const HOUR = 60 * 60 * 1000;

test('formatRow builds a DA/DT row in Asia/Kolkata time', () => {
  const msg = {
    id: '1498917646442168340',
    content: 'Apr 29\nMaths one module complete',
    createdAt: new Date('2026-04-29T05:23:35Z'),
    author: { username: 'shenky0433' },
  };

  assert.deepEqual(formatRow(msg), [
    'shenky0433',
    'Apr 29\nMaths one module complete',
    '29/04/2026',
    '10:53:35 AM',
    '1498917646442168340',
  ]);
});

test('formatRow keeps empty content as an empty string', () => {
  const row = formatRow({
    id: '1',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    author: { username: 'someone' },
  });
  assert.equal(row[1], '');
});

test('generateSnowflake and snowflakeToTimestamp round-trip', () => {
  const ts = 1770000000000;
  assert.equal(snowflakeToTimestamp(generateSnowflake(ts)), BigInt(ts));
});

test('generateSnowflake returns 0 for the Discord epoch', () => {
  assert.equal(generateSnowflake(1420070400000), '0');
});

test('isOlderThan48h respects the 48 hour boundary', () => {
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);

  const fortyNineHoursAgo = generateSnowflake(now - 49 * HOUR);
  const fortySevenHoursAgo = generateSnowflake(now - 47 * HOUR);

  assert.equal(isOlderThan48h(fortyNineHoursAgo, now), true);
  assert.equal(isOlderThan48h(fortySevenHoursAgo, now), false);
});

test('compareByMessageId sorts numerically, not alphabetically', () => {
  const rows = [['u', 'c', 'd', 't', '10'], ['u', 'c', 'd', 't', '2']];
  const sorted = [...rows].sort(compareByMessageId);
  assert.equal(sorted[0][4], '2');
  assert.equal(sorted[1][4], '10');
});

test('compareByMessageId pushes rows without an ID to the bottom', () => {
  const rows = [
    ['u', 'c', 'd', 't', ''],
    ['u', 'c', 'd', 't', '5'],
    ['u', 'c', 'd', 't', undefined],
  ];
  const sorted = [...rows].sort(compareByMessageId);
  assert.equal(sorted[0][4], '5');
});

test('compareByMessageId leaves unparsable IDs in place', () => {
  assert.equal(compareByMessageId(['u', 'c', 'd', 't', 'abc'], ['u', 'c', 'd', 't', '5']), 0);
});

test('formatAuditDateTime matches the PIT sheet format', () => {
  assert.equal(
    formatAuditDateTime(new Date('2026-04-29T05:23:35Z')),
    '29/04/2026 10:53:35 AM',
  );
});
