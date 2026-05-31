import { writeSync } from 'node:fs';
import {
  loadNetcoreFastIndex,
  netcoreImpact,
  netcoreMq,
  netcoreReleaseCandidates,
  netcoreSummary,
} from '../core/netcore-fast-index.js';
import { refreshNetcoreFastIndexForDiff } from '../core/netcore-fast-refresh.js';
import { netcoreReleaseSites } from '../core/netcore-release-sites.js';

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

export async function netcoreReleaseSitesCommand(options?: {
  repo?: string;
  scope?: string;
  baseRef?: string;
  mapping?: string;
  json?: boolean;
  refresh?: boolean;
}): Promise<void> {
  const repoPath = options?.repo ?? process.cwd();
  let index = await loadNetcoreFastIndex(repoPath);
  let refresh;
  if (options?.refresh !== false) {
    const refreshed = await refreshNetcoreFastIndexForDiff(index, repoPath, {
      scope: options?.scope ?? 'unstaged',
      baseRef: options?.baseRef,
    });
    index = refreshed.index;
    refresh = refreshed.result;
  }
  const result = await netcoreReleaseSites(index, repoPath, {
    scope: options?.scope ?? 'unstaged',
    baseRef: options?.baseRef,
    mappingPath: options?.mapping,
  });
  result.refresh = refresh;
  output(options?.json ? result : formatReleaseSites(result));
}

function formatReleaseSites(result: Awaited<ReturnType<typeof netcoreReleaseSites>>): string {
  const lines = [
    'Mapping: loaded',
    `Changed files: ${result.summary.changedFiles}`,
    `Changed projects: ${result.summary.changedProjects}`,
    `Candidate services: ${result.summary.candidateServices}`,
    ...(result.refresh
      ? [
          `Incremental refresh: ${String((result.refresh as { refreshedFiles?: number }).refreshedFiles ?? 0)} files`,
        ]
      : []),
    '',
    'Release sites:',
  ];

  if (result.releaseSites.length === 0) {
    lines.push('- (none)');
  } else {
    lines.push(...result.releaseSites.map((site) => `- ${site}`));
  }

  if (result.unmappedProjects.length > 0) {
    lines.push(
      '',
      'Unmapped projects:',
      ...result.unmappedProjects.map((project) => `- ${project}`),
    );
  }

  return lines.join('\n');
}
