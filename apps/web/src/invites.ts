import type { InviteNetworkView } from '@werewolf/protocol';

export function localOnlyInvite(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname)
    || ['0.0.0.0', '[::1]', '[::]', '[::ffff:0:0]'].includes(hostname) || /^\[::ffff:7f[\da-f]{2}:/.test(hostname);
}

/** 只接受服务的分享网址，不能误贴房间凭证、查询参数或脚本 URL。 */
export function inviteBase(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写完整的 http:// 或 https:// 访问网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请填写服务访问网址，不要附带账号、查询参数或房间邀请后缀。');
  }
  if (localOnlyInvite(url.href)) throw new Error('这是本机地址，其他设备无法用它加入。请选择局域网地址或填写其他可访问的网址。');
  return `${url.origin}${url.pathname}`;
}

/** 外部域名／反向代理沿用当前路径；从 localhost 打开时自动改用服务端发现的局域网地址。 */
export function automaticInviteBase(page: string, network: InviteNetworkView | null): string | null {
  const url = new URL(page);
  if (!localOnlyInvite(page)) return inviteBase(`${url.origin}${url.pathname}`);
  const address = network?.addresses[0];
  return address ? inviteBase(`${address.origin}${url.pathname}`) : null;
}

export function sharedInvite(base: string, kind: 'seat' | 'watch', roomId: string, token: string): string {
  return `${inviteBase(base)}#/${kind}/${encodeURIComponent(roomId)}/${encodeURIComponent(token)}`;
}
