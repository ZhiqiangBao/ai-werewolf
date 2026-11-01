import { mkdir, writeFile } from 'node:fs/promises';
import { projectDir } from './project';
import { inspectMaterials } from './materials';

const report = await inspectMaterials();
await mkdir(`${projectDir}/output`, { recursive: true });
await writeFile(`${projectDir}/output/materials-check.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ready) throw Error('制作材料尚未就绪；查看 output/materials-check.json，按技能的准备步骤完成后再继续。没有调用 TTS。');
