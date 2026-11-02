import { useEffect, useState } from 'react';
import { api, forgetRoom, rememberRoom, savedRooms, type SavedRoom } from '../api';
import { go, useCatalog } from '../hooks';
import { Icon, Logo } from '../components/Icons';
import { Avatar } from '../components/Avatar';
import { AvatarStylePicker } from '../components/AvatarStylePicker';
import { currentAvatarStyle } from '../avatar-style';

export function Home() {
  const catalog = useCatalog();
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
  const [rooms, setRooms] = useState<SavedRoom[]>(savedRooms);
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
      <nav className="home-nav"><a className="brand" href="#/"><Logo /><span>AI 狼人杀<small>THE MOONLIT VILLAGE</small></span></a><span className="home-nav-note">{phase === 'day' ? '故事，在晨光中启程' : '推理，在月色中发生'}</span><div className="lobby-time-switch" role="group" aria-label="大厅昼夜"><button onClick={() => choosePhase('day')} aria-pressed={phase === 'day'} className={phase === 'day' ? 'on' : ''}><Icon name="sun" size={14} />白昼</button><button onClick={() => choosePhase('night')} aria-pressed={phase === 'night'} className={phase === 'night' ? 'on' : ''}><Icon name="moon" size={14} />夜幕</button></div><AvatarStylePicker /><button className="btn ghost sm" onClick={() => document.getElementById('recent-rooms')?.scrollIntoView({ behavior: 'smooth' })}>我的房间<Icon name="arrow" size={15} /></button></nav>
      <main>
        <section className="home-hero">
          <div className="hero-copy"><span className="eyebrow"><span className="little-rule" />A GAME OF TRUST & DECEPTION</span><h1>月色之下，<br />谁在<span>说谎</span>。</h1><p>把你的直觉带上圆桌。<br />与真人、大模型同局，在每一句话里寻找真相。</p><button className="btn primary lg" disabled={busy} onClick={() => void create()}>{busy ? '正在准备你的圆桌…' : '创建一场对局'}<Icon name="arrow" size={19} /></button><div className="hero-footnote"><Icon name="users" size={14} />真人与 AI 自由组局<span />独立身份 · 实时对局</div>{error && <div className="error-box" role="alert">{error}</div>}</div>
          <div className="hero-tableau" aria-hidden="true"><span className="tableau-orbit" /><img className="hero-table" src={"/art/moon-village/table-" + phase + "-v1.webp"} alt="" /><span className="hero-guest guest-one"><Avatar seat={2} size={100} /></span><span className="hero-guest guest-two"><Avatar seat={1} size={95} /></span><span className="hero-guest guest-three"><Avatar seat={4} size={95} /></span><div className="tableau-inscription"><Logo size={44} /><span>{phase === 'day' ? '天亮，请睁眼' : '天黑，请闭眼'}</span><small>EVERY VOICE HIDES A STORY</small></div><div className="tableau-caption"><span />一张圆桌，无数种可能<span /></div></div>
          <div className="hero-bottom"><span>倾听 · 判断 · 选择</span><span>让每一种推理，都有自己的声音</span></div>
        </section>
        <div className="home-content">
          <section className="home-features" aria-label="游戏特点">
            <article><Icon name="users" size={25} /><div><h2>真人与 AI，同桌较量</h2><p>每个座位，自由选择真人或大模型。</p></div><span className="feature-index">01</span></article>
            <article><Icon name="eye" size={25} /><div><h2>你的身份，只属于你</h2><p>独立信息视角，让推理保持纯粹。</p></div><span className="feature-index">02</span></article>
            <article><Icon name="scroll" size={25} /><div><h2>每一次交锋，都有迹可循</h2><p>发言、票型与结局，完整留存复盘。</p></div><span className="feature-index">03</span></article>
          </section>
          <section className="room-section" id="recent-rooms"><div className="section-heading"><div><span className="eyebrow">YOUR COUNCILS</span><h2>继续你的故事</h2></div><span className="muted small">本机房间 · {rooms.length} 场</span></div>
            {rooms.length ? <div className="room-grid">{rooms.map((r) => <article className="room-item" key={r.roomId}><span className="room-emblem"><Logo size={28} /></span><div className="room-info"><span className="eyebrow">COUNCIL ROOM</span><h3>房间 {r.roomId}</h3><span className="dim tiny">{new Date(r.createdAt).toLocaleString('zh-CN')}</span></div><button className="btn sm" onClick={() => go('/host/' + r.roomId + '/' + r.hostToken)}>入席<Icon name="arrow" size={14} /></button><button className="icon-button remove-room" title="从本机列表移除" aria-label={'移除房间 ' + r.roomId} onClick={() => { forgetRoom(r.roomId); setRooms(savedRooms()); }}><Icon name="close" size={14} /></button></article>)}</div> : <div className="empty-rooms"><Icon name="cards" size={30} /><div><h3>第一场故事，等你开启</h3><p>创建房间，邀请玩家，或让不同的大模型入席。</p></div><button className="btn sm" disabled={busy} onClick={() => void create()}>创建房间<Icon name="arrow" size={14} /></button></div>}
            <p className="room-privacy"><Icon name="shield" size={13} />房主链接仅保存在当前浏览器中。</p>
          </section>
          <footer className="home-footer"><span><Logo size={19} />AI 狼人杀</span><span>{catalog ? catalog.presets.length + ' 种版型 · ' + catalog.roles.length + ' 种身份' : '真相，藏在下一轮发言里。'}</span><span>THE NIGHT HAS ITS SECRETS</span></footer>
        </div>
      </main>
    </div>
  );
}
