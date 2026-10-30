import { useState } from 'react';
import { api, forgetRoom, rememberRoom, savedRooms, type SavedRoom } from '../api';
import { go, useCatalog } from '../hooks';
import { Logo } from '../components/Icons';

export function Home() {
  const catalog = useCatalog();
  const [rooms, setRooms] = useState<SavedRoom[]>(savedRooms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRoom();
      rememberRoom(r);
      go(`/host/${r.roomId}/${r.hostToken}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="wrap">
      <div className="hero">
        <div className="emblem" aria-hidden="true">
          <div className="face">
            <Logo size={64} />
          </div>
        </div>
        <h1>AI 狼人杀</h1>
        <p>
          每个座位可以接一个大模型，也可以由真人操作。法官由规则引擎担任，每个座位只能看到自己该知道的信息。
          {catalog && ` 目前内置 ${catalog.presets.length} 个版型、${catalog.roles.length} 种身份。`}
        </p>
        <button className="btn primary lg" disabled={busy} onClick={create}>
          {busy ? '正在创建…' : '创建房间'}
        </button>
        <div className="features">
          <span className="chip">真人与大模型同桌</span>
          <span className="chip">规则引擎当法官</span>
          <span className="chip">每人只看得到自己该看的</span>
        </div>
        {error && (
          <div className="error-box" style={{ maxWidth: 520, margin: '16px auto 0' }}>
            {error}
          </div>
        )}
      </div>

      {rooms.length > 0 && (
        <div className="room-list">
          <div className="muted small">本机创建过的房间（房主链接只保存在这个浏览器里）</div>
          {rooms.map((r) => (
            <div key={r.roomId} className="room-item">
              <b>房间 {r.roomId}</b>
              <span className="dim small">{new Date(r.createdAt).toLocaleString()}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => go(`/host/${r.roomId}/${r.hostToken}`)}>
                进入
              </button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  forgetRoom(r.roomId);
                  setRooms(savedRooms());
                }}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
