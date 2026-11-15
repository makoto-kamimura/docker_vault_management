import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

// One Postgres container for the whole run; every test file gets its own database from it.
export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:16').start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}
