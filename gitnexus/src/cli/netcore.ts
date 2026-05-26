import { writeSync } from 'node:fs';
import {
  loadNetcoreFastIndex,
  netcoreImpact,
  netcoreMq,
  netcoreReleaseCandidates,
  netcoreSummary,
} from '../core/netcore-fast-index.js';

function output(value: unknown): void {
  writeSync(1, typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
}

export async function netcoreSummaryCommand(options?: { repo?: string }): Promise<void> {
  output(netcoreSummary(await loadNetcoreFastIndex(options?.repo ?? process.cwd())));
}

export async function netcoreImpactCommand(
  target: string,
  options?: { repo?: string },
): Promise<void> {
  output(netcoreImpact(await loadNetcoreFastIndex(options?.repo ?? process.cwd()), target));
}

export async function netcoreMqCommand(topic: string, options?: { repo?: string }): Promise<void> {
  output(netcoreMq(await loadNetcoreFastIndex(options?.repo ?? process.cwd()), topic));
}

export async function netcoreReleaseCandidatesCommand(options?: {
  repo?: string;
  scope?: string;
  baseRef?: string;
}): Promise<void> {
  const repoPath = options?.repo ?? process.cwd();
  output(
    netcoreReleaseCandidates(
      await loadNetcoreFastIndex(repoPath),
      repoPath,
      options?.scope ?? 'unstaged',
      options?.baseRef,
    ),
  );
}
