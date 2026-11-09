import next from 'eslint-config-next';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'public/**', '.gitcraft-work/**', 'tests/e2e.mjs', 'tests/fixtures/**', '**/*.d.mts'] },
  ...next,
];
export default config;
