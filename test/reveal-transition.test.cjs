const test = require('node:test');
const assert = require('node:assert/strict');

async function loadTransition() {
  return import('../src/hooks/revealTransition.mjs');
}

test('switching sessions resets the reveal counter before any flush', async () => {
  const { nextRevealCount } = await loadTransition();
  const previous = { revealKey: 'session-main', flushKey: 2 };
  assert.equal(
    nextRevealCount(previous, { revealKey: 'session-store', flushKey: 0, messageCount: 6 }),
    0,
  );
});

test('a new flush key reveals every queued message at once', async () => {
  const { nextRevealCount } = await loadTransition();
  const previous = { revealKey: 'session-main', flushKey: 0 };
  assert.equal(
    nextRevealCount(previous, { revealKey: 'session-main', flushKey: 1, messageCount: 9 }),
    9,
  );
});

test('appending messages without a flush keeps the sequential cadence', async () => {
  const { nextRevealCount } = await loadTransition();
  const previous = { revealKey: 'session-main', flushKey: 1 };
  assert.equal(
    nextRevealCount(previous, { revealKey: 'session-main', flushKey: 1, messageCount: 10 }),
    null,
  );
});