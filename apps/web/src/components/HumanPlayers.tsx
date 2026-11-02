import { useEffect, useRef, useState } from 'react';
import type { HumanParticipant, RoomBrief } from '@werewolf/protocol';
import { api } from '../api';
import { RuleCard } from './Cards';
import { seatName } from '../util';

export function HumanStatus({ participants, seats }: { participants: HumanParticipant[]; seats: { seat: number; name: string }[] }) {
  if (!participants.length) return null;
  return <div className="panel">
    <h3>真人玩家 <span className="tiny muted">{participants.filter((p) => p.ready).length} / {participants.length} 已准备</span></h3>
    {participants.map((p) => <div className="row small" key={p.seat} style={{ marginBottom: 6 }}>
      <b>{seatName(p.seat)} · {seats.find((s) => s.seat === p.seat)?.name}</b>
      <span className="spacer" />
      <span className={p.online ? 'tag ok' : 'tag'}>{p.online ? '已连接' : p.joined ? '暂时离线' : '尚未进入'}</span>
      <span className={p.ready ? 'tag ok' : 'tag'}>{p.ready ? '已准备' : '未准备'}</span>
    </div>)}
  </div>;
}

export function HumanLobby({ room, token, refresh }: { room: RoomBrief; token: string; refresh: () => Promise<void> }) {
  const mine = room.seats.find((s) => s.seat === room.seat)!;
  const participant = room.participants?.find((p) => p.seat === room.seat);
  const [name, setName] = useState(mine.name);
  const previousName = useRef(mine.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previous = previousName.current;
    setName((current) => current === previous ? mine.name : current);
    previousName.current = mine.name;
  }, [mine.name]);
  useEffect(() => {
    api.participate(room.roomId, token, {}).then(refresh).catch((e: Error) => setError(e.message));
  }, [room.roomId, token, refresh]);
  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      await api.participate(room.roomId, token, participant?.ready ? { ready: false } : { name: name.trim(), ready: true });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="wrap" style={{ maxWidth: 860 }}>
    <div className="panel">
      <h2>你是 {seatName(mine.seat)}</h2>
      <p className="muted">确认昵称、阅读规则后准备。开局时随机发放身份，本页会自动进入对局。</p>
      <label className="field">我的昵称
        <input value={name} maxLength={12} disabled={participant?.ready || busy} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
      </label>
      <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void prepare()}>
        {busy ? '保存中…' : participant?.ready ? '取消准备' : '确认昵称并准备'}
      </button>
      {participant?.ready && <p className="small" role="status">已准备，等待房主开局。规则改变后需要重新确认。</p>}
      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
    <HumanStatus participants={room.participants ?? []} seats={room.seats} />
    {room.ruleCard && <RuleCard text={room.ruleCard} />}
  </div>;
}
