import { useEffect, useRef, useState } from 'react';
import { AVATAR_STYLES, currentAvatarStyle, selectAvatarStyle, type AvatarStyleId } from '../avatar-style';
import { Avatar } from './Avatar';
import { Icon } from './Icons';

export function AvatarStylePicker() {
  const [selected, setSelected] = useState(currentAvatarStyle);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target) && ref.current) ref.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  const pick = (id: AvatarStyleId) => {
    selectAvatarStyle(id); setSelected(id);
    if (ref.current) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); }
  };
  return (
    <details className="avatar-picker" ref={ref}>
      <summary><Icon name="cards" size={16} /><span>人物风格</span><small>{AVATAR_STYLES.find((s) => s.id === selected)?.name}</small></summary>
      <div className="avatar-picker-popup">
        <div className="picker-heading"><div><span className="eyebrow">CHARACTER COLLECTION</span><h3>选择你的来客</h3></div><span className="tag">6 套主题</span></div>
        <div className="avatar-style-grid">{AVATAR_STYLES.map((style) => <button key={style.id} className={'avatar-style-option ' + (selected === style.id ? 'on' : '')} onClick={() => pick(style.id)} aria-pressed={selected === style.id}>
          <span className="style-preview"><Avatar seat={1} size={44} styleId={style.id} /><Avatar seat={2} size={48} styleId={style.id} /><Avatar seat={4} size={44} styleId={style.id} /></span>
          <b>{style.name}</b><small>{style.detail}</small>{selected === style.id && <span className="style-check"><Icon name="check" size={13} /></span>}
        </button>)}</div>
        <p className="picker-note">每套 12 位不同人物 · 仅更换外观，不改变游戏身份</p>
      </div>
    </details>
  );
}
