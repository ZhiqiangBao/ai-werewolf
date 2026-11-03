import { useI18n } from '../i18n';
export function paginate<T>(items: readonly T[], requestedPage: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(1, Math.min(requestedPage, pageCount));
  return { page, pageCount, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

export function Pagination({ label, page, pageCount, onChange }: { label: string; page: number; pageCount: number; onChange: (page: number) => void }) {
  const { t, locale } = useI18n();
  if (pageCount <= 1) return null;
  return <nav className="list-pagination" aria-label={t('{0}分页', label)}>
    <span className="small muted" aria-live="polite">{t('第 {0} / {1} 页', new Intl.NumberFormat(locale).format(page), new Intl.NumberFormat(locale).format(pageCount))}</span>
    <button className="btn sm ghost" type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t('上一页')}</button>
    <button className="btn sm" type="button" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>{t('下一页')}</button>
  </nav>;
}
