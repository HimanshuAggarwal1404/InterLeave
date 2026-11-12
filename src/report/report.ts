// Package report turns run results into text for the terminal (FR-20, FR-24)
// and into schedule.json files that `interleave replay` reads back (FR-21).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ScenarioRequest } from '../scenario/index.ts';
import type { Decision, ExecutedStep } from '../sched/run.ts';
import type { Outcome } from '../oracle/index.ts';
import type { ExploreSummary, RunResult, Strategy } from '../runner/types.ts';

// stripTag removes the leading /* il:req=X */ comment and collapses whitespace.
export function stripTag(sql: string): string {
  return sql
    .replace(/^\s*\/\*.*?\*\/\s*/s, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// stepSummary describes what a statement did: its first value, its row count,
// or its error. Empty for statements like BEGIN whose result says nothing new.
export function stepSummary(step: ExecutedStep): string {
  const parts: string[] = [];
  if (step.status === undefined) {
    parts.push('(no reply)');
  } else if (step.result?.error !== undefined) {
    parts.push(`✗ ${step.result.error.code} ${step.result.error.message}`);
  } else if (step.result?.firstValue !== undefined) {
    parts.push(`→ ${step.result.firstValue ?? 'NULL'}`);
  } else if (step.result?.command !== undefined && /^(UPDATE|INSERT|DELETE|SELECT)\b/.test(step.result.command)) {
    parts.push(`→ ${step.result.command}`);
  }
  if (step.blocked) {
    const by = step.blockedBy ?? [];
    parts.push(by.length === 0 ? '(waited for a lock)' : `(waited for ${by.join(' and ')}'s lock)`);
  }
  return parts.join(' ');
}

// formatTimeline prints one column per request and one row per statement, in
// the order the statements ran, each with what it did.
export function formatTimeline(result: RunResult, requests: readonly ScenarioRequest[], width = 110): string {
  const tags = requests.map((r) => r.tag);
  const col = Math.max(34, Math.floor(width / Math.max(tags.length, 1)));
  const cell = (text: string) => (text.length > col - 2 ? `${text.slice(0, col - 3)}…` : text).padEnd(col);
  const lines: string[] = [];
  lines.push(
    requests
      .map((r) => cell(`Request ${r.tag}: ${r.method} ${r.path}${r.body === undefined ? '' : ` ${JSON.stringify(r.body)}`}`))
      .join('')
      .trimEnd(),
  );
  for (const step of result.trace.steps) {
    const summary = stepSummary(step);
    const sql = stripTag(step.sql);
    const room = col - 2 - (summary === '' ? 0 : summary.length + 1);
    const text = (sql.length > room ? `${sql.slice(0, Math.max(room - 1, 8))}…` : sql) + (summary === '' ? '' : ` ${summary}`);
    const at = tags.indexOf(step.tag);
    lines.push((' '.repeat(col * Math.max(at, 0)) + cell(text)).trimEnd());
  }
  lines.push('');
  for (const r of result.responses) {
    lines.push(`Request ${r.tag} → ${r.error === undefined ? `HTTP ${r.status} ${r.body.trim()}` : `failed: ${r.error}`}`);
  }
  for (const inv of result.invariants) {
    lines.push(inv.ok ? `✓ ${inv.name}` : `✗ ${inv.name} (got ${inv.error === undefined ? inv.value : `error: ${inv.error}`})`);
  }
  if (result.serial !== undefined) {
    lines.push(...formatSerial(result.serial));
  }
  return lines.join('\n');
}

// formatSerial shows the serial oracle's verdict: on a race, this run's
// outcome next to what each one-at-a-time order gives.
function formatSerial(check: NonNullable<RunResult['serial']>): string[] {
  if (check.matched !== undefined) {
    return [`✓ same result as running them one at a time (${check.matched.join(' then ')})`];
  }
  const show = (o: Outcome) =>
    [...Object.entries(o.tables).map(([t, rows]) => `${t} ${JSON.stringify(rows)}`), Object.entries(o.statuses).sort(([a], [b]) => a.localeCompare(b)).map(([tag, st]) => `${tag} ${st}`).join(', ')].join(' · ');
  return [
    '✗ the result matches no one-at-a-time order:',
    `    this run:        ${show(check.outcome)}`,
    ...check.serialOutcomes.map(({ order, outcome }) => `    ${`${order.join(' then ')}:`.padEnd(16)} ${show(outcome)}`),
  ];
}

// describeFindings says in words what a run found.
export function describeFindings(result: RunResult): string {
  const parts: string[] = [];
  if (result.findings.includes('invariant')) {
    const broken = result.invariants.filter((i) => !i.ok).map((i) => `"${i.name}"`);
    parts.push(`invariant ${broken.join(', ')} broke`);
  }
  if (result.findings.includes('deadlock')) {
    parts.push('Postgres detected a deadlock (40P01)');
  }
  if (result.findings.includes('serial')) {
    parts.push('the result matches no one-at-a-time order');
  }
  return parts.join('; ');
}

// describeShrink says how a finding was simplified, or '' if it was not.
export function describeShrink(result: RunResult): string {
  const s = result.shrunk;
  if (s === undefined) {
    return '';
  }
  if (s.toSwitches === s.fromSwitches) {
    return `Already as simple as it gets: ${s.toSwitches} switch${s.toSwitches === 1 ? '' : 'es'} between requests (${s.attempts} runs to check).`;
  }
  return `Shrunk from ${s.fromSwitches} to ${s.toSwitches} switches between requests (${s.attempts} extra runs; first seen in run ${s.fromRun}).`;
}

// formatSummary is the closing report of `interleave run` (FR-24).
export function formatSummary(s: ExploreSummary): string {
  const lines: string[] = [];
  const rate = (n: number, secs: number) => (secs > 0 ? (n / secs).toFixed(1) : '-');
  if (s.error !== undefined) {
    lines.push(`Stopped: ${s.error}`);
  } else if (s.findings.length > 0) {
    lines.push(`RACE FOUND: ${s.findings.length} finding${s.findings.length === 1 ? '' : 's'} in ${s.runs} run${s.runs === 1 ? '' : 's'}.`);
  } else if (s.interrupted) {
    lines.push(`Interrupted after ${s.runs} runs: no violation so far.`);
  } else if (s.strategy === 'exhaustive' && s.complete) {
    lines.push(`No violation. Complete: all ${s.runs} orders checked (exhaustive).`);
  } else if (s.strategy === 'exhaustive') {
    lines.push(`No violation in ${s.runs} orders, but stopped at --max-runs ${s.maxRuns}: more orders remain.`);
  } else {
    const how = s.strategy === 'pct' ? `PCT orders (seed ${s.seed}, depth ${s.depth ?? 2})` : `random orders (seed ${s.seed})`;
    lines.push(`No violation in ${s.runs} ${how}; random search never proves an app clean.`);
  }
  let stats = `${s.runs} runs in ${s.seconds.toFixed(2)}s (${rate(s.runs, s.seconds)} runs/s, resets ${rate(s.runs, s.resetSeconds)}/s)`;
  if (s.firstFindingAfterRuns !== undefined && s.firstFindingAfterSeconds !== undefined) {
    stats += `; first finding after ${s.firstFindingAfterRuns} run${s.firstFindingAfterRuns === 1 ? '' : 's'} (${s.firstFindingAfterSeconds.toFixed(2)}s)`;
  }
  lines.push(stats);
  return lines.join('\n');
}

// ScheduleFile is a finding saved for replay (FR-21).
export type ScheduleFile = {
  version: 1;
  scenario: string; // path of the scenario file, relative to the folder replay runs in if possible
  name: string;
  strategy: Strategy;
  seed: number;
  run: number;
  choices: string[]; // the chosen request at every decision, in order: all replay needs
  decisions: Decision[];
  findings: RunResult['findings'];
  invariants: RunResult['invariants'];
  responses: Array<{ tag: string; status: number; body: string }>;
  steps: ExecutedStep[];
};

export function toScheduleFile(s: ExploreSummary, result: RunResult): ScheduleFile {
  const rel = relative(process.cwd(), s.scenarioFile);
  return {
    version: 1,
    scenario: rel.startsWith('..') ? s.scenarioFile : rel.replaceAll('\\', '/'),
    name: s.scenarioName,
    strategy: s.strategy,
    seed: s.seed,
    run: result.index,
    choices: result.trace.decisions.map((d) => d.chosen),
    decisions: result.trace.decisions,
    findings: result.findings,
    invariants: result.invariants,
    responses: result.responses.map((r) => ({ tag: r.tag, status: r.status, body: r.body })),
    steps: result.trace.steps,
  };
}

// writeSchedule saves a finding as <dir>/<scenario>-<run>.json and returns the path.
export async function writeSchedule(dir: string, file: ScheduleFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${file.name}-${file.run}.json`);
  await writeFile(path, JSON.stringify(file, null, 2) + '\n');
  return path;
}

// readSchedule loads a schedule file and checks the fields replay needs.
export async function readSchedule(path: string): Promise<ScheduleFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read schedule ${path}: ${(err as Error).message}`);
  }
  const f = parsed as Partial<ScheduleFile>;
  if (f.version !== 1 || typeof f.scenario !== 'string' || !Array.isArray(f.choices) || !f.choices.every((c) => typeof c === 'string')) {
    throw new Error(`${path}: not an Interleave schedule file (want version 1 with scenario and choices)`);
  }
  return f as ScheduleFile;
}
