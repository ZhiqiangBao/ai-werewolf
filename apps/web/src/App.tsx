import { useHashRoute } from './hooks';
import { HostPage, SeatPage, WatchPage } from './pages/Game';
import { Home } from './pages/Home';
import { UiLanguagePicker } from './i18n';

/** 链接格式：#/host|seat|watch/<房间号>/<凭证>。凭证放在 # 后面，不会出现在页面请求里。 */
export function App() {
  const [kind, roomId, token] = useHashRoute();
  if (roomId && token) {
    const key = `${kind}:${roomId}:${token}`;
    if (kind === 'host') return <><UiLanguagePicker /><HostPage key={key} roomId={roomId} token={token} /></>;
    if (kind === 'seat') return <><UiLanguagePicker /><SeatPage key={key} roomId={roomId} token={token} /></>;
    if (kind === 'watch') return <><UiLanguagePicker /><WatchPage key={key} roomId={roomId} token={token} /></>;
  }
  return <Home />;
}
