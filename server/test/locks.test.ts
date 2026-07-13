import assert from 'node:assert/strict';
import test from 'node:test';
import { SubtreeLockManager } from '../src/sync/locks.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('subtree locks block ancestors/case-fold aliases but allow independent paths', async () => {
  const locks = new SubtreeLockManager();
  const releaseParent = await locks.acquire(['Folder']);
  let childAcquired = false;
  const child = locks.acquire(['folder/A.md']).then((release) => { childAcquired = true; return release; });
  const independent = await locks.acquire(['Other.md']);
  await tick();
  assert.equal(childAcquired, false);
  independent();
  releaseParent();
  (await child)();
  assert.equal(childAcquired, true);
});

test('subtree locks preserve order among conflicting waiters', async () => {
  const locks = new SubtreeLockManager();
  const first = await locks.acquire(['A']);
  const order: number[] = [];
  const second = locks.acquire(['A/B']).then((release) => { order.push(2); return release; });
  const third = locks.acquire(['a']).then((release) => { order.push(3); return release; });
  first();
  const releaseSecond = await second;
  await tick();
  assert.deepEqual(order, [2]);
  releaseSecond();
  (await third)();
  assert.deepEqual(order, [2, 3]);
});
