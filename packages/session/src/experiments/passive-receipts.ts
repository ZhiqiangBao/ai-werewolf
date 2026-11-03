import { createHash } from 'node:crypto';

export type Receipt = { room: string; seat: string; from: number; through: number; cue: string; policy: string; status: 'succeeded' | 'terminal_failed' | 'expired'; native: string[]; reason?: string };
export const receiptKey = (r: Receipt): string => createHash('sha256').update(JSON.stringify([r.room, r.seat, r.from, r.through, r.cue, r.policy])).digest('hex');

/** In-memory reconciliation model; durable atomic commits are not implemented. */
export class ReceiptLedger {
  private readonly records = new Map<string, Receipt>();
  private readonly cursors = new Map<string, number>();
  constructor(saved: Receipt[] = []) { for (const receipt of saved) this.apply(receipt); }
  processedThrough(room: string, seat: string): number { return this.cursors.get(JSON.stringify([room, seat])) ?? 0; }
  apply(input: Receipt): 'recorded' | 'already_recorded' {
    const r = structuredClone(input);
    if (!r.room || !r.seat || !r.cue || !r.policy || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.through) || r.from < 1 || r.through < r.from || !['succeeded', 'terminal_failed', 'expired'].includes(r.status) || !Array.isArray(r.native) || r.native.some(v => typeof v !== 'string')) throw new Error('invalid receipt');
    if (r.status !== 'succeeded' && r.native.length !== 0) throw new Error('failed receipt contains native output');
    const key = receiptKey(r); const existing = this.records.get(key);
    if (existing) {
      if (JSON.stringify([existing.status, existing.native, existing.reason ?? null]) !== JSON.stringify([r.status, r.native, r.reason ?? null])) throw new Error('receipt mismatch');
      return 'already_recorded';
    }
    const cursorKey = JSON.stringify([r.room, r.seat]);
    if (r.from !== (this.cursors.get(cursorKey) ?? 0) + 1) throw new Error('receipt gap or overlap');
    this.records.set(key, r); this.cursors.set(cursorKey, r.through); return 'recorded';
  }
  snapshot(): Receipt[] { return structuredClone([...this.records.values()]); }
}
