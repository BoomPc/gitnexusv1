import { describe, expect, it } from 'vitest';
import {
  isReleaseProject,
  netcoreImpact,
  upstreamReleaseProjects,
  type FastIndex,
  type FastProject,
} from '../../src/core/netcore-fast-index.js';

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
