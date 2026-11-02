import { useEffect, useState, type ReactNode } from 'react';
import type { GodProjection, Projection, RoomBrief, RoomSetupView, ToolCall } from '@werewolf/protocol';
import { api, exportUrl, rememberRoom } from '../api';
import { go, useCatalog, useView } from '../hooks';
import { AuditPanel } from '../components/AuditPanel';
import { IdentityCard, ResultBanner, RuleCard } from '../components/Cards';
import { EventLog } from '../components/EventLog';
import { GodPanel } from '../components/GodPanel';
import { Logo, PhaseIcon } from '../components/Icons';
import { AVATAR_STYLES, applyAvatarStyle, initializeAvatarStyle } from '../avatar-style';
import { SeatRing } from '../components/SeatRing';
import { TaskPanel } from '../components/TaskPanel';
import { ThoughtFeed } from '../components/ThoughtFeed';
import { HumanLobby, HumanStatus } from '../components/HumanPlayers';
import { SpeechControls, useSpeechPlayback } from '../components/SpeechPlayback';
import { downloadVideoScript } from '../video';
import { phaseLabel, seatName } from '../util';
import { LinksPanel, Setup } from './Setup';

function TopBar({ room, projection, who, children }: { room: RoomBrief; projection: Projection | null; who: string; children?: ReactNode }) {
  const phase = projection?.status === 'ended' ? 'end' : (projection?.phase ?? 'setup');
  useEffect(() => {
    if (room.avatarStyle) applyAvatarStyle(room.avatarStyle);
    return initializeAvatarStyle;
  }, [room.avatarStyle]);
  // 场景与公共控件随昼夜切换。
  useEffect(() => {
    document.body.dataset.phase = phase;
    return () => {
      delete document.body.dataset.phase;
    };
  }, [phase]);
  return (
    <div className="topbar">
      <a className="brand" href="#/">
        <Logo />
        <span>AI 狼人杀<small>THE MOONLIT VILLAGE</small></span>
      </a>
      <span className="muted small room-meta">
        {room.presetName} · 房间 {room.roomId}
      </span>
      {projection && (
        <span className={`phase-pill ${phase}`}>
          {phase !== 'end' && <PhaseIcon phase={phase} size={14} />}
          {phase === 'end' ? '已结束' : phaseLabel(projection.day, projection.phase)}
        </span>
      )}
      {room.paused && room.status === 'running' && <span className="tag gold">已暂停</span>}
      <span className="spacer" />
      {room.avatarStyle && <span className="tag">{AVATAR_STYLES.find((style) => style.id === room.avatarStyle)?.name}</span>}
      {children}
      <span className="tag">{who}</span>
    </div>
  );
}

function Loading({ error }: { error: string | null }) {
  return (
    <div className="center-screen">
      {error ? (
        <div>
          <div className="error-box">{error}</div>
          <a className="btn" style={{ marginTop: 16 }} href="#/">
            回到首页
          </a>
        </div>
      ) : (
        <div className="muted">正在连接房间…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 房主
// ---------------------------------------------------------------------------

export function HostPage({ roomId, token }: { roomId: string; token: string }) {
  const { data, error, refresh } = useView(roomId, token);
  if (!data) return <Loading error={error} />;
  if (data.room.viewer !== 'host') return <Loading error="这个链接不是房主链接。" />;
  if (data.room.status === 'setup' || !data.projection) {
    return (
      <>
        <TopBar room={data.room} projection={null} who="房主" />
        <Setup roomId={roomId} token={token} onStarted={() => void refresh()} />
      </>
    );
  }
  return <HostGame roomId={roomId} token={token} room={data.room} projection={data.projection as GodProjection} refresh={refresh} />;
}

function HostGame({ roomId, token, room, projection: p, refresh }: { roomId: string; token: string; room: RoomBrief; projection: GodProjection; refresh: () => Promise<void> }) {
  const catalog = useCatalog();
  const [tab, setTab] = useState<'god' | 'audit' | 'links' | 'rules'>('god');
  const [setup, setSetup] = useState<RoomSetupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = room.status === 'running';
  const speech = useSpeechPlayback(roomId, token, p);

  useEffect(() => {
    api.getSetup(roomId, token).then(setSetup, () => {});
  }, [roomId, token]);

  const control = async (action: 'pause' | 'resume' | 'step' | 'end') => {
    setBusy(true);
    setError(null);
    try {
      await api.control(roomId, token, action);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const endMatch = () => {
    if (!window.confirm('终结这一局？正在进行的模型请求会被取消。本局记为流局，无胜负，不公开身份。')) return;
    void control('end');
  };

  const again = async () => {
    try {
      const r = await api.cloneRoom(roomId, token);
      rememberRoom(r);
      go(`/host/${r.roomId}/${r.hostToken}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <TopBar room={room} projection={p} who="房主 · 上帝视角">
        {running && !room.paused && (
          <button className="btn sm" disabled={busy} onClick={() => void control('pause')}>
            暂停
          </button>
        )}
        {running && room.paused && (
          <>
            <button className="btn sm" disabled={busy} onClick={() => void control('step')} title="让模型座位只走一步">
              单步
            </button>
            <button className="btn sm primary" disabled={busy} onClick={() => void control('resume')}>
              继续
            </button>
          </>
        )}
        {running && (
          <button className="btn sm danger" disabled={busy} onClick={endMatch}>
            终结
          </button>
        )}
        {!running && (
          <button className="btn sm primary" onClick={() => void again()}>
            同配置再来一局
          </button>
        )}
      </TopBar>
      <div className="wrap game-wrap">
        {error && (
          <div className="error-box" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div className="game">
          <div className="game-left">
            {p.result && <ResultBanner result={p.result} />}
            <HumanStatus participants={room.participants ?? []} seats={room.seats} />
            <div className="panel">
              <SeatRing projection={p} room={room} catalog={catalog} roles={p.god.roles} />
            </div>
            <div className="panel">
              <div className="tabs">
                {(
                  [
                    ['god', '身份与进度'],
                    ['audit', '模型调用记录'],
                    ['links', '链接与导出'],
                    ['rules', '规则卡'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'god' && <GodPanel projection={p} room={room} catalog={catalog} />}
              {tab === 'audit' && <AuditPanel roomId={roomId} token={token} />}
              {tab === 'links' && (
                <div style={{ display: 'grid', gap: 12 }}>
                  {setup && <LinksPanel roomId={roomId} setup={setup} />}
                  <div className="row">
                    <a className="btn sm" href={exportUrl(roomId, token, 'public')}>
                      导出公开记录
                    </a>
                    <a className="btn sm" href={exportUrl(roomId, token, 'god')}>
                      导出原始上帝记录
                    </a>
                    <button className="btn sm primary" onClick={() => downloadVideoScript(p, room)}>导出视频剪辑稿</button>
                  </div>
                </div>
              )}
              {tab === 'rules' && <pre className="rulecard">{p.ruleCard}</pre>}
            </div>
          </div>
          <div className="game-right">
            <ThoughtFeed thoughts={p.thoughts} seats={p.seats} events={p.events} />
            <EventLog events={p.events} seats={p.seats} mode="god" onRead={speech.read} controls={<SpeechControls player={speech} />} />
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 座位
// ---------------------------------------------------------------------------

export function SeatPage({ roomId, token }: { roomId: string; token: string }) {
  const { data, error, refresh } = useView(roomId, token);
  const catalog = useCatalog();
  const speech = useSpeechPlayback(roomId, token, data?.projection ?? null);
  if (!data) return <Loading error={error} />;
  const { room } = data;
  if (room.viewer !== 'seat' || !room.seat) return <Loading error="这个链接不是座位链接。" />;
  const mine = room.seats.find((s) => s.seat === room.seat);
  const human = mine?.controller === 'human';
  const who = `${seatName(room.seat)}${mine && mine.name !== seatName(room.seat) ? ` ${mine.name}` : ''}${human ? '' : '（AI 控制）'}`;

  if (!data.projection) {
    return (
      <>
        <TopBar room={room} projection={null} who={who} />
        {human ? <HumanLobby room={room} token={token} refresh={refresh} /> : <div className="center-screen">
          <div>
            <h2>你是 {seatName(room.seat)}</h2>
            <p className="muted">等待房主开局。开局后身份会随机发放，这个页面会自动刷新。</p>
            {!human && <p className="muted small">这个座位目前由 AI 控制，你只能旁观它的视角。</p>}
          </div>
        </div>}
      </>
    );
  }

  const p = data.projection;
  const act = async (call: ToolCall, decisionId: string): Promise<string | null> => {
    try {
      const r = await api.act(roomId, token, { decisionId, ...call });
      await refresh();
      return r.ok ? null : (r.error?.message ?? '行动没有被接受');
    } catch (e) {
      await refresh();
      return (e as Error).message;
    }
  };

  return (
    <>
      <TopBar room={room} projection={p} who={who}>
        {human && ((p.task && !p.task.submitted) || p.interrupts.some((t) => t.name === 'sheriff_withdraw')) && !room.paused && (
          <button className="btn sm primary" aria-label={`前往行动：${p.task && !p.task.submitted ? p.task.title : '退水'}`} onClick={() => document.getElementById('player-action')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {p.task && !p.task.submitted ? '轮到你了' : '可退水'}
          </button>
        )}
      </TopBar>
      <div className="wrap game-wrap">
        {error && <div className="error-box" role="alert">连接中断：{error}。草稿保留，恢复连接后再提交。</div>}
        <div className="game">
          <div className="game-left">
            {p.result && <ResultBanner result={p.result} />}
            <div className="panel">
              <SeatRing projection={p} room={room} catalog={catalog} />
            </div>
            <TaskPanel projection={p} human={human} paused={room.paused} onAct={act} />
            {p.me && <IdentityCard me={p.me} catalog={catalog} />}
            <RuleCard text={p.ruleCard} />
          </div>
          <div className="game-right">
            <ThoughtFeed thoughts={p.thoughts} seats={p.seats} events={p.events} />
            <EventLog events={p.events} seats={p.seats} mode="seat" mySeat={room.seat} onRead={speech.read} controls={<SpeechControls player={speech} />} />
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 观战
// ---------------------------------------------------------------------------

export function WatchPage({ roomId, token }: { roomId: string; token: string }) {
  const { data, error } = useView(roomId, token);
  const catalog = useCatalog();
  const speech = useSpeechPlayback(roomId, token, data?.projection ?? null);
  if (!data) return <Loading error={error} />;
  const { room } = data;
  if (!data.projection) {
    return (
      <>
        <TopBar room={room} projection={null} who="观战" />
        <div className="center-screen muted">等待房主开局，开局后自动刷新。</div>
      </>
    );
  }
  const p = data.projection;
  return (
    <>
      <TopBar room={room} projection={p} who="观战">
        {p.status === 'ended' && (
          <a className="btn sm" href={exportUrl(roomId, token, 'public')}>
            导出对局记录
          </a>
        )}
      </TopBar>
      <div className="wrap game-wrap">
        <div className="game">
          <div className="game-left">
            {p.result && <ResultBanner result={p.result} />}
            <div className="panel">
              <SeatRing projection={p} room={room} catalog={catalog} />
            </div>
            <div className="note-box small">观战只能看到公开信息：发言、投票、公布的出局和翻开的身份。</div>
            <RuleCard text={p.ruleCard} />
          </div>
          <div className="game-right">
            <EventLog events={p.events} seats={p.seats} mode="spectator" onRead={speech.read} controls={<SpeechControls player={speech} />} />
          </div>
        </div>
      </div>
    </>
  );
}
