import { QRCodeSVG } from 'qrcode.react';

export function InviteQr({ label, url, onClose }: { label: string; url: string; onClose: () => void }) {
  return <div className="note-box" role="region" aria-label={`${label}邀请二维码`} style={{ marginTop: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <strong>{label}邀请二维码</strong><span className="spacer" />
      <button className="btn sm ghost" onClick={onClose}>收起二维码</button>
    </div>
    <div style={{ background: 'white', width: 'fit-content', maxWidth: '100%', padding: 8, borderRadius: 8 }}>
      <QRCodeSVG value={url} size={224} level="M" marginSize={4} title={`${label}邀请链接`} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
    </div>
    <p className="small muted">二维码在本机生成，与对应链接拥有相同权限，仅分享给对应玩家或旁观者。</p>
  </div>;
}
