import { useI18n } from '../i18n';
import { ACTION_KINDS, defaultGameTiming, type GameTiming } from '@werewolf/protocol';

const names = { speech: '发言（含密谈、遗言）', vote: '放逐／警长投票', skill: '技能／报名／其他操作' };
export function TimingSettings({ value, onChange }: { value?: GameTiming; onChange: (timing: GameTiming) => void }) {
  const { t } = useI18n();
  const timing = value ?? defaultGameTiming();
  return <details className="timing-settings" open>
    <summary>{t('节奏与时限')} <small>{t('所有玩家共用，按行动类型设置')}</small></summary>
    <table className="timing-table"><thead><tr><th>{t('行动类型')}</th><th>{t('行动时限（秒）')}</th><th>{t('完成后的间隔（秒）')}</th></tr></thead>
      <tbody>{ACTION_KINDS.map((kind) => <tr key={kind}><th>{t(names[kind])}</th>
        <td><input type="number" aria-label={t('{0}时限（秒）', t(names[kind]))} min={1} max={3600} step={1} value={timing[kind].limitSec}
          onChange={(e) => { const limitSec = Number(e.target.value); if (Number.isInteger(limitSec) && limitSec >= 1 && limitSec <= 3600) onChange({ ...timing, [kind]: { ...timing[kind], limitSec } }); }} /></td>
        <td><input type="number" aria-label={t('{0}完成后的间隔（秒）', t(names[kind]))} min={0} max={60} step={0.1} value={timing[kind].intervalMs / 1000}
          onChange={(e) => { const seconds = Number(e.target.value); if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) onChange({ ...timing, [kind]: { ...timing[kind], intervalMs: Math.round(seconds * 1000) } }); }} /></td>
      </tr>)}</tbody>
    </table>
    <div className="row small muted"><span>{t('超时由系统托管；间隔从本次行动全部完成后开始，下一行动开放后才开始计时。')}</span><button type="button" className="btn" onClick={() => onChange(defaultGameTiming())}>{t('恢复默认时间')}</button></div>
  </details>;
}
