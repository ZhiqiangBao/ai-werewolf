import { useEffect, useId, useState } from 'react';
import { forgetRoom, savedRooms, type SavedRoom } from '../api';
import { go } from '../hooks';
import { Icon, Logo } from './Icons';
import { Pagination, paginate } from './Pagination';

function RoomCard({ room: r, onRemove }: { room: SavedRoom; onRemove: (id: string) => void }) {
  return <article className="room-item">
    <span className="room-emblem"><Logo size={28} /></span>
    <div className="room-info"><span className="eyebrow">COUNCIL ROOM</span><h3>房间 {r.roomId}</h3><span className="dim tiny">{new Date(r.createdAt).toLocaleString('zh-CN')}</span></div>
    <button className="btn sm" onClick={() => go('/host/' + r.roomId + '/' + r.hostToken)}>入席<Icon name="arrow" size={14} /></button>
    <button className="icon-button remove-room" title="从本机列表移除" aria-label={'移除房间 ' + r.roomId} onClick={() => onRemove(r.roomId)}><Icon name="close" size={14} /></button>
  </article>;
}

export function RecentRooms({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  const [rooms, setRooms] = useState<SavedRoom[]>(savedRooms);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const listId = useId();
  const sorted = [...rooms].sort((a, b) => b.createdAt - a.createdAt);
  const recent = sorted.slice(0, 4), older = sorted.slice(4);
  const visible = paginate(older, page, 8);
  useEffect(() => { setPage((current) => Math.min(current, visible.pageCount)); }, [visible.pageCount]);
  const remove = (id: string) => { forgetRoom(id); setRooms(savedRooms()); };
  return <section className="room-section" id="recent-rooms">
    <div className="section-heading"><div><span className="eyebrow">YOUR COUNCILS</span><h2>继续你的故事</h2></div><span className="muted small">本机房间 · {rooms.length} 场</span></div>
    {rooms.length ? <>
      <div className="room-grid" aria-label="最近的房间">{recent.map((r) => <RoomCard key={r.roomId} room={r} onRemove={remove} />)}</div>
      {older.length > 0 && <div className="older-rooms">
        <button className="list-disclosure" type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => { setExpanded(!expanded); setPage(1); }}>
          <span>{expanded ? '收起更早的房间' : '展开更早的房间'}</span>
          <span className="disclosure-count">{older.length} 场</span>
          <span className="disclosure-arrow" aria-hidden="true" />
        </button>
        <div id={listId} hidden={!expanded}>
          {expanded && <>
            <div className="room-grid" aria-label="更早的房间">{visible.items.map((r) => <RoomCard key={r.roomId} room={r} onRemove={remove} />)}</div>
            <Pagination label="更早的房间" page={visible.page} pageCount={visible.pageCount} onChange={setPage} />
          </>}
        </div>
      </div>}
    </> : <div className="empty-rooms"><Icon name="cards" size={30} /><div><h3>第一场故事，等你开启</h3><p>创建房间，邀请玩家，或让不同的大模型入席。</p></div><button className="btn sm" disabled={busy} onClick={onCreate}>创建房间<Icon name="arrow" size={14} /></button></div>}
    <p className="room-privacy"><Icon name="shield" size={13} />房主链接仅保存在当前浏览器中。</p>
  </section>;
}
