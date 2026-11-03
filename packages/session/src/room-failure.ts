/** 会话入口共用同一个构造器；manager.ts 保留原导出路径。 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
