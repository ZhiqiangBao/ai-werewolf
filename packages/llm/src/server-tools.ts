import { serverWebToolSupport, type ServerWebTool, type ServerWebToolsConfig } from '@werewolf/protocol';
import type { AdapterConfig } from './types';

export function effectiveServerWebTools(config: AdapterConfig): ServerWebToolsConfig {
  return config.serverWebTools ?? { search: false, extractor: false };
}

export function nativeServerTools(config: AdapterConfig): Record<string, unknown>[] {
  const selected = effectiveServerWebTools(config);
  const support = serverWebToolSupport(config.baseUrl, config.model, config.apiProtocol ?? 'responses', config.thinkingMode);
  const names: ServerWebTool[] = [];
  if (selected.search && support.search === 'supported') names.push('web_search');
  if (selected.extractor && selected.search && support.extractor === 'supported') names.push('web_extractor');
  if ((config.apiProtocol ?? 'responses') === 'anthropic_messages') {
    return names.map((name) => name === 'web_search'
      ? { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
      : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 });
  }
  return names.map((type) => ({ type }));
}

export function nativeServerToolNames(config: AdapterConfig): ServerWebTool[] {
  return nativeServerTools(config).map((tool) => tool.type === 'web_fetch_20250910' ? 'web_extractor' : 'web_search') as ServerWebTool[];
}
