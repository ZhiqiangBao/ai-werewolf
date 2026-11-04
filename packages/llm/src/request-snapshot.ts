import type { ModelRequestInfo } from '@werewolf/protocol';
import { protocolBinding } from './transcript';
import type { DecideRequest } from './types';

/** Capture only the encoded request, never the authentication headers or config. */
export function requestSnapshot(req: DecideRequest, endpoint: string, body: Record<string, unknown>, info: ModelRequestInfo): ModelRequestInfo {
  const { replay: _previous, ...original } = info;
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) return original;
    return { ...original, replay: { endpoint, body: structuredClone(body), binding: protocolBinding({ ...req.config, apiProtocol: info.apiProtocol }), timeoutSec: req.config.timeoutSec } };
  } catch {
    // Recording is best effort and must never interfere with the actual request.
    return original;
  }
}
