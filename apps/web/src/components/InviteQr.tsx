import { useI18n } from '../i18n';
import { QRCodeSVG } from 'qrcode.react';

export function InviteQr({ label, url, onClose }: { label: string; url: string; onClose: () => void }) {
  const { t } = useI18n();
  return <div className="note-box" role="region" aria-label={t('{0}邀请二维码', label)} style={{ marginTop: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <strong>{t('{0}邀请二维码', label)}</strong><span className="spacer" />
      <button className="btn sm ghost" onClick={onClose}>{t('收起二维码')}</button>
    </div>
    <div style={{ background: 'white', width: 'fit-content', maxWidth: '100%', padding: 8, borderRadius: 8 }}>
      <QRCodeSVG value={url} size={224} level="M" marginSize={4} title={t('{0}邀请链接', label)} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
    </div>
    <p className="small muted">{t('二维码在本机生成，与对应链接拥有相同权限，仅分享给对应玩家或旁观者。')}</p>
  </div>;
}
