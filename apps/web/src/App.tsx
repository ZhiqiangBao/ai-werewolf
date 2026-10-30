import { useHashRoute } from './hooks';
import { HostPage, SeatPage, WatchPage } from './pages/Game';
import { Home } from './pages/Home';

/** 链接格式：#/host|seat|watch/<房间号>/<凭证>。凭证放在 # 后面，不会出现在页面请求里。 */
export function App() {
  const [kind, roomId, token] = useHashRoute();
  if (roomId && token) {
    const key = `${kind}:${roomId}:${token}`;
    if (kind === 'host') return <HostPage key={key} roomId={roomId} token={token} />;
    if (kind === 'seat') return <SeatPage key={key} roomId={roomId} token={token} />;
    if (kind === 'watch') return <WatchPage key={key} roomId={roomId} token={token} />;
  }
  return <Home />;
}
