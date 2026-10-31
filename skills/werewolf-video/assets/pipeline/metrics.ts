import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
export async function startGpuMonitor(output: string, intervalMs = 2000) {
  const samples: { time: string; totalMiB: number; usedMiB: number; freeMiB: number; freeRamMiB: number }[] = [];
  const sample = () => {
    try {
      const raw = execFileSync('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 4000 }).trim().split('\n')[0];
      const [totalMiB, usedMiB, freeMiB] = raw.split(',').map(Number);
      if ([totalMiB, usedMiB, freeMiB].every(Number.isFinite)) samples.push({ time: new Date().toISOString(), totalMiB, usedMiB, freeMiB, freeRamMiB: Math.round(freemem() / 2 ** 20) });
    } catch { /* CPU-only workflows do not need nvidia-smi. */ }
  };
  sample(); const timer = setInterval(sample, intervalMs); timer.unref();
  return async () => {
    clearInterval(timer); sample();
    const report = { scope: 'Whole first GPU; includes other applications, not per-process allocation', sampleIntervalMs: intervalMs,
      totalRamMiB: Math.round(totalmem() / 2 ** 20), samples: samples.length, totalVramMiB: samples[0]?.totalMiB ?? null,
      peakUsedVramMiB: samples.length ? Math.max(...samples.map((s) => s.usedMiB)) : null,
      minimumFreeVramMiB: samples.length ? Math.min(...samples.map((s) => s.freeMiB)) : null, readings: samples };
    await writeFile(output, JSON.stringify(report, null, 2)); return report;
  };
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/metrics.ts')) {
  const stop = await startGpuMonitor(process.argv[2] || 'data/video/gpu-metrics.json');
  await new Promise((r) => setTimeout(r, 45000));
  const report = await stop(); console.log(JSON.stringify({ samples: report.samples, peakUsedVramMiB: report.peakUsedVramMiB, totalVramMiB: report.totalVramMiB }));
}
