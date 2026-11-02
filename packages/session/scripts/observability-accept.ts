import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateBaselineEvidence, type BaselineEvidence } from '../src/observability/acceptance';

async function main() {
  const args = process.argv.slice(2), outputFlag = args.indexOf('--output');
  const output = resolve(outputFlag >= 0 ? args.splice(outputFlag, 2)[1] : 'data/diagnostics/accuracy-acceptance');
  const partial = args.includes('--partial');
  const directories = args.filter((s) => s !== '--partial');
  if (!directories.length) throw new Error('请传入合成运行目录；默认要求完整三拓扑三协议矩阵');
  const rows: BaselineEvidence[] = [];
  for (const dir of directories) {
    const jsonl = async (file: string) => (await readFile(resolve(dir, file), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    rows.push({ manifest: JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')),
      observations: await jsonl('observations.jsonl'), truth: await jsonl('synthetic-truth.jsonl') });
  }
  const result = evaluateBaselineEvidence(rows, !partial);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'report.md'), `# 本机合成计时准确度\n\n状态：${result.status}。保留全部样本，未删除异常值。\n\n` +
    '| 场景／协议 | 正式／预热 | HTTP／真值 | 状态 |\n| --- | --- | --- | --- |\n' +
    result.results.map((r) => `| ${r.key} | ${r.formalRuns}／${r.warmups} | ${r.attempts}／${r.matchedTruth} | ${r.status} |`).join('\n') + '\n');
  console.log(`Accuracy output: ${output} (${result.status})`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Accuracy evaluation failed'); process.exitCode = 1; });
