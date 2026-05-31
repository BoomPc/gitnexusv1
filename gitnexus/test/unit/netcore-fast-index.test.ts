import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  isReleaseProject,
  netcoreImpact,
  upstreamReleaseProjects,
  type FastIndex,
  type FastProject,
} from '../../src/core/netcore-fast-index.js';
import { refreshNetcoreFastIndexForDiff } from '../../src/core/netcore-fast-refresh.js';
import {
  mapProjectsToReleaseSites,
  parseReleaseSiteMapping,
} from '../../src/core/netcore-release-sites.js';

function project(
  overrides: Partial<FastProject> & Pick<FastProject, 'name' | 'path'>,
): FastProject {
  return {
    dir: overrides.path.split('/').slice(0, -1).join('/'),
    isHost: false,
    references: [],
    referencedBy: [],
    ...overrides,
  };
}

describe('netcore fast index release projects', () => {
  it('treats non-test exe consumers as release candidates', () => {
    const app = project({
      name: 'AIHelp.PushApplication',
      path: 'Application/AIHelp.PushApplication/AIHelp.PushApplication.csproj',
      referencedBy: [
        'AIHelp.Logstash.Consumer/AIHelp.Logstash.Consumer.csproj',
        'AIHelp.UnitTests/AIHelp.UnitTests.csproj',
        'Hosts/ElvaHost/AIHelp.WebElva.WebApi/AIHelp.WebElva.WebApi.csproj',
      ],
    });
    const consumer = project({
      name: 'AIHelp.Logstash.Consumer',
      path: 'AIHelp.Logstash.Consumer/AIHelp.Logstash.Consumer.csproj',
      outputType: 'Exe',
      references: [app.path],
    });
    const unitTests = project({
      name: 'AIHelp.UnitTests',
      path: 'AIHelp.UnitTests/AIHelp.UnitTests.csproj',
      outputType: 'Exe',
      references: [app.path],
    });
    const webHost = project({
      name: 'AIHelp.WebElva.WebApi',
      path: 'Hosts/ElvaHost/AIHelp.WebElva.WebApi/AIHelp.WebElva.WebApi.csproj',
      sdk: 'Microsoft.NET.Sdk.Web',
      isHost: true,
      serviceName: 'Hosts/ElvaHost',
      references: [app.path],
    });
    const projects = [app, consumer, unitTests, webHost];

    expect(isReleaseProject(consumer)).toBe(true);
    expect(isReleaseProject(unitTests)).toBe(false);
    expect(upstreamReleaseProjects(projects, app).map((p) => p.path)).toEqual([
      'AIHelp.Logstash.Consumer/AIHelp.Logstash.Consumer.csproj',
      'Hosts/ElvaHost/AIHelp.WebElva.WebApi/AIHelp.WebElva.WebApi.csproj',
    ]);

    const result = netcoreImpact({ projects } satisfies FastIndex, app.path);
    expect(result.releaseCandidates).toEqual([
      {
        name: 'AIHelp.Logstash.Consumer',
        path: 'AIHelp.Logstash.Consumer/AIHelp.Logstash.Consumer.csproj',
        service: 'AIHelp.Logstash.Consumer',
      },
      {
        name: 'AIHelp.WebElva.WebApi',
        path: 'Hosts/ElvaHost/AIHelp.WebElva.WebApi/AIHelp.WebElva.WebApi.csproj',
        service: 'Hosts/ElvaHost',
      },
    ]);
  });
});

describe('netcore release site mapping', () => {
  const mapping = `
| 序号 | Rider 解决方案目录口径 | 仓库实际项目路径 | 发布站点 | 确认来源 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2 | Host/External Service/OpenAipHost | Hosts/OpenApiHost/AIHelp.Open.WebApi/AIHelp.Open.WebApi.csproj | openapi | 用户确认 | - |
| 19 | Hosts/OpenApiHost/AIHelp.Open.WebApi/AIHelp.Open.WebApi.csproj | Hosts/OpenApiHost/AIHelp.Open.WebApi/AIHelp.Open.WebApi.csproj | app_api | 用户确认 | - |
| 25 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer | 代码确认 | servers empty |
| 26 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer_hash | 代码确认 | servers=hash |
| 27 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer_wxwork | 代码确认 | servers=wxworker |
| 28 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer_ai | 代码确认 | servers=ai |
| 29 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer_thirdparty | 代码确认 | servers=thirdparty |
| 30 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer_wecom | 代码确认 | servers=wecom |
| 31 | AIHelp.Consumer/AIHelp.Consumer.csproj | AIHelp.Consumer/AIHelp.Consumer.csproj | consumer_chatedit | 代码确认 | servers=chatedit |

| 序号 | 项目工程 | 发布站点 | 备注 | 站点角色 | 站点目录状态 |
| --- | --- | --- | --- | --- | --- |
| 4 | Server_DotNetCore | openapi | Hosts/OpenApiHost | WebApi 站点 | 已确认 |
| 8 | Server_DotNetCore | app_api | Hosts/OpenApiHost/AIHelp.Open.WebApi | WebApi 站点 | 已确认 |
`;

  it('maps one project to every associated consumer site', () => {
    const result = mapProjectsToReleaseSites(
      ['AIHelp.Consumer/AIHelp.Consumer.csproj'],
      parseReleaseSiteMapping(mapping),
    );

    expect(result.releaseSites).toEqual([
      'consumer',
      'consumer_ai',
      'consumer_chatedit',
      'consumer_hash',
      'consumer_thirdparty',
      'consumer_wecom',
      'consumer_wxwork',
    ]);
    expect(result.unmappedProjects).toEqual([]);
  });

  it('maps OpenApiHost to both deploy sites', () => {
    const result = mapProjectsToReleaseSites(
      ['Hosts/OpenApiHost/AIHelp.Open.WebApi/AIHelp.Open.WebApi.csproj'],
      parseReleaseSiteMapping(mapping),
    );

    expect(result.releaseSites).toEqual(['app_api', 'openapi']);
  });

  it('prints unmapped projects directly', () => {
    const result = mapProjectsToReleaseSites(
      ['AIHelp.UnknownWorker/AIHelp.UnknownWorker.csproj'],
      parseReleaseSiteMapping(mapping),
    );

    expect(result.releaseSites).toEqual([]);
    expect(result.unmappedProjects).toEqual(['AIHelp.UnknownWorker/AIHelp.UnknownWorker.csproj']);
  });
});

describe('netcore fast incremental refresh', () => {
  it('refreshes changed C# file symbols and MQ endpoints without full analyze', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-netcore-refresh-'));
    await fs.mkdir(path.join(repo, 'AIHelp.Consumer'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'AIHelp.Consumer', 'AIHelp.Consumer.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(repo, 'AIHelp.Consumer', 'Program.cs'),
      'class OldName {}',
      'utf-8',
    );
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    await fs.writeFile(
      path.join(repo, 'AIHelp.Consumer', 'Program.cs'),
      `class NewName {
  void Send() {
    RabbitMQFactory.RedisTicketToMongo(null).PublishMsg("x");
  }
}`,
      'utf-8',
    );

    const index: FastIndex = {
      projects: [
        project({
          name: 'AIHelp.Consumer',
          path: 'AIHelp.Consumer/AIHelp.Consumer.csproj',
          outputType: 'Exe',
        }),
      ],
      nodes: [{ label: 'Class', name: 'OldName', filePath: 'AIHelp.Consumer/Program.cs' }],
      mq: { endpoints: [], links: [] },
    };

    const { index: refreshed, result } = await refreshNetcoreFastIndexForDiff(index, repo);

    expect(result.refreshedFiles).toBe(1);
    expect(refreshed.nodes?.some((node) => node.name === 'OldName')).toBe(false);
    expect(refreshed.nodes?.some((node) => node.name === 'NewName')).toBe(true);
    expect(refreshed.mq?.endpoints?.map((ep) => ep.topic)).toEqual(['RedisTicketToMongo']);
    expect(refreshed.mq?.links?.map((link) => link.topic)).toEqual(['RedisTicketToMongo']);
  });
});
