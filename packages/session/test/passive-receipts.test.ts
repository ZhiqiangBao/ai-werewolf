import { expect, it } from 'vitest';
import { ReceiptLedger, type Receipt } from '../src/experiments/passive-receipts';

it('reconciles failed work after reload without creating a successful native response', () => {
  const first: Receipt = { room: 'r', seat: '1', from: 1, through: 2, cue: 'cue', policy: 'B', status: 'terminal_failed', native: [], reason: 'retry_budget_exhausted' };
  const ledger = new ReceiptLedger(); expect(ledger.apply(first)).toBe('recorded');
  const restored = new ReceiptLedger(ledger.snapshot()); expect(restored.processedThrough('r', '1')).toBe(2);
  expect(restored.apply(first)).toBe('already_recorded');
  expect(() => restored.apply({ ...first, status: 'succeeded', native: ['invented'] })).toThrow('mismatch');
  expect(() => restored.apply({ ...first, from: 4, through: 4 })).toThrow('gap');
  expect(() => restored.apply({ ...first, from: 3, through: 3, native: ['fake'] })).toThrow('failed receipt');
  expect(restored.apply({ ...first, from: 3, through: 3, status: 'expired', reason: 'window_closed' })).toBe('recorded');
});
it('rebuilds only the unprocessed portion from immutable engine event ranges', () => {
  const events = Object.freeze([1, 2, 3, 4]);
  const receipt: Receipt = { room: 'r', seat: '1', from: 1, through: 2, cue: 'cue', policy: 'B', status: 'succeeded', native: ['assistant', 'tool-result'] };
  const prior = new ReceiptLedger(); prior.apply(receipt);
  const restored = new ReceiptLedger(prior.snapshot());
  expect(events.filter(seq => seq > restored.processedThrough('r', '1'))).toEqual([3, 4]);
  expect(restored.apply(receipt)).toBe('already_recorded');
});
