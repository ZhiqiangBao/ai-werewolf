import { isIP, type AddressInfo } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { InviteNetworkView } from '@werewolf/protocol';

export const DEFAULT_HOST = '0.0.0.0';

const virtualAdapter = /virtual|vethernet|wsl|hyper-v|vmware|vbox|docker|tun|tap|vpn|tailscale|wireguard|singbox/i;
const loopback = (host: string) => host === '::1' || /^(?:::ffff:)?127\./.test(host);
const usableV4 = (host: string) => isIP(host) === 4 && !/^(?:0|127)\./.test(host)
  && !host.startsWith('169.254.') && Number(host.split('.')[0]) < 224;
const privateV4 = (host: string) => /^(?:10\.|192\.168\.)/.test(host)
  || (host.startsWith('172.') && Number(host.split('.')[1]) >= 16 && Number(host.split('.')[1]) <= 31);
const origin = (host: string, port: number) => `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** 使用实际监听地址与端口；不信任 Host / Forwarded 头，不把回环地址冒充分享地址。 */
export function inviteNetwork(
  listener: AddressInfo,
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): InviteNetworkView {
  const bound = listener.address;
  if (loopback(bound)) return { loopbackOnly: true, addresses: [] };
  if (bound !== '0.0.0.0' && bound !== '::') {
    const usable = usableV4(bound) || (isIP(bound) === 6 && !bound.startsWith('fe80:') && !bound.includes('%'));
    return { loopbackOnly: false, addresses: usable ? [{ label: bound, origin: origin(bound, listener.port) }] : [] };
  }
  const candidates = Object.entries(interfaces).flatMap(([name, values]) => (values ?? [])
    .filter((value) => value.family === 'IPv4' && !value.internal && usableV4(value.address))
    .map((value) => ({ name, address: value.address, rank: (virtualAdapter.test(name) ? 2 : 0) + (privateV4(value.address) ? 0 : 1) })))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
  const seen = new Set<string>();
  const addresses = candidates.filter((c) => {
    if (seen.has(c.address)) return false;
    seen.add(c.address);
    return true;
  })
    .map((c) => ({ label: `${c.name} · ${c.address}`, origin: origin(c.address, listener.port) }));
  return { loopbackOnly: false, addresses };
}
