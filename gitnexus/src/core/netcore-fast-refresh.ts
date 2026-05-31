import fs from 'fs/promises';
import path from 'path';
import {
  type FastIndex,
  type FastMqEndpoint,
  type FastMqLink,
  type FastNode,
  type FastProject,
  netcoreChangedFiles,
  ownerProject,
  saveNetcoreFastIndex,
} from './netcore-fast-index.js';

export interface NetcoreFastRefreshResult {
  mode: 'incremental';
  scope: string;
  changedFiles: number;
  refreshedFiles: number;
  projectGraphRefreshed: boolean;
}

export async function refreshNetcoreFastIndexForDiff(
  index: FastIndex,
  repoPath: string,
  options?: { scope?: string; baseRef?: string },
): Promise<{ index: FastIndex; result: NetcoreFastRefreshResult }> {
  const scope = options?.scope ?? 'unstaged';
  const changes = netcoreChangedFiles(repoPath, scope, options?.baseRef);
  const changedPaths = changes.map((change) => change.path);
  const removed = new Set(
    changes
      .filter((change) => change.status.startsWith('D'))
      .map((change) => normalizePath(change.path)),
  );
  const projectGraphRefreshed = changedPaths.some((file) => file.endsWith('.csproj'));
  const projects = projectGraphRefreshed
    ? await discoverProjects(repoPath)
    : (index.projects ?? []);
  const changedCsFiles = changedPaths.filter((file) => file.endsWith('.cs')).map(normalizePath);
  const refreshedNodes: FastNode[] = [];
  const refreshedEndpoints: FastMqEndpoint[] = [];

  for (const rel of changedCsFiles) {
    if (removed.has(rel)) continue;
    const full = path.join(repoPath, rel);
    const text = await fs.readFile(full, 'utf-8').catch(() => '');
    if (!text) continue;
    refreshedNodes.push(...extractNodes(rel, text));
    refreshedEndpoints.push(...extractMqEndpoints(rel, text, projects));
  }

  const changedSet = new Set([...changedCsFiles, ...removed]);
  const nodes = [
    ...(index.nodes ?? []).filter(
      (node) => !node.filePath || !changedSet.has(normalizePath(node.filePath)),
    ),
    ...refreshedNodes,
  ];
  const endpoints = [
    ...(index.mq?.endpoints ?? []).filter((ep) => !changedSet.has(normalizePath(ep.filePath))),
    ...refreshedEndpoints,
  ];
  const refreshedIndex: FastIndex = {
    ...index,
    stats: {
      files: index.stats?.files,
      nodes: nodes.length,
      edges: index.stats?.edges,
    },
    projects,
    nodes,
    mq: { endpoints, links: buildMqLinks(endpoints) },
  };

  await saveNetcoreFastIndex(repoPath, refreshedIndex);
  return {
    index: refreshedIndex,
    result: {
      mode: 'incremental',
      scope,
      changedFiles: changes.length,
      refreshedFiles:
        changedCsFiles.length +
        (projectGraphRefreshed ? changedPaths.filter((f) => f.endsWith('.csproj')).length : 0),
      projectGraphRefreshed,
    },
  };
}

async function discoverProjects(repoPath: string): Promise<FastProject[]> {
  const projects = new Map<string, FastProject>();

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (['.git', '.gitnexus', 'bin', 'obj'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.csproj')) continue;
      const relativePath = normalizePath(path.relative(repoPath, full));
      const xml = await fs.readFile(full, 'utf-8').catch(() => '');
      const dirRel = normalizePath(path.dirname(relativePath));
      const name = path.basename(entry.name, '.csproj');
      const sdk = xml.match(/<Project[^>]*Sdk="([^"]+)"/)?.[1];
      projects.set(relativePath, {
        name,
        path: relativePath,
        dir: dirRel === '.' ? '' : dirRel,
        sdk,
        targetFramework: xml
          .match(/<TargetFramework>\s*([^<]+)\s*<\/TargetFramework>/)?.[1]
          ?.trim(),
        outputType: xml.match(/<OutputType>\s*([^<]+)\s*<\/OutputType>/)?.[1]?.trim(),
        assemblyName: xml.match(/<AssemblyName>\s*([^<]+)\s*<\/AssemblyName>/)?.[1]?.trim(),
        rootNamespace: xml.match(/<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/)?.[1]?.trim(),
        isHost: dirRel.startsWith('Hosts/') || /Microsoft\.NET\.Sdk\.Web/.test(sdk ?? ''),
        serviceName: dirRel.startsWith('Hosts/')
          ? dirRel.split('/').slice(0, 2).join('/')
          : undefined,
        references: Array.from(xml.matchAll(/<ProjectReference[^>]*Include="([^"]+)"/g)).map((m) =>
          normalizePath(path.join(path.dirname(relativePath), m[1])),
        ),
        referencedBy: [],
      });
    }
  };

  await walk(repoPath);
  for (const project of projects.values()) {
    for (const ref of project.references) {
      const target = projects.get(ref);
      if (target) target.referencedBy.push(project.path);
    }
  }
  return Array.from(projects.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function extractNodes(filePath: string, text: string): FastNode[] {
  const nodes: FastNode[] = [];
  const patterns: Array<{ label: string; regex: RegExp }> = [
    {
      label: 'Class',
      regex:
        /\b(?:public|internal|private|protected|sealed|abstract|static|partial|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    },
    {
      label: 'Interface',
      regex:
        /\b(?:public|internal|private|protected|partial|\s)*interface\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    },
    {
      label: 'Enum',
      regex: /\b(?:public|internal|private|protected|\s)*enum\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    },
    {
      label: 'Method',
      regex:
        /\b(?:public|internal|private|protected|static|async|virtual|override|sealed|\s)+[A-Za-z0-9_<>,\[\]?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    },
  ];
  for (const { label, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      nodes.push({ label, name: match[1], filePath });
    }
  }
  return nodes;
}

function extractMqEndpoints(
  filePath: string,
  text: string,
  projects: FastProject[],
): FastMqEndpoint[] {
  const endpoints: FastMqEndpoint[] = [];
  const lines = text.split(/\r?\n/);
  const add = (
    line: number,
    role: 'provider' | 'consumer',
    kind: FastMqEndpoint['kind'],
    topic: string,
    symbol?: string,
  ) => {
    const project = ownerProject(projects, filePath);
    endpoints.push({
      kind,
      role,
      topic,
      filePath,
      line,
      project: project?.path,
      service: project?.isHost ? (project.serviceName ?? project.dir) : undefined,
      symbol,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(
      /RabbitMQFactory\.([A-Za-z0-9_]+)\s*\([^)]*\)\s*\.\s*(PublishMsg(?:ByConsistentHash)?)/g,
    )) {
      add(i + 1, 'provider', 'rabbitmq-factory', m[1], m[2]);
    }
    for (const m of line.matchAll(/Bus\.Publish\s*\(\s*EventType\.([A-Za-z0-9_]+)/g)) {
      add(i + 1, 'provider', 'eventbus', m[1], 'Bus.Publish');
    }
    for (const m of line.matchAll(/EventBusPublishHelper\.([A-Za-z0-9_]+)\s*\(/g)) {
      add(i + 1, 'provider', 'eventbus-helper', m[1], 'EventBusPublishHelper');
    }
    for (const m of line.matchAll(
      /Add(?:Dynamic|HashActivator)?HostService\s*<\s*([A-Za-z0-9_]+)\s*>[^(]*\(([^)]*)/g,
    )) {
      add(
        i + 1,
        'consumer',
        'rabbitmq-bind-channel',
        m[2].match(/config\?\.\s*([A-Za-z0-9_]+)/)?.[1] ?? m[1],
        m[1],
      );
    }
    for (const m of line.matchAll(/AddHostedService\s*<\s*([A-Za-z0-9_]+)\s*>/g)) {
      add(i + 1, 'consumer', 'rabbitmq-bind-channel', m[1], m[1]);
    }
    if (line.includes('BindChannel(')) {
      const windowText = lines.slice(Math.max(0, i - 10), i + 2).join('\n');
      const cfg =
        windowText.match(
          /_([A-Za-z0-9]+QueueConfig)\s*=\s*rabbitQueueConfig\.Value\.([A-Za-z0-9_]+)/,
        )?.[2] ??
        windowText.match(/_([A-Za-z0-9]+QueueConfig)\.Exchange/)?.[1] ??
        path.basename(filePath, '.cs');
      add(i + 1, 'consumer', 'rabbitmq-bind-channel', cfg, 'BindChannel');
    }
  }
  return endpoints;
}

function buildMqLinks(endpoints: FastMqEndpoint[]): FastMqLink[] {
  const byTopic = new Map<string, FastMqLink>();
  for (const ep of endpoints) {
    const key = normalizeTopic(ep.topic);
    let link = byTopic.get(key);
    if (!link) {
      link = { topic: ep.topic, providers: [], consumers: [] };
      byTopic.set(key, link);
    }
    if (ep.role === 'provider') link.providers.push(ep);
    else link.consumers.push(ep);
  }
  return Array.from(byTopic.values()).filter(
    (link) => link.providers.length || link.consumers.length,
  );
}

function normalizeTopic(value: string): string {
  return value
    .replace(/QueueConfig$/i, '')
    .replace(/HostedService$/i, '')
    .replace(/Consumer$/i, '')
    .replace(/Handler$/i, '')
    .replace(/MQ$/i, '')
    .toLowerCase();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}
