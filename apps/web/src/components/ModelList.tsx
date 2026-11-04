import { useI18n } from '../i18n';
import { useEffect, useId, useState } from 'react';
import type { ModelPresetView } from '@werewolf/protocol';
import { Pagination, paginate } from './Pagination';

export function ModelList({ models, onEdit, onRemove, busy }: { models: ModelPresetView[]; onEdit: (model: ModelPresetView) => void; onRemove: (id: string) => void | Promise<void>; busy: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const listId = useId();
  const visible = paginate(models, page, 8);
  useEffect(() => { setPage((current) => Math.min(current, visible.pageCount)); }, [visible.pageCount]);
  return <div className="model-collection">
    <button className="list-disclosure" type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => { setExpanded(!expanded); setPage(1); }}>
      <span>{expanded ? t('收起模型库') : t('展开模型库')}</span>
      <span className="disclosure-count">{t('{0} 个模型', models.length)}</span>
      <span className="disclosure-arrow" aria-hidden="true" />
    </button>
    <div id={listId} hidden={!expanded}>
      {expanded && (models.length ? <>
        <div className="model-list">
          {visible.items.map((m) => <div key={m.id} className="model-item">
            <span>{m.model}{m.source !== 'added' ? t(' · 已迁移') : ''}{!m.hasKey ? t(m.apiKeyEnv ? ' · 环境变量未设置' : ' · 未配置密钥') : ''}{m.lifecycle === 'disabled' ? t(' · 已停用') : m.lifecycle === 'archived' ? t(' · 已归档') : ''}</span>
            <span className="tiny dim">{m.baseUrl}</span>
            <div className="row">
              <button className="btn sm ghost" type="button" disabled={busy} onClick={() => onEdit(m)}>{t('编辑')}</button>
              <button className="btn sm ghost" type="button" disabled={busy} onClick={() => void onRemove(m.id)}>{t('删除')}</button>
            </div>
          </div>)}
        </div>
        <Pagination label={t('模型库')} page={visible.page} pageCount={visible.pageCount} onChange={setPage} />
      </> : <p className="small muted collection-empty">{t('尚未添加模型，可使用上方表单添加。')}</p>)}
    </div>
  </div>;
}
