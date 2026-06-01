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
    symbols: number;
    skills: number;
    durationMs: number;
  };
  endpoints: WorkspaceEndpoint[];
  symbols?: WorkspaceSymbol[];
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

export interface WorkspaceSymbol {
  repo: string;
  filePath: string;
  line: number;
  kind: string;
  name: string;
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

export interface WorkspaceFocusResult {
  summary: {
    query: string;
    matchedRepos: number;
    matchedContracts: number;
    candidateFiles: number;
    skills: number;
  };
  matchedRepos: Array<{ repo: string; score: number; reasons: string[] }>;
  matchedContracts: Array<WorkspaceContract & { score: number; reasons: string[] }>;
  candidateFiles: Array<{
    repo: string;
    filePath: string;
    score: number;
    reasons: string[];
    lines: number[];
  }>;
  skillsToLoad: WorkspaceSkill[];
  bootstrap: {
    message: string;
    suggestedNextCommands: string[];
  };
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
  '.venv',
  'venv',
  '__pycache__',
]);
const SKIP_PATH_PATTERNS = [
  /(^|\/)wwwroot\/lib\//i,
  /(^|\/)(vendor|vendors|third[_-]?party)\//i,
  /(^|\/)jquery[./-]/i,
  /\.min\.(js|css)$/i,
];
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

export function workspaceFocus(
  index: WorkspaceFastIndex,
  query: string,
  options?: { limit?: number },
): WorkspaceFocusResult {
  const limit = options?.limit ?? 20;
  const terms = tokenizeFocusQuery(query);
  const repoScores = new Map<string, { score: number; reasons: Set<string> }>();
  const fileScores = new Map<
    string,
    { repo: string; filePath: string; score: number; reasons: Set<string>; lines: Set<number> }
  >();

  const contractMatches = index.contracts
    .map((contract) => {
      const score = scoreText(`${contract.type} ${contract.key}`, terms);
      const endpointScore = Math.max(
        0,
        ...[...contract.providers, ...contract.consumers, ...contract.references].map((endpoint) =>
          scoreEndpoint(endpoint, terms),
        ),
      );
      const total = score + endpointScore;
      return {
        ...contract,
        score: total,
        reasons: focusReasons(`${contract.type}:${contract.key}`, terms),
      };
    })
    .filter((contract) => contract.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  for (const repo of index.repos) {
    const repoScore = scoreText(`${repo.name} ${repo.kind}`, terms);
    if (repoScore > 0) addRepoScore(repoScores, repo.name, repoScore, `repo:${repo.name}`);
    for (const symbol of repo.symbols ?? []) {
      const score = scoreText(
        `${symbol.name} ${symbol.kind} ${symbol.filePath} ${symbol.repo}`,
        terms,
      );
      if (score <= 0) continue;
      addRepoScore(repoScores, repo.name, score, `${symbol.kind}:${symbol.name}`);
      const key = `${repo.name}\0${symbol.filePath}`;
      let item = fileScores.get(key);
      if (!item) {
        item = {
          repo: repo.name,
          filePath: symbol.filePath,
          score: 0,
          reasons: new Set<string>(),
          lines: new Set<number>(),
        };
        fileScores.set(key, item);
      }
      item.score += score * focusPathWeight(symbol.filePath);
      item.reasons.add(`${symbol.kind}:${symbol.name}`);
      item.lines.add(symbol.line);
    }
    for (const endpoint of repo.endpoints) {
      const score = scoreEndpoint(endpoint, terms);
      if (score <= 0) continue;
      addRepoScore(repoScores, repo.name, score, `${endpoint.type}:${endpoint.key}`);
      const key = `${repo.name}\0${endpoint.filePath}`;
      let item = fileScores.get(key);
      if (!item) {
        item = {
          repo: repo.name,
          filePath: endpoint.filePath,
          score: 0,
          reasons: new Set<string>(),
          lines: new Set<number>(),
        };
        fileScores.set(key, item);
      }
      item.score += score * focusPathWeight(endpoint.filePath);
      item.reasons.add(`${endpoint.type}:${endpoint.key}`);
      item.lines.add(endpoint.line);
    }
  }

  for (const contract of contractMatches) {
    for (const endpoint of [...contract.providers, ...contract.consumers, ...contract.references]) {
      addRepoScore(repoScores, endpoint.repo, contract.score, `${contract.type}:${contract.key}`);
    }
  }

  const matchedRepos = Array.from(repoScores.entries())
    .map(([repo, value]) => ({
      repo,
      score: value.score,
      reasons: Array.from(value.reasons).slice(0, 8),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const affectedRepos = new Set(matchedRepos.map((repo) => repo.repo));
  const skillsToLoad = routeSkills(index, affectedRepos, contractMatches);
  const candidateFiles = Array.from(fileScores.values())
    .map((item) => ({
      repo: item.repo,
      filePath: item.filePath,
      score: item.score,
      reasons: Array.from(item.reasons).slice(0, 8),
      lines: Array.from(item.lines)
        .sort((a, b) => a - b)
        .slice(0, 8),
    }))
    .sort(
      (a, b) =>
        Number(hasExactLongTermReason(b, terms)) - Number(hasExactLongTermReason(a, terms)) ||
        b.score - a.score,
    )
    .slice(0, limit);

  return {
    summary: {
      query,
      matchedRepos: matchedRepos.length,
      matchedContracts: contractMatches.length,
      candidateFiles: candidateFiles.length,
      skills: skillsToLoad.length,
    },
    matchedRepos,
    matchedContracts: contractMatches,
    candidateFiles,
    skillsToLoad,
    bootstrap: {
      message:
        'Use this as a pre-development focus result: load only the listed repo skills, then ask the model to inspect candidate files/contracts before editing.',
      suggestedNextCommands: [
        'gitnexus workspace focus "<requirement>"',
        'gitnexus workspace impact -s compare -b <branch>',
      ],
    },
  };
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
  const symbols: WorkspaceSymbol[] = [];
  let bytesScanned = 0;
  for (const file of files) {
    bytesScanned += file.size;
    const text = await fs.readFile(path.join(repoPath, file.path), 'utf-8').catch(() => '');
    if (!text) continue;
    endpoints.push(...extractEndpoints(repoName, file.path, text));
    symbols.push(...extractSymbols(repoName, file.path, text));
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
      symbols: symbols.length,
      skills: skills.length,
      durationMs: Date.now() - started,
    },
    endpoints,
    symbols,
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
      if (entry.name.startsWith('.venv') || entry.name.startsWith('__pycache__')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = normalizePath(path.relative(repoPath, full));
      if (isSkippedWorkspacePath(relativePath)) continue;
      const ext = path.extname(entry.name);
      if (!TEXT_EXTS.has(ext)) continue;
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat || stat.size > maxFileSize) continue;
      out.push({ path: relativePath, size: stat.size });
    }
  }
  return out;
}

function isSkippedWorkspacePath(filePath: string): boolean {
  return SKIP_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function extractSymbols(repo: string, filePath: string, text: string): WorkspaceSymbol[] {
  const symbols: WorkspaceSymbol[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  const patterns: Array<{ kind: string; regex: RegExp }> = filePath.endsWith('.py')
    ? [
        { kind: 'class', regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
        { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
      ]
    : filePath.endsWith('.ts') ||
        filePath.endsWith('.tsx') ||
        filePath.endsWith('.js') ||
        filePath.endsWith('.jsx')
      ? [
          { kind: 'class', regex: /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/ },
          { kind: 'function', regex: /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/ },
          {
            kind: 'function',
            regex: /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/,
          },
        ]
      : [
          { kind: 'class', regex: /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/ },
          { kind: 'interface', regex: /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/ },
          {
            kind: 'method',
            regex: /^\s*[A-Za-z0-9_<>,\[\]?.]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
          },
          {
            kind: 'method',
            regex:
              /\b(?:public|private|protected|internal|static|async|virtual|override|sealed|\s)+[A-Za-z0-9_<>,\[\]?.]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
          },
        ];
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern.regex);
      if (match?.[1]) addSymbol(symbols, seen, repo, filePath, i + 1, pattern.kind, match[1]);
    }
    for (const match of lines[i].matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/g)) {
      const name = match[1];
      if (isNoisySymbolName(name)) continue;
      addSymbol(symbols, seen, repo, filePath, i + 1, 'call', name);
    }
  }
  return symbols;
}

function addSymbol(
  symbols: WorkspaceSymbol[],
  seen: Set<string>,
  repo: string,
  filePath: string,
  line: number,
  kind: string,
  name: string,
): void {
  const key = `${filePath}\0${line}\0${kind}\0${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  symbols.push({ repo, filePath, line, kind, name });
}

function isNoisySymbolName(name: string): boolean {
  return [
    'if',
    'for',
    'foreach',
    'while',
    'switch',
    'catch',
    'using',
    'return',
    'typeof',
    'nameof',
    'console',
    'require',
  ].includes(name.toLowerCase());
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

function tokenizeFocusQuery(query: string): string[] {
  const rawTerms: string[] = [];
  const camelTerms: string[] = [];
  for (const chunk of query.split(/[^A-Za-z0-9_\-./:\u4e00-\u9fff]+/)) {
    const raw = chunk.trim();
    if (raw.length < 2) continue;
    rawTerms.push(raw.toLowerCase());
    const hasIdentifierShape = /[a-z][A-Z]|[A-Za-z][0-9]|[0-9][A-Za-z]/.test(raw);
    if (hasIdentifierShape && raw.length >= 6) continue;
    camelTerms.push(
      ...raw
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9_\-./:\u4e00-\u9fff]+/)
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2),
    );
  }
  return Array.from(
    new Set(
      [...rawTerms, ...camelTerms].filter(
        (term) =>
          !['the', 'and', 'for', 'with', 'config', 'game', 'push', 'validate'].includes(term),
      ),
    ),
  );
}

function scoreEndpoint(endpoint: WorkspaceEndpoint, terms: string[]): number {
  return scoreText(
    `${endpoint.type} ${endpoint.role} ${endpoint.key} ${endpoint.repo} ${endpoint.filePath} ${endpoint.symbol ?? ''}`,
    terms,
  );
}

function scoreText(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const exactWord = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(term)}([^a-z0-9_]|$)`, 'i').test(
      haystack,
    );
    if (haystack === term) score += 600;
    else if (exactWord)
      score +=
        term.length >= 12
          ? Math.max(900, term.length * 60)
          : term.length >= 8
            ? Math.max(160, term.length * 12)
            : Math.max(20, term.length * 2);
    else if (term.length >= 12 && haystack.includes(term)) score += Math.max(600, term.length * 40);
    else if (term.length >= 8 && haystack.includes(term)) score += Math.max(100, term.length * 8);
    else if (term.length >= 4 && haystack.includes(term))
      score += Math.max(2, Math.min(12, term.length));
  }
  return score;
}

function focusPathWeight(filePath: string): number {
  const lower = filePath.toLowerCase();
  if (/\/(test|tests|unittest|unittests)\//i.test(lower)) return 0.45;
  if (lower.includes('/wwwroot/') || lower.includes('/dist/') || lower.includes('/build/'))
    return 0.2;
  return 1;
}

function hasExactLongTermReason(
  item: { filePath: string; reasons: string[] },
  terms: string[],
): boolean {
  const haystack = `${item.filePath} ${item.reasons.join(' ')}`.toLowerCase();
  return terms.some((term) => term.length >= 12 && haystack.includes(term));
}

function focusReasons(text: string, terms: string[]): string[] {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).slice(0, 8);
}

function addRepoScore(
  scores: Map<string, { score: number; reasons: Set<string> }>,
  repo: string,
  score: number,
  reason: string,
): void {
  let item = scores.get(repo);
  if (!item) {
    item = { score: 0, reasons: new Set<string>() };
    scores.set(repo, item);
  }
  item.score += score;
  item.reasons.add(reason);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
