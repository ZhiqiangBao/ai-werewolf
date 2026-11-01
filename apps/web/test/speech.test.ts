import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/protocol';
import { publicSpeech, SpeechCursor } from '../src/speech';

const speech = (seq: number, audience: GameEvent['audience'] = 'public', type = 'speech'): GameEvent => ({
  seq, audience, type, day: 1, phase: 'day', text: '', payload: { seat: 2, content: `发言${seq}` },
});

describe('公开发言朗读队列', () => {
  it('只读取法官接受的公开 speech，不读取密谈、私密事件或思考', () => {
    expect(publicSpeech([speech(1), speech(2, [2]), speech(3, 'public', 'wolf.chat'), speech(4, 'public', 'thought')]))
      .toEqual([{ seq: 1, seat: 2, text: '发言1' }]);
  });
  it('首次载入跳过历史，新发言按顺序入队，重连与重复推送不重读', () => {
    const cursor = new SpeechCursor();
    expect(cursor.sync(publicSpeech([speech(1)]), true)).toEqual([]);
    expect(cursor.sync(publicSpeech([speech(1), speech(3), speech(5)]), true).map((s) => s.seq)).toEqual([3, 5]);
    expect(cursor.sync(publicSpeech([speech(1), speech(3), speech(5)]), true)).toEqual([]);
  });
  it('关闭朗读时仍定位到最新记录，重新开启不会补读关闭期间的积压', () => {
    const cursor = new SpeechCursor();
    cursor.sync(publicSpeech([speech(1)]), false);
    expect(cursor.sync(publicSpeech([speech(1), speech(2)]), false)).toEqual([]);
    expect(cursor.sync(publicSpeech([speech(1), speech(2), speech(3)]), true).map((s) => s.seq)).toEqual([3]);
  });
});
