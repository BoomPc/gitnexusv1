import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export type WorkspaceContractType = 'mq' | 'http' | 'project-ref';
export type WorkspaceEndpointRole = 'provider' | 'consumer' | 'reference';

export interface WorkspaceFastIndex {
  name: string;
  indexedAt: string;
  stats: {
    repos: number;
    filesScanned: number;
    bytesScanned: number;
    endpoints: number;
    contracts: number;
    skills: number;
    durationMs: number;
  };
  repos: WorkspaceRepoIndex[];
  contracts: WorkspaceContract[];
}

export interface WorkspaceRepoIndex {
  name: string;
  path: string;
  kind: string;
  branch?: string;
  commit?: string;
  stats: {
    filesScanned: number;
    bytesScanned: number;
    endpoints: number;
    skills: number;
    durationMs: number;
  };
  endpoints: WorkspaceEndpoint[];
  skills: WorkspaceSkill[];
}

export interface WorkspaceEndpoint {
  type: WorkspaceContractType;
  role: WorkspaceEndpointRole;
  key: string;
  repo: string;
  filePath: string;
  line: number;
  project?: string;
  symbol?: string;
  confidence: number;
}

export interface WorkspaceContract {
  type: WorkspaceContractType;
  key: string;
  providers: WorkspaceEndpoint[];
  consumers: WorkspaceEndpoint[];
  references: WorkspaceEndpoint[];
}

export interface WorkspaceSkill {
  name: string;
  path?: string;
  repo: string;
  triggers: string[];
}

export interface WorkspaceImpactResult {
  summary: {
    scope: string;
    changedFiles: number;
    changedRepos: number;
    affectedRepos: number;
    affectedContracts: number;
    skills: number;
  };
  changedFiles: Array<{ repo: string; path: string; status: string }>;
  affectedRepos: string[];
  affectedContracts: WorkspaceContract[];
  skillsToLoad: WorkspaceSkill[];
}

const DEFAULT_MAX_FILE_SIZE = 256 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  '.gitnexus',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'Pods',
  'DerivedData',
  '.gradle',
  '.idea',
  '.vs',
]);
const TEXT_EXTS = new Set([
  '.cs',
  '.csproj',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.swift',
  '.kt',
  '.java',
  '.m',
  '.mm',
  '.gradle',
  '.json',
]);

export function defaultWorkspaceIndexPath(name: string): string {
  return path.join(
    os.homedir(),
    '.gitnexus',
    'workspaces',
    safeName(name),
    'workspace-fast-index.json',
  );
}

export async function loadWorkspaceFastIndex(filePath: string): Promise<WorkspaceFastIndex> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as WorkspaceFastIndex;
}

export async function saveWorkspaceFastIndex(
  index: WorkspaceFastIndex,
  filePath = defaultWorkspaceIndexPath(index.name),
): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  return filePath;
}

export async function buildWorkspaceFastIndex(
  name: string,
  repoPaths: string[],
  options?: { maxFileSize?: number },
): Promise<WorkspaceFastIndex> {
  const started = Date.now();
  const repos: WorkspaceRepoIndex[] = [];
  for (const repoPath of repoPaths) {
    repos.push(await indexWorkspaceRepo(repoPath, options));
  }
  const endpoints = repos.flatMap((repo) => repo.endpoints);
  const contracts = buildContracts(endpoints);
  return {
    name,
    indexedAt: new Date().toISOString(),
    stats: {
      repos: repos.length,
      filesScanned: repos.reduce((sum, repo) => sum + repo.stats.filesScanned, 0),
      bytesScanned: repos.reduce((sum, repo) => sum + repo.stats.bytesScanned, 0),
      endpoints: endpoints.length,
      contracts: contracts.length,
      skills: repos.reduce((sum, repo) => sum + repo.skills.length, 0),
      durationMs: Date.now() - started,
    },
    repos,
    contracts,
  };
}

export function workspaceImpact(
  index: WorkspaceFastIndex,
  options?: { scope?: string; baseRef?: string },
): WorkspaceImpactResult {
  const scope = options?.scope ?? 'unstaged';
  const changedFiles = index.repos.flatMap((repo) =>
    changedFilesForRepo(repo.path, scope, options?.baseRef).map((change) => ({
      repo: repo.name,
      path: change.path,
      status: change.status,
    })),
  );
  const changedRepoNames = new Set(changedFiles.map((file) => file.repo));
  const changedFileKeys = new Set(
    changedFiles.map((file) => `${file.repo}\0${normalizePath(file.path)}`),
  );
  const changedEndpoints = index.repos.flatMap((repo) =>
    repo.endpoints.filter((endpoint) =>
      changedFileKeys.has(`${repo.name}\0${normalizePath(endpoint.filePath)}`),
    ),
  );
  const affectedContracts = index.contracts.filter(
    (contract) =>
      isUsefulContract(contract) &&
      changedEndpoints.some(
        (endpoint) => endpoint.type === contract.type && endpoint.key === contract.key,
      ),
  );
  const affectedRepos = new Set(changedRepoNames);
  for (const contract of affectedContracts) {
    for (const endpoint of [...contract.providers, ...contract.consumers, ...contract.references]) {
      affectedRepos.add(endpoint.repo);
    }
  }
  const skillsToLoad = routeSkills(index, affectedRepos, affectedContracts);
  return {
    summary: {
      scope,
      changedFiles: changedFiles.length,
      changedRepos: changedRepoNames.size,
      affectedRepos: affectedRepos.size,
      affectedContracts: affectedContracts.length,
      skills: skillsToLoad.length,
    },
    changedFiles,
    affectedRepos: Array.from(affectedRepos).sort(),
    affectedContracts,
    skillsToLoad,
  };
}

export function routeSkills(
  index: WorkspaceFastIndex,
  affectedRepos: Set<string>,
  contracts: WorkspaceContract[],
): WorkspaceSkill[] {
  const contractKeys = new Set(contracts.flatMap((contract) => [contract.key, contract.type]));
  const skills = index.repos
    .filter((repo) => affectedRepos.has(repo.name))
    .flatMap((repo) => repo.skills)
    .filter(
      (skill) =>
        skill.triggers.length === 0 ||
        skill.triggers.some((trigger) => contractKeys.has(trigger) || affectedRepos.has(trigger)),
    );
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.repo}\0${skill.name}\0${skill.path ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function indexWorkspaceRepo(
  repoPathInput: string,
  options?: { maxFileSize?: number },
): Promise<WorkspaceRepoIndex> {
  const started = Date.now();
  const repoPath = path.resolve(repoPathInput);
  const repoName = path.basename(repoPath);
  const maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const files = await listWorkspaceFiles(repoPath, maxFileSize);
  const endpoints: WorkspaceEndpoint[] = [];
  let bytesScanned = 0;
  for (const file of files) {
    bytesScanned += file.size;
    const text = await fs.readFile(path.join(repoPath, file.path), 'utf-8').catch(() => '');
    if (!text) continue;
    endpoints.push(...extractEndpoints(repoName, file.path, text));
  }
  const skills = await discoverSkills(repoName, repoPath, endpoints);
  return {
    name: repoName,
    path: repoPath,
    kind: inferRepoKind(files.map((file) => file.path)),
    branch: gitText(repoPath, ['branch', '--show-current']),
    commit: gitText(repoPath, ['rev-parse', '--short', 'HEAD']),
    stats: {
      filesScanned: files.length,
      bytesScanned,
      endpoints: endpoints.length,
      skills: skills.length,
      durationMs: Date.now() - started,
    },
    endpoints,
    skills,
  };
}

async function listWorkspaceFiles(
  repoPath: string,
  maxFileSize: number,
): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  const stack = [repoPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!TEXT_EXTS.has(ext)) continue;
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat || stat.size > maxFileSize) continue;
      out.push({ path: normalizePath(path.relative(repoPath, full)), size: stat.size });
    }
  }
  return out;
}

function extractEndpoints(repo: string, filePath: string, text: string): WorkspaceEndpoint[] {
  const endpoints: WorkspaceEndpoint[] = [];
  const lines = text.split(/\r?\n/);
  const add = (
    type: WorkspaceContractType,
    role: WorkspaceEndpointRole,
    key: string,
    line: number,
    confidence = 0.8,
    symbol?: string,
  ) => {
    const normalized = normalizeContractKey(type, key);
    if (!normalized) return;
    endpoints.push({ type, role, key: normalized, repo, filePath, line, confidence, symbol });
  };

  if (filePath.endsWith('.csproj')) {
    for (const m of text.matchAll(/<ProjectReference[^>]*Include="([^"]+)"/g)) {
      add('project-ref', 'reference', normalizePath(path.join(path.dirname(filePath), m[1])), 1, 1);
    }
    return endpoints;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(
      /RabbitMQFactory\.([A-Za-z0-9_]+)\s*\([^)]*\)\s*\.\s*(PublishMsg(?:ByConsistentHash)?)/g,
    )) {
      add('mq', 'provider', m[1], i + 1, 0.95, m[2]);
    }
    for (const m of line.matchAll(/Bus\.Publish\s*\(\s*EventType\.([A-Za-z0-9_]+)/g)) {
      add('mq', 'provider', m[1], i + 1, 0.9, 'Bus.Publish');
    }
    for (const m of line.matchAll(/EventBusPublishHelper\.([A-Za-z0-9_]+)\s*\(/g)) {
      add('mq', 'provider', m[1], i + 1, 0.85, 'EventBusPublishHelper');
    }
    for (const m of line.matchAll(
      /Add(?:Dynamic|HashActivator)?HostService\s*<\s*([A-Za-z0-9_]+)\s*>[^(]*\(([^)]*)/g,
    )) {
      add(
        'mq',
        'consumer',
        m[2].match(/config\?\.\s*([A-Za-z0-9_]+)/)?.[1] ?? m[1],
        i + 1,
        0.8,
        m[1],
      );
    }
    for (const m of line.matchAll(/AddHostedService\s*<\s*([A-Za-z0-9_]+)\s*>/g)) {
      add('mq', 'consumer', m[1], i + 1, 0.65, m[1]);
    }
    if (line.includes('BindChannel(')) {
      add(
        'mq',
        'consumer',
        path.basename(filePath, path.extname(filePath)),
        i + 1,
        0.6,
        'BindChannel',
      );
    }
    for (const m of line.matchAll(
      /(?:fetch|axios(?:\.[a-z]+)?|request)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    )) {
      add('http', 'consumer', m[1], i + 1, 0.75);
    }
    for (const m of line.matchAll(
      /\[(?:HttpGet|HttpPost|HttpPut|HttpDelete|Route)\s*\(\s*"([^"]+)"/g,
    )) {
      add('http', 'provider', m[1], i + 1, 0.75);
    }
    for (const m of line.matchAll(
      /(?:queue|routing_key|exchange|task|name)\s*=\s*['"]([A-Za-z0-9_.:-]+)['"]/g,
    )) {
      add(
        'mq',
        line.includes('publish') || line.includes('send_task') ? 'provider' : 'consumer',
        m[1],
        i + 1,
        0.55,
      );
    }
    for (const m of line.matchAll(/https?:\/\/[A-Za-z0-9./:_-]+/g)) {
      add('http', 'consumer', m[0], i + 1, 0.5);
    }
  }
  return endpoints;
}

async function discoverSkills(
  repo: string,
  repoPath: string,
  endpoints: WorkspaceEndpoint[],
): Promise<WorkspaceSkill[]> {
  const skills: WorkspaceSkill[] = [
    {
      name: `${repo}-workspace`,
      repo,
      triggers: [
        repo,
        ...Array.from(new Set(endpoints.slice(0, 30).map((endpoint) => endpoint.type))),
      ],
    },
  ];
  const roots = ['.codex/skills', '.agents/skills', '.claude/skills'];
  for (const root of roots) {
    const dir = path.join(repoPath, root);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      const text = await fs.readFile(skillPath, 'utf-8').catch(() => '');
      if (!text) continue;
      skills.push({
        name: entry.name,
        path: normalizePath(path.relative(repoPath, skillPath)),
        repo,
        triggers: skillTriggers(text),
      });
    }
  }
  return skills;
}

function skillTriggers(text: string): string[] {
  const triggers = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9_.:-]{3,}\b/g)) {
    if (triggers.size > 30) break;
    triggers.add(m[0]);
  }
  return Array.from(triggers);
}

function buildContracts(endpoints: WorkspaceEndpoint[]): WorkspaceContract[] {
  const byKey = new Map<string, WorkspaceContract>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.type}\0${endpoint.key}`;
    let item = byKey.get(key);
    if (!item) {
      item = {
        type: endpoint.type,
        key: endpoint.key,
        providers: [],
        consumers: [],
        references: [],
      };
      byKey.set(key, item);
    }
    if (endpoint.role === 'provider') item.providers.push(endpoint);
    else if (endpoint.role === 'consumer') item.consumers.push(endpoint);
    else item.references.push(endpoint);
  }
  return Array.from(byKey.values())
    .filter(isUsefulContract)
    .sort((a, b) => `${a.type}:${a.key}`.localeCompare(`${b.type}:${b.key}`));
}

function changedFilesForRepo(
  repoPath: string,
  scope: string,
  baseRef?: string,
): Array<{ status: string; path: string }> {
  const args =
    scope === 'staged'
      ? ['diff', '--cached', '--name-status']
      : scope === 'all'
        ? ['diff', 'HEAD', '--name-status']
        : scope === 'compare' && baseRef
          ? ['diff', baseRef, '--name-status']
          : ['diff', '--name-status'];
  const out = gitText(repoPath, args);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { status: parts[0] ?? 'M', path: normalizePath(parts.at(-1) ?? '') };
    })
    .filter((item) => item.path.length > 0);
}

function inferRepoKind(files: string[]): string {
  if (files.some((file) => file.endsWith('.csproj'))) return 'dotnet';
  if (
    files.some((file) => file.endsWith('.gradle') || file.endsWith('.kt') || file.endsWith('.java'))
  ) {
    return 'android';
  }
  if (
    files.some(
      (file) =>
        file.endsWith('.xcodeproj') ||
        file.endsWith('.swift') ||
        file.endsWith('.m') ||
        file.endsWith('.mm'),
    )
  ) {
    return 'ios';
  }
  if (files.some((file) => file.endsWith('.py'))) return 'python';
  if (files.some((file) => /(^|\/)package\.json$/.test(file))) return 'frontend';
  return 'generic';
}

function normalizeContractKey(type: WorkspaceContractType, key: string): string {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 200) return '';
  if (type === 'http') {
    const normalized =
      trimmed
        .replace(/^https?:\/\/[^/]+/i, '')
        .split('?')[0]
        .replace(/\/+$/, '') || '/';
    if (isNoisyHttpKey(normalized)) return '';
    return normalized;
  }
  const mq = trimmed
    .replace(/QueueConfig$/i, '')
    .replace(/HostedService$/i, '')
    .replace(/Consumer$/i, '')
    .replace(/Handler$/i, '');
  if (isNoisyMqKey(mq)) return '';
  return mq;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function gitText(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isUsefulContract(contract: WorkspaceContract): boolean {
  const repos = new Set([
    ...contract.providers.map((endpoint) => endpoint.repo),
    ...contract.consumers.map((endpoint) => endpoint.repo),
    ...contract.references.map((endpoint) => endpoint.repo),
  ]);
  if (contract.type === 'project-ref') return true;
  if (contract.providers.length > 0 && contract.consumers.length > 0) return true;
  return repos.size > 1;
}

function isNoisyHttpKey(value: string): boolean {
  const lower = value.toLowerCase();
  if (['/', '/path', '/page', '/xxx', '/somepage'].includes(lower)) return true;
  if (/\.(png|jpe?g|gif|webp|svg|mp4|avi|mov|docx?|xlsx?|pdf|zip)$/i.test(lower)) return true;
  if (/\/(?:image|img|photo|video|file|clip|emoji|articles?|games?)\b/i.test(lower)) return true;
  if (lower.includes('example.com') || lower.includes('y.com') || lower.includes('b.com'))
    return true;
  return false;
}

function isNoisyMqKey(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    [
      'content',
      'footer',
      'gameid',
      'model',
      'data',
      'body',
      'payload',
      'message',
      'name',
      'title',
      'type',
      'key',
      'value',
      'queue',
      'topic',
      'exchange',
      'routingkey',
    ].includes(lower)
  ) {
    return true;
  }
  return /^[a-z][A-Za-z0-9]*$/.test(value);
}
