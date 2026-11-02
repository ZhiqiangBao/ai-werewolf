import { formalSyntheticPlan, overheadSyntheticPlan, SYNTHETIC_PROTOCOLS, SYNTHETIC_SCENARIOS, SYNTHETIC_SEEDS, type SyntheticProtocol } from '../src/observability/synthetic-plan';
import { runSyntheticBaseline, type RunnableSyntheticScenario } from '../src/observability/synthetic-run';
import { runSyntheticProbe } from '../src/observability/synthetic-probe';
import { runSyntheticOverhead } from '../src/observability/synthetic-overhead';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--plan')) {
    console.log(JSON.stringify({ scenarios: SYNTHETIC_SCENARIOS, formal: formalSyntheticPlan(), overhead: overheadSyntheticPlan(), status: 'planned_not_executed' }, null, 2));
    return;
  }
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const scenario = option('--scenario') ?? 'S01', protocol = option('--protocol') ?? 'chat_completions', seed = option('--seed') ?? SYNTHETIC_SEEDS[0];
  if (args.includes('--overhead') || args.includes('--overhead-sample')) {
    if (!['S01', 'S02'].includes(scenario)) throw new Error('Overhead pairing requires S01 or S02');
    if (!SYNTHETIC_PROTOCOLS.includes(protocol as SyntheticProtocol) || !SYNTHETIC_SEEDS.includes(seed as typeof SYNTHETIC_SEEDS[number])) throw new Error('Unknown protocol or seed');
    if (args.includes('--overhead-sample')) {
      const mode = option('--observation');
      if (mode !== 'on' && mode !== 'off') throw new Error('Overhead sample requires --observation on|off');
      const result = await runSyntheticBaseline({ scenario: scenario as 'S01' | 'S02', protocol: protocol as SyntheticProtocol,
        seed: seed as typeof SYNTHETIC_SEEDS[number], observation: mode === 'on', fixtureWindow: true, repetition: Number(option('--repetition') ?? 1) });
      console.log(JSON.stringify(result));
    } else {
      const result = await runSyntheticOverhead({ scenario: scenario as 'S01' | 'S02', protocol: protocol as SyntheticProtocol,
        pairs: Number(option('--pairs') ?? 30), ...(option('--seed') ? { seed: seed as typeof SYNTHETIC_SEEDS[number] } : {}) });
      console.log(`Paired overhead output: ${result.directory} (${result.summary.status})`);
    }
    return;
  }
  if (scenario === 'S10' || scenario === 'S11') {
    if (!SYNTHETIC_PROTOCOLS.includes(protocol as SyntheticProtocol)) throw new Error('Unknown protocol');
    const probe = option('--case') ?? (scenario === 'S10' ? 'before_headers' : 'abort');
    if (!['before_headers', 'after_content', 'backoff', 'abort'].includes(probe)) throw new Error('Unknown adapter probe');
    const repeat = Number(option('--repeat') ?? 1);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('Repeat must be an integer from 1 to 100');
    for (let repetition = 1; repetition <= repeat; repetition++) {
      const result = await runSyntheticProbe({ scenario, protocol: protocol as SyntheticProtocol, probe: probe as 'before_headers' | 'after_content' | 'backoff' | 'abort', repetition });
      console.log(`Adapter probe: ${result.directory}`);
    }
    return;
  }
  if (!['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S12', 'S13', 'S14', 'S15'].includes(scenario)) throw new Error('This scenario is planned but not yet implemented');
  if (!SYNTHETIC_PROTOCOLS.includes(protocol as SyntheticProtocol)) throw new Error('Unknown protocol');
  if (!SYNTHETIC_SEEDS.includes(seed as typeof SYNTHETIC_SEEDS[number])) throw new Error('Unknown fixed seed');
  const faultCase = option('--case');
  if (faultCase && !(scenario === 'S07' && ['status', 'network'].includes(faultCase)) && !(scenario === 'S09' && ['stream', 'required', 'json', 'combined'].includes(faultCase)) &&
      !(scenario === 'S13' && ['save', 'audit', 'file'].includes(faultCase)) && !(scenario === 'S14' && ['reported', 'omitted'].includes(faultCase)) &&
      !(scenario === 'S15' && ['control', 'parse', 'disconnect', 'no_content', 'local_config', 'sink_throw', 'write_failure'].includes(faultCase)))
    throw new Error('Unknown or unsupported scenario case');
  const formal = args.includes('--formal');
  if (formal && !['S01', 'S02', 'S03'].includes(scenario)) throw new Error('Formal topology matrix is available only for S01–S03; fault acceptance is not implemented');
  const repeat = formal ? 3 : Number(option('--repeat') ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('Repeat must be an integer from 1 to 100');
  const protocols = formal && !option('--protocol') ? SYNTHETIC_PROTOCOLS : [protocol as SyntheticProtocol];
  const seeds = formal && !option('--seed') ? SYNTHETIC_SEEDS : [seed as typeof SYNTHETIC_SEEDS[number]];
  for (const selectedProtocol of protocols) {
    if (formal) {
      const warmup = await runSyntheticBaseline({ scenario: scenario as RunnableSyntheticScenario, protocol: selectedProtocol, seed: seeds[0], repetition: 0, warmup: true });
      console.log(`Warmup: ${warmup.directory}`);
    }
    for (const selectedSeed of seeds) for (let repetition = 1; repetition <= repeat; repetition++) {
      const result = await runSyntheticBaseline({ scenario: scenario as RunnableSyntheticScenario, protocol: selectedProtocol, seed: selectedSeed, repetition, faultCase });
      console.log(`Measurement: ${result.directory}`);
    }
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Synthetic run failed'); process.exitCode = 1; });
