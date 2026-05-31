import fs from 'fs/promises';
import path from 'path';
import { type FastIndex, netcoreReleaseCandidates } from './netcore-fast-index.js';

export interface ReleaseSiteMappingEntry {
  site: string;
  project: string;
  source: string;
  terms: string[];
}

export interface ReleaseSiteMappingResult {
  summary: {
    scope: string;
    changedFiles: number;
    changedProjects: number;
    candidateServices: number;
    releaseSites: number;
    unmappedProjects: number;
  };
  releaseSites: string[];
  unmappedProjects: string[];
  matchedProjects: Record<string, string[]>;
  releaseCandidates: ReturnType<typeof netcoreReleaseCandidates>['releaseCandidates'];
  mapping: string;
  refresh?: unknown;
}

export function defaultReleaseSiteMappingPath(repoPath: string): string {
  return path.join(repoPath, 'docs', '发布站点MQ对应关系梳理.md');
}

export function parseReleaseSiteMapping(markdown: string): ReleaseSiteMappingEntry[] {
  const entries: ReleaseSiteMappingEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = parseMarkdownRow(line);
    if (!cells) continue;

    const confirmed = parseConfirmedMappingRow(cells);
    if (confirmed) entries.push(confirmed);

    const siteList = parseAllSitesRow(cells);
    if (siteList) entries.push(siteList);
  }
  return dedupeEntries(entries);
}

export function mapProjectsToReleaseSites(
  projects: string[],
  entries: ReleaseSiteMappingEntry[],
): {
  releaseSites: string[];
  unmappedProjects: string[];
  matchedProjects: Record<string, string[]>;
} {
  const releaseSites = new Set<string>();
  const unmappedProjects: string[] = [];
  const matchedProjects: Record<string, string[]> = {};

  for (const project of unique(projects.filter(Boolean))) {
    const matches = entries.filter((entry) => entryMatches(entry, project));
    if (matches.length === 0) {
      unmappedProjects.push(project);
      continue;
    }
    const sites = unique(matches.map((m) => m.site).filter(Boolean)).sort();
    matchedProjects[project] = sites;
    for (const site of sites) releaseSites.add(site);
  }

  return {
    releaseSites: Array.from(releaseSites).sort(),
    unmappedProjects: unmappedProjects.sort(),
    matchedProjects,
  };
}

export async function netcoreReleaseSites(
  index: FastIndex,
  repoPath: string,
  options?: { scope?: string; baseRef?: string; mappingPath?: string },
): Promise<ReleaseSiteMappingResult> {
  const scope = options?.scope ?? 'unstaged';
  const candidates = netcoreReleaseCandidates(index, repoPath, scope, options?.baseRef);
  const mappingPath = options?.mappingPath ?? defaultReleaseSiteMappingPath(repoPath);
  const markdown = await fs.readFile(mappingPath, 'utf-8');
  const entries = parseReleaseSiteMapping(markdown);
  const projects = collectReleaseCandidateTerms(candidates);
  const mapped = mapProjectsToReleaseSites(projects, entries);

  return {
    summary: {
      ...candidates.summary,
      releaseSites: mapped.releaseSites.length,
      unmappedProjects: mapped.unmappedProjects.length,
    },
    ...mapped,
    releaseCandidates: candidates.releaseCandidates,
    mapping: mappingPath,
  };
}

function collectReleaseCandidateTerms(
  candidates: ReturnType<typeof netcoreReleaseCandidates>,
): string[] {
  const terms: string[] = [];
  for (const candidate of candidates.releaseCandidates) {
    terms.push(candidate.path, candidate.name, candidate.service, ...candidate.reasonProjects);
  }
  for (const project of candidates.projects) {
    terms.push(project.path, project.name, ...project.releaseCandidates);
  }
  return unique(terms);
}

function parseMarkdownRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cleanCell(cell));
  if (cells.length < 3 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return undefined;
  return cells;
}

function parseConfirmedMappingRow(cells: string[]): ReleaseSiteMappingEntry | undefined {
  if (cells.length < 6 || !/^\d+$/.test(cells[0]) || !cells[3]) return undefined;
  const project = cells[2] || cells[1];
  if (!looksLikeProjectOrPath(project) && !looksLikeProjectOrPath(cells[1])) return undefined;
  return {
    site: cells[3],
    project,
    source: 'confirmed-site-mapping',
    terms: expandTerms([cells[1], cells[2], cells[4], cells[5]]),
  };
}

function parseAllSitesRow(cells: string[]): ReleaseSiteMappingEntry | undefined {
  if (cells.length < 6 || cells[1] !== 'Server_DotNetCore' || !cells[2] || !cells[3]) {
    return undefined;
  }
  return {
    site: cells[2],
    project: cells[3],
    source: 'all-sites',
    terms: expandTerms([cells[3]]),
  };
}

function entryMatches(entry: ReleaseSiteMappingEntry, project: string): boolean {
  const target = normalizeForMatch(project);
  if (!target) return false;
  return entry.terms.some((term) => {
    const normalized = normalizeForMatch(term);
    if (!normalized) return false;
    return target === normalized || target.includes(normalized) || normalized.includes(target);
  });
}

function expandTerms(values: string[]): string[] {
  const terms: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[;,，；、]/)) {
      const cleaned = cleanCell(part);
      if (!cleaned || isGenericTerm(cleaned)) continue;
      terms.push(cleaned);
      if (cleaned.endsWith('.csproj')) {
        terms.push(path.posix.basename(cleaned), cleaned.replace(/\.csproj$/i, ''));
      }
      if (cleaned.includes('/')) {
        terms.push(cleaned.split('/').at(-1)!);
        const parent = cleaned.split('/').slice(0, -1).join('/');
        if (parent && !isGenericTerm(parent)) terms.push(parent);
      }
    }
  }
  return unique(terms.filter((term) => !isGenericTerm(term)));
}

function looksLikeProjectOrPath(value: string): boolean {
  return (
    /\.csproj\b/i.test(value) ||
    /\bAIHelp\./i.test(value) ||
    /\bHosts?\//i.test(value) ||
    /\bHost\//i.test(value)
  );
}

function cleanCell(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\.csproj\b/gi, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9_\-./\u4e00-\u9fff]/gi, '')
    .toLowerCase();
}

function isGenericTerm(value: string): boolean {
  const normalized = normalizeForMatch(value);
  return (
    normalized.length < 4 ||
    normalized === 'hosts' ||
    normalized === 'host' ||
    normalized === 'server_dotnetcore' ||
    normalized === 'serverdotnetcore' ||
    normalized === 'webapi' ||
    normalized === 'webapi站点' ||
    normalized === '后台服务' ||
    normalized === '消费服务' ||
    normalized === '已确认' ||
    normalized === '用户确认'
  );
}

function dedupeEntries(entries: ReleaseSiteMappingEntry[]): ReleaseSiteMappingEntry[] {
  const seen = new Set<string>();
  const out: ReleaseSiteMappingEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.site}\0${entry.project}\0${entry.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
