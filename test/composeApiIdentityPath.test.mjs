import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync(
  new URL('../docker-compose.yml', import.meta.url),
  'utf8',
);

test('compose API resolves durable identity state at its mounted data directory', () => {
  const apiService = compose.match(
    /^  api:\n(?<service>[\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|^networks:)/mu,
  )?.groups?.service;

  assert.ok(apiService, 'docker-compose.yml must define the API service');
  assert.match(
    apiService,
    /command: sh -c "cd \/usr\/src\/app\/packages\/api && npx tsx server\.ts"/u,
  );
  assert.match(apiService, /^      - \.\/data:\/usr\/src\/app\/data$/mu);
  assert.match(apiService, /^      - DATA_DIR=\/usr\/src\/app\/data$/mu);

  // Compose environment entries must override the relative filename in .env.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const exampleDatabase = example.match(/^DB_FILENAME=(.+)$/mu)?.[1];
  assert.equal(exampleDatabase, './data/propr.sqlite');
  assert.match(apiService, /env_file:\n(?:      #.*\n)*      - \$\{STAGING_ENV_FILE:-\.env\}/u);
  const overrides = Object.fromEntries(
    [...apiService.matchAll(/^      - (DB_FILENAME|DATA_DIR)=(.+)$/gmu)]
      .map(([, key, value]) => [key, value]),
  );
  const environment = { DB_FILENAME: exampleDatabase, ...overrides };
  assert.equal(environment.DB_FILENAME, '/usr/src/app/data/propr.sqlite');
  assert.equal(environment.DATA_DIR, '/usr/src/app/data');

  const explicitDataDirectories = compose.match(/^\s+- DATA_DIR=.*$/gmu) ?? [];
  assert.deepEqual(explicitDataDirectories, [
    '      - DATA_DIR=/usr/src/app/data',
  ]);
});
