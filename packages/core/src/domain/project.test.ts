import { describe, expect, it } from 'vitest';
import { defineProject } from './project.js';

describe('defineProject', () => {
  it('synthesizes a single primary resource from the mission repo', () => {
    const project = defineProject({
      name: 'demo',
      repoUrl: 'https://example.com/demo.git',
      snapshot: 'demo-snapshot',
    });
    expect(project.resources.map((resource) => resource.key)).toEqual(['primary']);
    expect(project.resources[0]).toMatchObject({
      primary: true,
      workspaceDir: project.workspaceDir,
    });
  });

  it('is idempotent when re-resolving an already-defined project', () => {
    const once = defineProject({
      name: 'demo',
      repoUrl: 'https://example.com/demo.git',
      snapshot: 'demo-snapshot',
    });
    const twice = defineProject(once);
    const thrice = defineProject(twice);
    expect(twice.resources.map((resource) => resource.key)).toEqual(['primary']);
    expect(thrice.resources.map((resource) => resource.key)).toEqual(['primary']);
  });

  it('places sibling resources at fixed conventional paths under the primary root', () => {
    const project = defineProject({
      name: 'demo',
      repoUrl: 'https://example.com/demo.git',
      snapshot: 'demo-snapshot',
      resources: [{ key: 'docs', repoUrl: 'https://example.com/docs.git', branch: 'main' }],
    });
    expect(project.resources.map((resource) => resource.key)).toEqual(['primary', 'docs']);
    const docs = project.resources.find((resource) => resource.key === 'docs');
    expect(docs).toMatchObject({
      primary: false,
      workspaceDir: `${project.workspaceDir}/resources/docs`,
    });
  });

  it('keeps sibling resources stable across a re-resolve', () => {
    const once = defineProject({
      name: 'demo',
      repoUrl: 'https://example.com/demo.git',
      snapshot: 'demo-snapshot',
      resources: [{ key: 'docs', repoUrl: 'https://example.com/docs.git', branch: 'main' }],
    });
    const twice = defineProject(once);
    expect(twice.resources.map((resource) => resource.key)).toEqual(['primary', 'docs']);
  });
});
