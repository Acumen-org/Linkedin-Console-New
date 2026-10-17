import assert from 'node:assert/strict';
import test from 'node:test';
import { createExclusiveRunner } from '../src/bridge/context.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('runPendingHigh lets a waiting send run from inside a long job (no hang during a sync)', async () => {
  const ex = createExclusiveRunner();
  const order: string[] = [];
  await ex(async () => {
    order.push('sync-start');
    // A teammate's send arrives mid-sync: it queues as a 'high' job behind the running sync.
    const sendDone = ex(async () => order.push('send'), 'high');
    await tick();
    assert.equal(ex.highPending(), true, 'the send is waiting');
    await ex.runPendingHigh(); // the sync hands over at a safe point
    assert.equal(ex.highPending(), false, 'the send ran');
    order.push('sync-resume');
    await sendDone;
  });
  assert.deepEqual(order, ['sync-start', 'send', 'sync-resume']);
});

test('queued high runs before queued normal', async () => {
  const ex = createExclusiveRunner();
  const order: string[] = [];
  const first = ex(async () => {
    order.push('first');
    await tick();
  });
  const normal = ex(async () => order.push('normal'));
  const high = ex(async () => order.push('high'), 'high');
  await Promise.all([first, normal, high]);
  assert.deepEqual(order, ['first', 'high', 'normal']);
});

test('runPendingHigh is a no-op when nothing is waiting', async () => {
  const ex = createExclusiveRunner();
  assert.equal(ex.highPending(), false);
  await ex.runPendingHigh();
  assert.equal(ex.highPending(), false);
});
