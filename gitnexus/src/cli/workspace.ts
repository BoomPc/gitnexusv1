import {
  buildWorkspaceFastIndex,
  defaultWorkspaceIndexPath,
  loadWorkspaceFastIndex,
  saveWorkspaceFastIndex,
  workspaceFocus,
  workspaceImpact,
} from '../core/workspace-fast-index.js';

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

export async function workspaceIndexCommand(
  paths: string[],
  options?: {
    name?: string;
    out?: string;
    maxFileSizeKb?: string;
    json?: boolean;
  },
): Promise<void> {
  const name = options?.name ?? 'default';
  const started = Date.now();
  const index = await buildWorkspaceFastIndex(name, paths, {
    maxFileSize: Number(options?.maxFileSizeKb ?? 256) * 1024,
  });
  const out = await saveWorkspaceFastIndex(index, options?.out ?? defaultWorkspaceIndexPath(name));
  if (options?.json) {
    print({ path: out, ...index.stats });
    return;
  }
  print(
    [
      `Workspace index: ${out}`,
      `Repos: ${index.stats.repos}`,
      `Files scanned: ${index.stats.filesScanned}`,
      `Endpoints: ${index.stats.endpoints}`,
      `Contracts: ${index.stats.contracts}`,
      `Skills: ${index.stats.skills}`,
      `Symbols: ${index.repos.reduce((sum, repo) => sum + (repo.stats.symbols ?? 0), 0)}`,
      `Index size: ${formatBytes(await fileSize(out))}`,
      `Duration: ${formatMs(Date.now() - started)}`,
    ].join('\n'),
  );
}

export async function workspaceImpactCommand(options?: {
  index?: string;
  name?: string;
  scope?: string;
  baseRef?: string;
  json?: boolean;
}): Promise<void> {
  const name = options?.name ?? 'default';
  const indexPath = options?.index ?? defaultWorkspaceIndexPath(name);
  const index = await loadWorkspaceFastIndex(indexPath);
  const result = workspaceImpact(index, {
    scope: options?.scope ?? 'unstaged',
    baseRef: options?.baseRef,
  });
  if (options?.json) {
    print(result);
    return;
  }
  print(formatImpact(result));
}

export async function workspaceSkillsCommand(options?: {
  index?: string;
  name?: string;
  scope?: string;
  baseRef?: string;
  json?: boolean;
}): Promise<void> {
  const name = options?.name ?? 'default';
  const indexPath = options?.index ?? defaultWorkspaceIndexPath(name);
  const index = await loadWorkspaceFastIndex(indexPath);
  const result = workspaceImpact(index, {
    scope: options?.scope ?? 'unstaged',
    baseRef: options?.baseRef,
  });
  if (options?.json) {
    print(result.skillsToLoad);
    return;
  }
  print(
    [
      'Skills to load:',
      ...(result.skillsToLoad.length === 0
        ? ['- (none)']
        : result.skillsToLoad.map(
            (skill) => `- ${skill.repo}: ${skill.name}${skill.path ? ` (${skill.path})` : ''}`,
          )),
    ].join('\n'),
  );
}

export async function workspaceFocusCommand(
  query: string,
  options?: {
    index?: string;
    name?: string;
    limit?: string;
    json?: boolean;
  },
): Promise<void> {
  const name = options?.name ?? 'default';
  const indexPath = options?.index ?? defaultWorkspaceIndexPath(name);
  const index = await loadWorkspaceFastIndex(indexPath);
  const result = workspaceFocus(index, query, { limit: Number(options?.limit ?? 20) });
  if (options?.json) {
    print(result);
    return;
  }
  print(formatFocus(result));
}

function formatImpact(result: ReturnType<typeof workspaceImpact>): string {
  const lines = [
    `Changed files: ${result.summary.changedFiles}`,
    `Changed repos: ${result.summary.changedRepos}`,
    `Affected repos: ${result.summary.affectedRepos}`,
    `Affected contracts: ${result.summary.affectedContracts}`,
    `Skills: ${result.summary.skills}`,
    '',
    'Affected repos:',
    ...(result.affectedRepos.length === 0
      ? ['- (none)']
      : result.affectedRepos.map((repo) => `- ${repo}`)),
    '',
    'Affected contracts:',
  ];
  if (result.affectedContracts.length === 0) {
    lines.push('- (none)');
  } else {
    lines.push(
      ...result.affectedContracts.slice(0, 100).map((contract) => {
        const repos = new Set([
          ...contract.providers.map((endpoint) => endpoint.repo),
          ...contract.consumers.map((endpoint) => endpoint.repo),
          ...contract.references.map((endpoint) => endpoint.repo),
        ]);
        return `- ${contract.type}:${contract.key} -> ${Array.from(repos).sort().join(', ')}`;
      }),
    );
  }
  lines.push('', 'Skills to load:');
  lines.push(
    ...(result.skillsToLoad.length === 0
      ? ['- (none)']
      : result.skillsToLoad.map(
          (skill) => `- ${skill.repo}: ${skill.name}${skill.path ? ` (${skill.path})` : ''}`,
        )),
  );
  return lines.join('\n');
}

function formatFocus(result: ReturnType<typeof workspaceFocus>): string {
  const lines = [
    `Query: ${result.summary.query}`,
    `Matched repos: ${result.summary.matchedRepos}`,
    `Matched contracts: ${result.summary.matchedContracts}`,
    `Candidate files: ${result.summary.candidateFiles}`,
    `Skills: ${result.summary.skills}`,
    '',
    'Repos to focus:',
    ...(result.matchedRepos.length === 0
      ? ['- (none)']
      : result.matchedRepos.map(
          (repo) => `- ${repo.repo} (${repo.reasons.slice(0, 3).join(', ')})`,
        )),
    '',
    'Contracts to inspect:',
  ];
  if (result.matchedContracts.length === 0) {
    lines.push('- (none)');
  } else {
    lines.push(
      ...result.matchedContracts.slice(0, 20).map((contract) => {
        const repos = new Set([
          ...contract.providers.map((endpoint) => endpoint.repo),
          ...contract.consumers.map((endpoint) => endpoint.repo),
          ...contract.references.map((endpoint) => endpoint.repo),
        ]);
        return `- ${contract.type}:${contract.key} -> ${Array.from(repos).sort().join(', ')}`;
      }),
    );
  }
  lines.push('', 'Candidate files:');
  lines.push(
    ...(result.candidateFiles.length === 0
      ? ['- (none)']
      : result.candidateFiles
          .slice(0, 20)
          .map(
            (file) =>
              `- ${file.repo}: ${file.filePath}${file.lines.length ? `:${file.lines[0]}` : ''}`,
          )),
  );
  lines.push('', 'Skills to load after focus:');
  lines.push(
    ...(result.skillsToLoad.length === 0
      ? ['- (none)']
      : result.skillsToLoad.map(
          (skill) => `- ${skill.repo}: ${skill.name}${skill.path ? ` (${skill.path})` : ''}`,
        )),
  );
  lines.push('', `Bootstrap: ${result.bootstrap.message}`);
  return lines.join('\n');
}

async function fileSize(filePath: string): Promise<number> {
  return (await import('fs/promises')).stat(filePath).then((stat) => stat.size);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
