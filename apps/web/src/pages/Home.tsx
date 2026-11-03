import { useEffect, useState } from 'react';
import { api, rememberRoom } from '../api';
import { go, useCatalog } from '../hooks';
import { Icon, Logo } from '../components/Icons';
import { Avatar } from '../components/Avatar';
import { AvatarStylePicker } from '../components/AvatarStylePicker';
import { currentAvatarStyle } from '../avatar-style';
import { ModelLibrary } from '../components/ModelLibrary';
import { SpeechSettings } from '../components/SpeechSettings';
import { RecentRooms } from '../components/RecentRooms';
import { UiLanguagePicker, useI18n } from '../i18n';

export function Home() {
  const { t } = useI18n();
  const catalog = useCatalog();
  useEffect(() => { if (location.hash === '#/settings') document.getElementById('connection-settings')?.scrollIntoView(); }, []);
  const [phase, setPhase] = useState<'day' | 'night'>(() => {
    try { return localStorage.getItem('werewolf.lobby-phase') === 'day' ? 'day' : 'night'; } catch { return 'night'; }
  });
  useEffect(() => {
    document.body.dataset.phase = phase;
    return () => { delete document.body.dataset.phase; };
  }, [phase]);
  const choosePhase = (next: 'day' | 'night') => {
    setPhase(next);
    try { localStorage.setItem('werewolf.lobby-phase', next); } catch { /* The switch still works. */ }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.createRoom(currentAvatarStyle()); rememberRoom(r); go('/host/' + r.roomId + '/' + r.hostToken);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className={"home-page " + phase}>
      <nav className="home-nav"><a className="brand" href="#/"><Logo /><span>{t('AI 狼人杀')}<small>THE MOONLIT VILLAGE</small></span></a><span className="home-nav-note">{phase === 'day' ? t('故事，在晨光中启程') : t('推理，在月色中发生')}</span><div className="lobby-time-switch" role="group" aria-label={t('大厅昼夜')}><button onClick={() => choosePhase('day')} aria-pressed={phase === 'day'} className={phase === 'day' ? 'on' : ''}><Icon name="sun" size={14} />{t('白昼')}</button><button onClick={() => choosePhase('night')} aria-pressed={phase === 'night'} className={phase === 'night' ? 'on' : ''}><Icon name="moon" size={14} />{t('夜幕')}</button></div><UiLanguagePicker /><AvatarStylePicker /><button className="btn ghost sm" onClick={() => document.getElementById('connection-settings')?.scrollIntoView({ behavior: 'smooth' })}>{t('模型与语音')}</button><button className="btn ghost sm" onClick={() => document.getElementById('recent-rooms')?.scrollIntoView({ behavior: 'smooth' })}>{t('我的房间')}<Icon name="arrow" size={15} /></button></nav>
      <main>
        <section className="home-hero">
          <div className="hero-copy"><span className="eyebrow"><span className="little-rule" />{t('信任与欺骗的游戏')}</span><h1>{t('月色之下，')}<br />{t('谁在')}<span>{t('说谎')}</span>{t('。')}</h1><p>{t('把你的直觉带上圆桌。')}<br />{t('与真人、大模型同局，在每一句话里寻找真相。')}</p><button className="btn primary lg" disabled={busy} onClick={() => void create()}>{busy ? t('正在准备你的圆桌…') : t('创建一场对局')}<Icon name="arrow" size={19} /></button><div className="hero-footnote"><Icon name="users" size={14} />{t('真人与 AI 自由组局')}<span />{t('独立身份 · 实时对局')}</div>{error && <div className="error-box" role="alert">{error}</div>}</div>
          <div className="hero-tableau" aria-hidden="true"><span className="tableau-orbit" /><img className="hero-table" src={"/art/moon-village/table-" + phase + "-v1.webp"} alt="" /><span className="hero-guest guest-one"><Avatar seat={2} size={100} /></span><span className="hero-guest guest-two"><Avatar seat={1} size={95} /></span><span className="hero-guest guest-three"><Avatar seat={4} size={95} /></span><div className="tableau-inscription"><Logo size={44} /><span>{phase === 'day' ? t('天亮，请睁眼') : t('天黑，请闭眼')}</span><small>{t('每个声音都藏着故事')}</small></div><div className="tableau-caption"><span />{t('一张圆桌，无数种可能')}<span /></div></div>
          <div className="hero-bottom"><span>{t('倾听 · 判断 · 选择')}</span><span>{t('让每一种推理，都有自己的声音')}</span></div>
        </section>
        <div className="home-content">
          <section className="home-features" aria-label={t('游戏特点')}>
            <article><Icon name="users" size={25} /><div><h2>{t('真人与 AI，同桌较量')}</h2><p>{t('每个座位，自由选择真人或大模型。')}</p></div><span className="feature-index">01</span></article>
            <article><Icon name="eye" size={25} /><div><h2>{t('你的身份，只属于你')}</h2><p>{t('独立信息视角，让推理保持纯粹。')}</p></div><span className="feature-index">02</span></article>
            <article><Icon name="scroll" size={25} /><div><h2>{t('每一次交锋，都有迹可循')}</h2><p>{t('发言、票型与结局，完整留存复盘。')}</p></div><span className="feature-index">03</span></article>
          </section>
          <section className="home-connections" id="connection-settings" aria-label={t('模型与语音')}>
            <div className="section-heading"><div><span className="eyebrow">{t('你的连接')}</span><h2>{t('模型与语音')}</h2></div><span className="muted small">{t('统一配置 · 各房间复用')}</span></div>
            <ModelLibrary />
            <div className="panel home-speech-library"><div><h3>{t('语音服务库')}</h3><p className="small muted">{t('添加朗读服务、管理音色并试听，进入房间后选择使用。')}</p></div><SpeechSettings /></div>
          </section>
          <RecentRooms busy={busy} onCreate={() => void create()} />
          <footer className="home-footer"><span><Logo size={19} />{t('AI 狼人杀')}</span><span>{catalog ? t('{0} 种版型 · {1} 种身份', catalog.presets.length, catalog.roles.length) : t('真相，藏在下一轮发言里。')}</span><span>{t('夜幕藏着秘密')}</span></footer>
        </div>
      </main>
    </div>
  );
}
