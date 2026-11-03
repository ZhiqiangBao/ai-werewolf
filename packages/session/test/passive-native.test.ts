import { expect, it } from 'vitest';
import { anthropicInput, chatMessages, protocolBinding, responsesInput, type AdapterConfig, type TranscriptMessage } from '@werewolf/llm';
import { historyIds, nativeItems, type Protocol } from '../src/experiments/passive-loopback';

it.each(['chat-completions', 'responses', 'anthropic-messages'] as const)('preserves %s native continuation and call receipt per seat', (protocol: Protocol) => {
  const apiProtocol = protocol === 'chat-completions' ? 'chat_completions' : protocol === 'anthropic-messages' ? 'anthropic_messages' : 'responses';
  const config: AdapterConfig = { apiProtocol, baseUrl: 'http://127.0.0.1:1234/v1', model: 'stub', apiKey: null, temperature: 0, timeoutSec: 3, toolMode: 'tools' };
  const build = (seat: number) => {
    const id = `seat-${seat}`; const items = nativeItems(protocol, id).slice(0, -1).map(s => JSON.parse(s));
    const history: TranscriptMessage[] = [
      { role: 'user', content: `only-seat-${seat}` },
      { role: 'assistant', content: null, calls: [{ id, name: 'listen', arguments: '{}' }], ...(apiProtocol === 'chat_completions' ? {} : { native: { protocol: apiProtocol, binding: protocolBinding(config), items } }) },
      { role: 'tool', callId: id, content: 'ok' },
    ];
    return apiProtocol === 'chat_completions' ? chatMessages(history) : apiProtocol === 'responses' ? responsesInput(history, config) : anthropicInput(history, config).messages;
  };
  const one = JSON.stringify(build(1)); const two = JSON.stringify(build(2));
  expect(historyIds(build(1))).toEqual(['seat-1', 'seat-1']);
  expect(one).toContain('seat-1'); expect(one).not.toContain('seat-2'); expect(two).not.toContain('seat-1');
  if (protocol === 'anthropic-messages') expect(one).toContain('sig-seat-1');
  expect(one.indexOf('listen')).toBeLessThan(one.lastIndexOf('seat-1'));
});
