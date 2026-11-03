/** 在旧连接事件迟到时，不把它转交给当前凭证。 */
export function scopedCallback(isCurrent: () => boolean, callback: () => void): () => void {
  return () => { if (isCurrent()) callback(); };
}

/** 单个凭证作用域内合并更新请求，丢弃停用或已切换作用域的迟到结果。 */
export class ViewLoader<T> {
  private active = false;
  private generation = 0;
  private busy = false;
  private dirty = false;
  constructor(private load: () => Promise<T>, private publish: (data: T | null, error: string | null) => void, private current: () => boolean) {}
  activate() { this.active = true; }
  deactivate() { this.active = false; this.generation++; this.busy = false; this.dirty = false; }
  async refresh(): Promise<void> {
    if (!this.active || !this.current()) return;
    if (this.busy) { this.dirty = true; return; }
    this.busy = true;
    const own = this.generation;
    const valid = () => this.active && this.current() && own === this.generation;
    try {
      do {
        this.dirty = false;
        const value = await this.load();
        if (!valid()) return;
        this.publish(value, null);
      } while (this.dirty);
    } catch (error) {
      if (valid()) this.publish(null, (error as Error).message);
    } finally {
      if (valid()) this.busy = false;
    }
  }
}
