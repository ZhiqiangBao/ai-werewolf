import { describe, expect, it } from 'vitest';
import { automaticInviteBase, inviteBase, sharedInvite } from '../src/invites';

const network = { loopbackOnly: false, addresses: [{ label: 'WLAN', origin: 'http://192.168.31.57:5192' }] };

describe('跨设备邀请', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('房主从 %s 打开时自动使用局域网地址，保留部署路径', (host) => {
    const base = automaticInviteBase(`http://${host}:5192/game/#/host/fixture/host-secret`, network)!;
    expect(base).toBe('http://192.168.31.57:5192/game/');
    expect(sharedInvite(base, 'seat', 'fixture', 'seat-secret')).toBe('http://192.168.31.57:5192/game/#/seat/fixture/seat-secret');
    expect(sharedInvite(base, 'watch', 'fixture', 'watch-secret')).not.toContain('host-secret');
  });

  it('外部域名、HTTPS 和反向代理子路径保持可访问的当前地址', () => {
    expect(automaticInviteBase('https://game.example/play/#/host/fixture/secret', network)).toBe('https://game.example/play/');
    expect(automaticInviteBase('https://game.example/play/#/host/fixture/secret', null)).toBe('https://game.example/play/');
    expect(inviteBase(' https://game.example:8443/play/ ')).toBe('https://game.example:8443/play/');
  });

  it('没有可用 LAN 地址或仅本机监听时不给出默认分享链接', () => {
    const page = 'http://localhost:5192/#/host/fixture/secret';
    expect(automaticInviteBase(page, null)).toBeNull();
    expect(automaticInviteBase(page, { loopbackOnly: true, addresses: [] })).toBeNull();
    expect(automaticInviteBase(page, { loopbackOnly: false, addresses: [] })).toBeNull();
  });

  it.each(['localhost', 'localhost.', 'a.localhost', '127.1', '127.0.0.1', '0.0.0.0', '[::1]', '[::]', '[::ffff:127.0.0.1]'])('拒绝把本机地址 %s 编码成跨设备邀请', (host) => {
    expect(() => inviteBase(`http://${host}:5192/`)).toThrow('本机地址');
  });

  it.each(['javascript:alert(1)', 'file:///C:/game', 'http://user:pass@game.example/', 'http://game.example/?token=secret', 'http://game.example/#/host/r/secret', '192.168.1.2:5192', ''])('拒绝非法或夹带凭证的网址 %s', (value) => {
    expect(() => inviteBase(value)).toThrow();
  });
});
