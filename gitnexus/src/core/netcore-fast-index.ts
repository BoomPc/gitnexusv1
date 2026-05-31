import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { getStoragePath } from '../storage/repo-manager.js';

export interface FastProject {
  name: string;
  path: string;
  dir: string;
  sdk?: string;
  targetFramework?: string;
  outputType?: string;
  assemblyName?: string;
  rootNamespace?: string;
  isHost: boolean;
  serviceName?: string;
  references: string[];
  referencedBy: string[];
}

export interface FastNode {
  label: string;
  name?: string;
  filePath?: string;
}

export interface FastMqEndpoint {
  kind: string;
  role: 'provider' | 'consumer';
  topic: string;
  filePath: string;
  line: number;
  project?: string;
  service?: string;
  symbol?: string;
}

export interface FastMqLink {
  topic: string;
  providers: FastMqEndpoint[];
  consumers: FastMqEndpoint[];
}

export interface FastIndex {
  stats?: { files?: number; nodes?: number; edges?: number };
  projects?: FastProject[];
  nodes?: FastNode[];
  mq?: { endpoints?: FastMqEndpoint[]; links?: FastMqLink[] };
}

export async function loadNetcoreFastIndex(repoPath: string): Promise<FastIndex> {
  const file = path.join(getStoragePath(path.resolve(repoPath)), 'netcore-fast-index.json');
  return JSON.parse(await fs.readFile(file, 'utf-8')) as FastIndex;
}

export function normalizeNetcoreTopic(value: string): string {
  return value
    .replace(/QueueConfig$/i, '')
    .replace(/HostedService$/i, '')
    .replace(/Consumer$/i, '')
    .replace(/Handler$/i, '')
    .replace(/MQ$/i, '')
    .toLowerCase();
}

export function ownerProject(projects: FastProject[], filePath: string): FastProject | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  return projects
    .filter((p) => normalized === p.path || normalized.startsWith(p.dir ? `${p.dir}/` : ''))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

function isTestProject(project: FastProject): boolean {
  return /(^|[./\\-])(test|tests|unit[-_]?tests?|unittests)([./\\-]|$)/i.test(
    `${project.name}/${project.path}`,
  );
}

export function isReleaseProject(project: FastProject): boolean {
  if (project.isHost) return true;
  if (isTestProject(project)) return false;
  return project.outputType === 'Exe' || /Microsoft\.NET\.Sdk\.Worker/i.test(project.sdk ?? '');
}

function releaseServiceName(project: FastProject): string {
  return project.serviceName ?? project.dir ?? project.name;
}

export function upstreamReleaseProjects(
  projects: FastProject[],
  start: FastProject,
): FastProject[] {
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const out = new Map<string, FastProject>();
  const seen = new Set<string>();
  const queue = [...start.referencedBy];
  while (queue.length > 0) {
    const nextPath = queue.shift()!;
    if (seen.has(nextPath)) continue;
    seen.add(nextPath);
    const p = byPath.get(nextPath);
    if (!p) continue;
    if (isReleaseProject(p)) out.set(p.path, p);
    queue.push(...p.referencedBy);
  }
  return Array.from(out.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export function netcoreSummary(index: FastIndex) {
  const projects = index.projects ?? [];
  const hosts = projects.filter((p) => p.isHost);
  const releaseProjects = projects.filter((p) => isReleaseProject(p));
  return {
    stats: index.stats,
    projects: projects.length,
    releaseProjects: releaseProjects.length,
    mq: {
      endpoints: index.mq?.endpoints?.length ?? 0,
      topics: index.mq?.links?.length ?? 0,
      linkedTopics: (index.mq?.links ?? []).filter(
        (l) => l.providers.length > 0 && l.consumers.length > 0,
      ).length,
    },
    hosts: hosts.map((h) => ({ name: h.name, path: h.path, service: releaseServiceName(h) })),
    executables: releaseProjects
      .filter((p) => !p.isHost)
      .map((p) => ({ name: p.name, path: p.path, service: releaseServiceName(p) })),
  };
}

export function netcoreImpact(index: FastIndex, target: string) {
  const projects = index.projects ?? [];
  const nodes = index.nodes ?? [];
  const projectByName = projects.find((p) => p.name === target || p.path === target);
  const project =
    projectByName ??
    ownerProject(
      projects,
      nodes.find(
        (n) =>
          n.filePath === target ||
          n.filePath?.replace(/\\/g, '/') === target.replace(/\\/g, '/') ||
          n.name === target,
      )?.filePath ?? target.replace(/\\/g, '/'),
    );
  if (!project) return { target, found: false, message: 'No owning .csproj found in fast index.' };
  const filePath = projectByName ? undefined : target.replace(/\\/g, '/');
  const releaseProjects = isReleaseProject(project)
    ? [project]
    : upstreamReleaseProjects(projects, project);
  const mqEndpoints = (index.mq?.endpoints ?? []).filter(
    (ep) => ep.project === project.path || (filePath !== undefined && ep.filePath === filePath),
  );
  return {
    target,
    ...(filePath !== undefined ? { filePath } : {}),
    project: { name: project.name, path: project.path },
    mq: mqEndpoints.map((ep) => ({
      role: ep.role,
      kind: ep.kind,
      topic: ep.topic,
      filePath: ep.filePath,
      line: ep.line,
      service: ep.service,
    })),
    releaseCandidates: releaseProjects.map((h) => ({
      name: h.name,
      path: h.path,
      service: releaseServiceName(h),
    })),
  };
}

export function netcoreMq(index: FastIndex, topic: string) {
  const key = normalizeNetcoreTopic(topic);
  const links = index.mq?.links ?? [];
  const hit = links.find((l) => normalizeNetcoreTopic(l.topic) === key);
  if (!hit) {
    return {
      topic,
      found: false,
      related: links
        .filter(
          (l) =>
            normalizeNetcoreTopic(l.topic).includes(key) ||
            key.includes(normalizeNetcoreTopic(l.topic)),
        )
        .slice(0, 20)
        .map((l) => l.topic),
    };
  }
  return {
    topic: hit.topic,
    providers: hit.providers.map(formatMqEndpoint),
    consumers: hit.consumers.map(formatMqEndpoint),
  };
}

function formatMqEndpoint(ep: FastMqEndpoint) {
  return {
    filePath: ep.filePath,
    line: ep.line,
    project: ep.project,
    service: ep.service,
    kind: ep.kind,
  };
}

export function netcoreReleaseCandidates(
  index: FastIndex,
  repoPath: string,
  scope = 'unstaged',
  baseRef?: string,
) {
  const args =
    scope === 'staged'
      ? ['diff', '--cached', '--name-status']
      : scope === 'all'
        ? ['diff', 'HEAD', '--name-status']
        : scope === 'compare' && baseRef
          ? ['diff', baseRef, '--name-status']
          : ['diff', '--name-status'];
  const out = execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/).at(-1)!.replace(/\\/g, '/'));
  const projects = index.projects ?? [];
  const byProject = new Map<
    string,
    { project: FastProject; files: string[]; releaseProjects: FastProject[] }
  >();
  for (const file of files) {
    const project = ownerProject(projects, file);
    if (!project) continue;
    let item = byProject.get(project.path);
    if (!item) {
      item = {
        project,
        files: [],
        releaseProjects: isReleaseProject(project)
          ? [project]
          : upstreamReleaseProjects(projects, project),
      };
      byProject.set(project.path, item);
    }
    item.files.push(file);
  }
  const serviceMap = new Map<
    string,
    {
      name: string;
      path: string;
      service: string;
      changedFiles: string[];
      reasonProjects: string[];
    }
  >();
  for (const item of byProject.values()) {
    for (const host of item.releaseProjects) {
      const key = host.path;
      let svc = serviceMap.get(key);
      if (!svc) {
        svc = {
          name: host.name,
          path: host.path,
          service: releaseServiceName(host),
          changedFiles: [],
          reasonProjects: [],
        };
        serviceMap.set(key, svc);
      }
      svc.changedFiles.push(...item.files);
      svc.reasonProjects.push(item.project.path);
    }
  }
  return {
    summary: {
      scope,
      changedFiles: files.length,
      changedProjects: byProject.size,
      candidateServices: serviceMap.size,
    },
    releaseCandidates: Array.from(serviceMap.values()),
    projects: Array.from(byProject.values()).map((p) => ({
      name: p.project.name,
      path: p.project.path,
      isHost: p.project.isHost,
      changedFiles: p.files,
      releaseCandidates: p.releaseProjects.map((h) => h.path),
    })),
  };
}
