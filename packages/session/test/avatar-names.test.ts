import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_STYLES, avatarDefaultName, type AvatarStyleId } from '@werewolf/protocol';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });

function room(avatarStyle: AvatarStyleId = 'storybook') {
  const store = new MemoryStore(), secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store, secrets, tickMs: 0 });
  managers.push(manager);
  const { roomId, hostToken } = manager.createRoom({ avatarStyle });
  return { manager, store, secrets, roomId, hostToken };
}

describe('人物默认昵称', () => {
  it.each(AVATAR_STYLES)('$name 的 12 位人物均有不重名且符合昵称长度限制的名字', (style) => {
    expect(style.characters).toHaveLength(12);
    const names = style.characters.map((character) => character.defaultName);
    expect(new Set(names).size).toBe(12);
    expect(names.every((name) => name.trim() === name && name.length > 0 && [...name].length <= 12)).toBe(true);
    const pattern = ['campus', 'gufeng'].includes(style.id) ? /^\p{Script=Han}+$/u : /^[A-Za-z]+$/;
    expect(names.every((name) => pattern.test(name))).toBe(true);
  });

  it.each(AVATAR_STYLES)('创建 $name 房间后，各视角获得一致的默认昵称与人物风格', (style) => {
    const { manager, roomId, hostToken } = room(style.id);
    const setup = manager.getSetup(roomId, hostToken);
    expect(setup.avatarStyle).toBe(style.id);
    expect(setup.seats.map((seat) => seat.name)).toEqual(style.characters.map((character) => character.defaultName));
    for (const token of [hostToken, setup.tokens.seats[0].token, setup.tokens.spectator]) {
      expect(manager.view(roomId, token).room).toMatchObject({ avatarStyle: style.id, seats: setup.seats.map(({ seat, name, controller }) => ({ seat, name, controller })) });
      expect(JSON.stringify(manager.view(roomId, token))).not.toContain('nameSource');
    }
    expect(JSON.stringify(setup)).not.toContain('nameSource');
  });

  it('只更新默认昵称，手动填写的名字即使与默认名相同也保留；留空恢复跟随', () => {
    const { manager, roomId, hostToken } = room();
    manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, name: 'Oliver' }, { seat: 2, name: '我的昵称' }] });
    let setup = manager.updateSetup(roomId, hostToken, { avatarStyle: 'campus' });
    expect(setup.seats.slice(0, 4).map((seat) => seat.name)).toEqual(['Oliver', '我的昵称', '叶山', '团子']);
    setup = manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, name: '  ' }] });
    expect(setup.seats[0].name).toBe('大老师');
    setup = manager.updateSetup(roomId, hostToken, { avatarStyle: 'gufeng' });
    expect(setup.seats[0].name).toBe(avatarDefaultName('gufeng', 1));
    expect(setup.seats[1].name).toBe('我的昵称');
  });

  it('换版型新增座位沿用房间人物风格，复制与重启保留昵称来源', () => {
    const { manager, store, secrets, roomId, hostToken } = room('campus');
    manager.updateSetup(roomId, hostToken, { presetId: 'classic9', seats: [{ seat: 1, name: '大老师' }] });
    const expanded = manager.updateSetup(roomId, hostToken, { presetId: 'standard12' });
    expect(expanded.seats.slice(9).map((seat) => seat.name)).toEqual(['三浦', '户部', '海老名']);
    const copy = manager.cloneRoom(roomId, hostToken);
    expect(manager.getSetup(copy.roomId, copy.hostToken).avatarStyle).toBe('campus');
    manager.dispose();
    const restored = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(restored);
    const setup = restored.updateSetup(copy.roomId, copy.hostToken, { avatarStyle: 'future' });
    expect(setup.seats[0].name).toBe('大老师');
    expect(setup.seats[1].name).toBe(avatarDefaultName('future', 2));
  });

  it('旧存档读取不改名，显式选择风格后仅替换旧座位号昵称', () => {
    const { manager, store, secrets, roomId, hostToken } = room();
    manager.dispose();
    const record = store.rooms.get(roomId)!;
    delete record.avatarStyle;
    for (const seat of record.seats) { delete seat.nameSource; seat.name = `${seat.seat}号`; }
    record.seats[1].name = 'Alice';
    const restored = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(restored);
    expect(restored.getSetup(roomId, hostToken).seats[0].name).toBe('1号');
    const setup = restored.updateSetup(roomId, hostToken, { avatarStyle: 'campus' });
    expect(setup.seats.slice(0, 3).map((seat) => seat.name)).toEqual(['大老师', 'Alice', '叶山']);
  });

  it('真人确认默认昵称后仍能跟随风格，改名后要求重新确认，真人自定义昵称保留', () => {
    const { manager, roomId, hostToken } = room();
    let setup = manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, controller: 'human' }, { seat: 2, controller: 'human' }] });
    manager.participate(roomId, setup.tokens.seats[0].token, { name: setup.seats[0].name, ready: true });
    manager.participate(roomId, setup.tokens.seats[1].token, { name: '真人昵称', ready: true });
    setup = manager.updateSetup(roomId, hostToken, { avatarStyle: 'campus' });
    expect(setup.seats.slice(0, 2).map((seat) => seat.name)).toEqual(['大老师', '真人昵称']);
    expect(setup.participants.map((participant) => participant.ready)).toEqual([false, true]);
  });

  it('拒绝未知风格与座位凭证修改；开局后冻结风格和昵称', () => {
    const { manager, roomId, hostToken } = room('campus');
    const setup = manager.getSetup(roomId, hostToken);
    expect(() => manager.createRoom({ avatarStyle: 'unknown' } as never)).toThrow('人物风格');
    expect(() => manager.updateSetup(roomId, hostToken, { avatarStyle: 'unknown' } as never)).toThrow('人物风格');
    expect(() => manager.updateSetup(roomId, setup.tokens.seats[0].token, { avatarStyle: 'gufeng' })).toThrow('房主');
    manager.start(roomId, hostToken);
    expect(() => manager.updateSetup(roomId, hostToken, { avatarStyle: 'gufeng' })).toThrow('已经开始');
    expect(() => manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, name: '新昵称' }] })).toThrow('已经开始');
    expect(manager.view(roomId, hostToken).projection!.seats.map((seat) => seat.name)).toEqual(setup.seats.map((seat) => seat.name));
  });
});
