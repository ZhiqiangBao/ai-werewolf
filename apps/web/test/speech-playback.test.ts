import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Projection, RoomBrief } from '@werewolf/protocol';
import { humanDecisionWindow, SpeechPlaybackController } from '../src/speech-playback';
import type { SpeechItem } from '../src/speech';
import type { SpeechOutput, SpeechOutputEvents } from '../src/speech-output';

const item = (seq: number): SpeechItem => ({ seq, seat: seq, text: `发言${seq}` });
class FakeOutput implements SpeechOutput {
  events!: SpeechOutputEvents;
  played!: SpeechItem;
  stopped = false;
  async play(value: SpeechItem, _rate: number, events: SpeechOutputEvents) { this.played = value; this.events = events; }
  pause() {}
  async resume() {}
  setRate() {}
  stop() { this.stopped = true; }
}
function setup() {
  const drivers: FakeOutput[] = [];
  const player = new SpeechPlaybackController(() => {});
  const source = () => { const driver = new FakeOutput(); drivers.push(driver); return driver; };
  player.setSource(source);
  return { player, drivers, source };
}
afterEach(() => vi.useRealTimers());

describe('真实播放控制器', () => {
  it('首项失败后保留已有两条及新事件，显式重试后按序播放且重复投影不重读', () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]);
    player.sync([item(1), item(2), item(3)]);
    drivers[0].events.failed('合成失败');
    player.sync([item(1), item(2), item(3), item(4)]);
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 3, failed: true, enabled: true });
    player.sync([item(1), item(2), item(3), item(4)]);
    expect(drivers).toHaveLength(1);
    player.retry();
    for (const [index, seq] of [1, 2, 3, 4].entries()) {
      expect(drivers[index + 1].played.seq).toBe(seq);
      drivers[index + 1].events.ended();
    }
    expect(player.snapshot()).toMatchObject({ current: null, queued: 0 });
  });

  it('切换或删除来源使旧回调失效，保留队列且删除后需要明确重试', () => {
    const { player, drivers, source } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2), item(3)]);
    player.setSource(source);
    expect(drivers[0].stopped).toBe(true);
    drivers[0].events.ended(); drivers[0].events.failed('晚到');
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 2, failed: false });
    player.setSource(null, '来源已删除');
    drivers[1].events.ended();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 2, failed: true, error: '来源已删除' });
    player.setSource(source);
    expect(drivers).toHaveLength(2);
    player.retry(); drivers[2].events.ended();
    expect(drivers[3].played.seq).toBe(2);
    drivers[3].events.ended(); expect(drivers[4].played.seq).toBe(3);
  });

  it('暂停期间新事件和准备完成不推进，恢复后继续', async () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]);
    await player.togglePause();
    player.sync([item(1), item(2)]); drivers[0].events.ready();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 1, paused: true });
    await player.togglePause(); drivers[0].events.ended();
    expect(drivers[1].played.seq).toBe(2);
  });

  it('行动预告到时自动让行、旧请求晚到无效，手动重听结束后恢复让行', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2)]);
    player.setDecision({ id: 'd1', availableAt: 2000 });
    expect(player.snapshot().yielding).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(player.snapshot()).toMatchObject({ yielding: true, current: item(1), queued: 1 });
    drivers[0].events.ended();
    player.read(item(9));
    expect(player.snapshot()).toMatchObject({ current: item(9), queued: 2, overriding: true });
    drivers[1].events.ended();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 1, yielding: true, overriding: false });
    player.setDecision(null);
    expect(drivers[2].played.seq).toBe(1);
    drivers[2].events.ended(); expect(drivers[3].played.seq).toBe(2);
  });

  it('失败时手动重听和决策变化不丢失败项，停止则明确清空', () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2)]);
    drivers[0].events.failed('失败'); player.setDecision({ id: 'd1' }); player.read(item(8));
    player.setDecision({ id: 'd2' }); drivers[1].events.ended();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 1, failed: true, yielding: true, error: '失败' });
    player.stop(); expect(player.snapshot()).toMatchObject({ current: null, queued: 0, enabled: false });
  });

  it('相同发言的手动重听成功才消除自动待播，失败则保留', () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2)]);
    player.read(item(2)); drivers[1].events.failed('重听失败');
    expect(player.snapshot()).toMatchObject({ current: item(2), queued: 2, failed: true });
    player.retry(); drivers[2].events.ended();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 0 });
    drivers[3].events.ended(); expect(player.snapshot().current).toBeNull();
  });

  it('手动插播结束后保留自动队列的暂停选择，继续时才播放原队列', async () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2)]);
    await player.togglePause(); player.read(item(9));
    expect(drivers[1].played.seq).toBe(9);
    drivers[1].events.ended();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 1, paused: true });
    expect(drivers).toHaveLength(2);
    await player.togglePause(); expect(drivers[2].played.seq).toBe(1);
    drivers[2].events.ended(); expect(drivers[3].played.seq).toBe(2);
  });

  it('行动变化中断手动插播后仍保留自动暂停，迟到回调不恢复播放', async () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2)]);
    await player.togglePause(); player.setDecision({ id: 'd1' }); player.read(item(9));
    player.setDecision(null); drivers[1].events.ended();
    expect(player.snapshot()).toMatchObject({ current: item(1), queued: 1, paused: true });
    expect(drivers).toHaveLength(2);
    await player.togglePause(); expect(drivers[2].played.seq).toBe(1);
  });

  it('暂停期间重听同一条并完成后仍可继续后续队列', async () => {
    const { player, drivers } = setup();
    player.sync([item(1)]); player.start([item(1)]); player.sync([item(1), item(2)]);
    await player.togglePause(); player.read(item(1)); drivers[1].events.ended();
    expect(player.snapshot()).toMatchObject({ current: null, queued: 1, paused: true });
    await player.togglePause(); expect(drivers[2].played.seq).toBe(2);
  });

  it('凭证上下文替换时销毁旧控制器，旧队列与晚到回调不进入新控制器', () => {
    const old = setup(); old.player.sync([item(1)]); old.player.start([item(1)]); old.player.sync([item(1), item(2)]);
    old.player.dispose();
    const next = setup(); next.player.sync([item(10)]); next.player.start([item(10)]);
    old.drivers[0].events.ended(); old.drivers[0].events.failed('晚到');
    expect(next.player.snapshot()).toMatchObject({ current: item(10), queued: 0, error: '' });
    expect(next.drivers[0].played.seq).toBe(10);
  });

  it('旧恢复请求在凭证切换后完成，不通知新作用域；控制器可在严格模式清理后复用', async () => {
    let finishResume!: () => void;
    const pending = new Promise<void>((resolve) => { finishResume = resolve; });
    const notify = vi.fn(), player = new SpeechPlaybackController(notify), drivers: FakeOutput[] = [];
    const source = () => { const driver = new FakeOutput(); drivers.push(driver); return driver; };
    player.setSource(source); player.sync([item(1)]); player.start([item(1)]);
    await player.togglePause(); drivers[0].resume = () => pending;
    const resume = player.togglePause();
    player.dispose();
    // React 严格模式会对同一个控制器执行清理和重建 effects。
    player.setSource(source);
    expect(drivers[1].played.seq).toBe(1);
    notify.mockClear(); finishResume(); await resume;
    expect(notify).not.toHaveBeenCalled();
    expect(player.snapshot()).toMatchObject({ current: item(1), paused: false });
  });
});

describe('真人行动窗口授权范围', () => {
  const room = { viewer: 'seat', seat: 1, status: 'running', paused: false, seats: [{ seat: 1, controller: 'human' }, { seat: 2, controller: 'ai' }] } as RoomBrief;
  const projection = { task: { decisionId: 'd1', submitted: false } } as Projection;
  it('仅正在运行且未提交的真人本人任务触发让行；预告时间原样传递', () => {
    expect(humanDecisionWindow(room, projection, { deaths: [], actionAvailableAt: 2000 })).toEqual({ id: 'd1', availableAt: 2000 });
    expect(humanDecisionWindow({ ...room, viewer: 'host' }, projection)).toBeNull();
    expect(humanDecisionWindow({ ...room, seat: 2 }, projection)).toBeNull();
    expect(humanDecisionWindow({ ...room, paused: true }, projection)).toBeNull();
    expect(humanDecisionWindow({ ...room, status: 'ended' }, projection)).toBeNull();
    expect(humanDecisionWindow(room, { ...projection, task: { ...projection.task!, submitted: true } })).toBeNull();
  });
});
