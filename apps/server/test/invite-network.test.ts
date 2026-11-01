import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { inviteNetwork } from '../src/invite-network';

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address, internal, family: 'IPv4', netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`,
});
const listener = (address = '0.0.0.0'): AddressInfo => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: 5186 });

describe('实际监听与局域网分享地址', () => {
  it('从 localhost 进入时仍提供真实 LAN IP，物理私网优先，排除回环、链路本地与重复地址', () => {
    const view = inviteNetwork(listener(), {
      singbox_tun: [v4('172.18.0.1')], WLAN: [v4('192.168.31.57')],
      'vEthernet (WSL)': [v4('172.31.112.1')], duplicate: [v4('192.168.31.57')],
      loopback: [v4('127.0.0.1', true)], broken: [v4('169.254.1.2'), v4('0.0.0.0'), v4('224.0.0.1')],
    });
    expect(view.loopbackOnly).toBe(false);
    expect(view.addresses.map((a) => a.origin)).toEqual([
      'http://192.168.31.57:5186', 'http://172.18.0.1:5186', 'http://172.31.112.1:5186',
    ]);
    expect(view.addresses.every((a) => !a.origin.includes('localhost'))).toBe(true);
  });

  it.each(['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1'])('仅绑定 %s 时不发布网卡上的无效邀请', (bound) => {
    expect(inviteNetwork(listener(bound), { WLAN: [v4('192.168.31.57')] })).toEqual({ loopbackOnly: true, addresses: [] });
  });

  it('只绑定某张网卡时不能推荐其他网卡，且使用真正监听的端口', () => {
    expect(inviteNetwork({ ...listener('192.168.1.4'), port: 6000 }, { WLAN: [v4('192.168.2.4')] })).toEqual({
      loopbackOnly: false, addresses: [{ label: '192.168.1.4', origin: 'http://192.168.1.4:6000' }],
    });
  });

  it('双栈监听提供 IPv4 地址，断网不编造地址', () => {
    expect(inviteNetwork(listener('::'), { WLAN: [v4('10.0.0.5')] }).addresses[0].origin).toBe('http://10.0.0.5:5186');
    expect(inviteNetwork(listener(), { loopback: [v4('127.0.0.1', true)] }).addresses).toEqual([]);
  });
});
