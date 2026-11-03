import { useEffect, useState, type ReactNode } from 'react';
import type { GodProjection, Projection, RoomBrief, RoomSetupView, ToolCall, ViewResponse } from '@werewolf/protocol';
import { gameText } from '@werewolf/protocol';
import { UiLanguagePicker, useI18n } from '../i18n';
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
  const { t } = useI18n();
  const phase = projection?.status === 'ended' ? 'end' : (projection?.phase ?? 'setup');
  const avatarName = AVATAR_STYLES.find((style) => style.id === room.avatarStyle)?.name;
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
        <span>{t('AI 狼人杀')}<small>THE MOONLIT VILLAGE</small></span>
      </a>
      <span className="muted small room-meta">
        {room.presetName} · {t('房间 {0}', room.roomId)}
      </span>
      {projection && (
        <span className={`phase-pill ${phase}`}>
          {phase !== 'end' && <PhaseIcon phase={phase} size={14} />}
          {phase === 'end' ? gameText(projection.locale ?? room.locale, '终局') : phaseLabel(projection.day, projection.phase, projection.locale ?? room.locale)}
        </span>
      )}
      {room.paused && room.status === 'running' && <span className="tag gold">{t('已暂停')}</span>}
      <span className="spacer" />
      <div className="room-toolbar">
        <UiLanguagePicker />
        {avatarName && <span className="tag">{t(avatarName)}</span>}
        {children}
        <span className="tag">{who}</span>
      </div>
    </div>
  );
}

function Loading({ error }: { error: string | null }) {
  const { t } = useI18n();
  return (
    <div className="center-screen">
      {error ? (
        <div>
          <div className="error-box">{error}</div>
          <a className="btn" style={{ marginTop: 16 }} href="#/">
            {t('回到首页')}
          </a>
        </div>
      ) : (
        <div className="muted">{t('正在连接房间…')}</div>
      )}
    </div>
  );
}

/** 不显示凭证；仅作为动画游标的内存隔离范围。 */
function animationScope(roomId: string, token: string, p: Projection): string {
  return JSON.stringify([roomId, token, p.gameId, p.viewer.kind, p.viewer.kind === 'seat' ? p.viewer.seat : null]);
}

// ---------------------------------------------------------------------------
// 房主
// ---------------------------------------------------------------------------

export function HostPage({ roomId, token }: { roomId: string; token: string }) {
  const { t } = useI18n();
  const { data, error, refresh } = useView(roomId, token);
  if (!data) return <Loading error={error} />;
  if (data.room.viewer !== 'host') return <Loading error={t('这个链接不是房主链接。')} />;
  if (data.room.status === 'setup' || !data.projection) {
    return (
      <>
        <TopBar room={data.room} projection={null} who={t('房主')} />
        <Setup roomId={roomId} token={token} onStarted={() => void refresh()} />
      </>
    );
  }
  return <HostGame roomId={roomId} token={token} room={data.room} projection={data.projection as GodProjection} presentation={data.presentation} refresh={refresh} />;
}

function HostGame({ roomId, token, room, projection: p, presentation, refresh }: { roomId: string; token: string; room: RoomBrief; projection: GodProjection; presentation?: ViewResponse['presentation']; refresh: () => Promise<void> }) {
  const { t } = useI18n();
  const catalog = useCatalog();
  const [tab, setTab] = useState<'god' | 'audit' | 'links' | 'rules'>('god');
  const [setup, setSetup] = useState<RoomSetupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = room.status === 'running';
  const speech = useSpeechPlayback(roomId, token, p, room, presentation);

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
    if (!window.confirm(t('终结这一局？正在进行的模型请求会被取消。本局记为流局，无胜负，不公开身份。'))) return;
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
      <TopBar room={room} projection={p} who={t('房主 · 上帝视角')}>
        {running && !room.paused && (
          <button className="btn sm" disabled={busy} onClick={() => void control('pause')}>
            {t('暂停')}
          </button>
        )}
        {running && room.paused && (
          <>
            <button className="btn sm" disabled={busy} onClick={() => void control('step')} title={t('让模型座位只走一步')}>
              {t('单步')}
            </button>
            <button className="btn sm primary" disabled={busy} onClick={() => void control('resume')}>
              {t('继续')}
            </button>
          </>
        )}
        {running && (
          <button className="btn sm danger" disabled={busy} onClick={endMatch}>
            {t('终结')}
          </button>
        )}
        {!running && (
          <button className="btn sm primary" onClick={() => void again()}>
            {t('同配置再来一局')}
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
            {p.result && <ResultBanner result={p.result} locale={p.locale ?? room.locale} />}
            <HumanStatus participants={room.participants ?? []} seats={room.seats} />
            <div className="panel">
              <SeatRing projection={p} room={room} catalog={catalog} roles={p.god.roles} deaths={presentation?.deaths} effectScope={animationScope(roomId, token, p)} />
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
                    {t(label)}
                  </button>
                ))}
              </div>
              {tab === 'god' && <GodPanel projection={p} room={room} catalog={catalog} deaths={presentation?.deaths} />}
              {tab === 'audit' && <AuditPanel roomId={roomId} token={token} locale={p.locale ?? room.locale} />}
              {tab === 'links' && (
                <div style={{ display: 'grid', gap: 12 }}>
                  {setup && <LinksPanel roomId={roomId} setup={setup} />}
                  <div className="row">
                    <a className="btn sm" href={exportUrl(roomId, token, 'public')}>
                      {t('导出公开记录')}
                    </a>
                    <a className="btn sm" href={exportUrl(roomId, token, 'god')}>
                      {t('导出原始上帝记录')}
                    </a>
                    <button className="btn sm primary" onClick={() => downloadVideoScript(p, room)}>{t('导出视频剪辑稿')}</button>
                  </div>
                </div>
              )}
              {tab === 'rules' && <pre className="rulecard">{p.ruleCard}</pre>}
            </div>
          </div>
          <div className="game-right">
            <ThoughtFeed thoughts={p.thoughts} seats={p.seats} events={p.events} locale={p.locale ?? room.locale} />
            <EventLog events={p.events} seats={p.seats} mode="god" locale={p.locale ?? room.locale} onRead={speech.read} controls={<SpeechControls player={speech} />} />
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
  const { t } = useI18n();
  const { data, error, refresh } = useView(roomId, token);
  const catalog = useCatalog();
  const speech = useSpeechPlayback(roomId, token, data?.projection ?? null, data?.room, data?.presentation);
  if (!data) return <Loading error={error} />;
  const { room } = data;
  if (room.viewer !== 'seat' || !room.seat) return <Loading error={t('这个链接不是座位链接。')} />;
  const mine = room.seats.find((s) => s.seat === room.seat);
  const human = mine?.controller === 'human';
  const who = `${gameText(room.locale, '{0}号', room.seat)}${mine && mine.name !== seatName(room.seat) && mine.name !== gameText(room.locale, '{0}号', room.seat) ? ` ${mine.name}` : ''}${human ? '' : t('（AI 控制）')}`;

  if (!data.projection) {
    return (
      <>
        <TopBar room={room} projection={null} who={who} />
        {human ? <HumanLobby room={room} token={token} refresh={refresh} /> : <div className="center-screen">
          <div>
            <h2>{t('你是 {0}', gameText(room.locale, '{0}号', room.seat))}</h2>
            <p className="muted">{t('等待房主开局。开局后身份会随机发放，这个页面会自动刷新。')}</p>
            {!human && <p className="muted small">{t('这个座位目前由 AI 控制，你只能旁观它的视角。')}</p>}
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
      return r.ok ? null : (r.error?.message ?? t('行动没有被接受'));
    } catch (e) {
      await refresh();
      return (e as Error).message;
    }
  };

  return (
    <>
      <TopBar room={room} projection={p} who={who}>
        {human && ((p.task && !p.task.submitted) || p.interrupts.some((t) => t.name === 'sheriff_withdraw')) && !room.paused && (
          <button className="btn sm primary" aria-label={t('前往行动：{0}', p.task && !p.task.submitted ? p.task.title : gameText(p.locale ?? room.locale, '退水'))} onClick={() => document.getElementById('player-action')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {p.task && !p.task.submitted ? t('轮到你了') : t('可退水')}
          </button>
        )}
      </TopBar>
      <div className="wrap game-wrap">
        {error && <div className="error-box" role="alert">{t('连接中断：{0}。草稿保留，恢复连接后再提交。', error)}</div>}
        <div className="game">
          <div className="game-left">
            {p.result && <ResultBanner result={p.result} locale={p.locale ?? room.locale} />}
            <div className="panel">
              <SeatRing projection={p} room={room} catalog={catalog} deaths={data.presentation?.deaths} effectScope={animationScope(roomId, token, p)} />
            </div>
            <TaskPanel projection={p} locale={p.locale ?? room.locale} human={human} paused={room.paused} availableAt={data.presentation?.actionAvailableAt} onAct={act} />
            {p.me && <IdentityCard me={p.me} catalog={catalog} locale={p.locale ?? room.locale} />}
            <RuleCard text={p.ruleCard} locale={p.locale ?? room.locale} />
          </div>
          <div className="game-right">
            <ThoughtFeed thoughts={p.thoughts} seats={p.seats} events={p.events} locale={p.locale ?? room.locale} />
            <EventLog events={p.events} seats={p.seats} mode="seat" locale={p.locale ?? room.locale} mySeat={room.seat} onRead={speech.read} controls={<SpeechControls player={speech} />} />
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
  const { t } = useI18n();
  const { data, error } = useView(roomId, token);
  const catalog = useCatalog();
  const speech = useSpeechPlayback(roomId, token, data?.projection ?? null, data?.room, data?.presentation);
  if (!data) return <Loading error={error} />;
  const { room } = data;
  if (!data.projection) {
    return (
      <>
        <TopBar room={room} projection={null} who={t('观战')} />
        <div className="center-screen muted">{t('等待房主开局，开局后自动刷新。')}</div>
      </>
    );
  }
  const p = data.projection;
  return (
    <>
      <TopBar room={room} projection={p} who={t('观战')}>
        {p.status === 'ended' && (
          <a className="btn sm" href={exportUrl(roomId, token, 'public')}>
            {t('导出对局记录')}
          </a>
        )}
      </TopBar>
      <div className="wrap game-wrap">
        <div className="game">
          <div className="game-left">
            {p.result && <ResultBanner result={p.result} locale={p.locale ?? room.locale} />}
            <div className="panel">
              <SeatRing projection={p} room={room} catalog={catalog} deaths={data.presentation?.deaths} effectScope={animationScope(roomId, token, p)} />
            </div>
            <div className="note-box small">{t('观战只能看到公开信息：发言、投票、公布的出局和翻开的身份。')}</div>
            <RuleCard text={p.ruleCard} locale={p.locale ?? room.locale} />
          </div>
          <div className="game-right">
            <EventLog events={p.events} seats={p.seats} mode="spectator" locale={p.locale ?? room.locale} onRead={speech.read} controls={<SpeechControls player={speech} />} />
          </div>
        </div>
      </div>
    </>
  );
}
