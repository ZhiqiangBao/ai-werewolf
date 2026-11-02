import type { ApiProtocol } from '@werewolf/protocol';

export type ContentKind = 'reply' | 'thinking' | 'tool_name' | 'tool_arguments';

/** Only classify content already processed by the protocol parser; never retain it. */
export function streamContentKind(protocol: ApiProtocol, event: any): ContentKind | undefined {
  const nonempty = (value: unknown) => typeof value === 'string' && value.length > 0;
  if (protocol === 'chat_completions') {
    const delta = event?.choices?.[0]?.delta ?? event?.choices?.[0]?.message;
    if (nonempty(delta?.reasoning_content) || nonempty(delta?.reasoning) || nonempty(delta?.thinking)) return 'thinking';
    if (nonempty(delta?.content)) return 'reply';
    for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      if (nonempty(call?.function?.name)) return 'tool_name';
      if (nonempty(call?.function?.arguments)) return 'tool_arguments';
    }
  } else if (protocol === 'responses') {
    if ((event?.type === 'response.reasoning_summary_text.delta' || event?.type === 'response.reasoning_text.delta') && nonempty(event.delta)) return 'thinking';
    if (event?.type === 'response.output_text.delta' && nonempty(event.delta)) return 'reply';
    if (event?.type === 'response.function_call_arguments.delta' && nonempty(event.delta)) return 'tool_arguments';
    if ((event?.type === 'response.output_item.added' || event?.type === 'response.output_item.done') && event.item?.type === 'function_call') {
      if (nonempty(event.item.name)) return 'tool_name';
      if (nonempty(event.item.arguments)) return 'tool_arguments';
    }
  } else {
    if (event?.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use' && nonempty(block.name)) return 'tool_name';
      if (block?.type === 'text' && nonempty(block.text)) return 'reply';
      if (block?.type === 'thinking' && nonempty(block.thinking)) return 'thinking';
    }
    if (event?.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && nonempty(delta.text)) return 'reply';
      if (delta?.type === 'thinking_delta' && nonempty(delta.thinking)) return 'thinking';
      if (delta?.type === 'input_json_delta' && nonempty(delta.partial_json)) return 'tool_arguments';
    }
  }
  return undefined;
}

export interface UsagePresence {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  completeness: 'complete' | 'partial' | 'unknown';
}

/** Successive usage snapshots overwrite fields rather than adding cumulative values. */
export class UsageSnapshot {
  private input: number | null = null;
  private output: number | null = null;
  private read: number | null = null;
  private write: number | null = null;

  constructor(private readonly protocol: ApiProtocol) {}

  merge(raw: any): void {
    if (!raw || typeof raw !== 'object') return;
    const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const input = count(this.protocol === 'chat_completions' ? raw.prompt_tokens : raw.input_tokens);
    const output = count(this.protocol === 'chat_completions' ? raw.completion_tokens : raw.output_tokens);
    const read = count(this.protocol === 'chat_completions' ? raw.prompt_tokens_details?.cached_tokens : this.protocol === 'responses' ? raw.input_tokens_details?.cached_tokens : raw.cache_read_input_tokens);
    const write = count(raw.cache_creation_input_tokens);
    if (input !== null) this.input = input;
    if (output !== null) this.output = output;
    if (read !== null) this.read = read;
    if (write !== null) this.write = write;
  }

  value(): UsagePresence {
    // Anthropic's input_tokens excludes both cache categories. Missing categories
    // cannot be assumed zero when reporting the normalized input total.
    const inputTokens = this.protocol === 'anthropic_messages'
      ? this.input !== null && this.read !== null && this.write !== null ? this.input + this.read + this.write : null
      : this.input;
    const fields = [inputTokens, this.output, this.read, this.write];
    return { inputTokens, outputTokens: this.output, cacheReadTokens: this.read, cacheWriteTokens: this.write,
      completeness: fields.every((v) => v !== null) ? 'complete' : fields.some((v) => v !== null) ? 'partial' : 'unknown' };
  }
}
