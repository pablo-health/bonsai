import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printEnvelope, successEnvelope, errorEnvelope } from './output';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = resolve(__dirname, '../../bundled/openapi.json');

let openApiSpec: any = null;

function loadOpenApiSpec(): any {
  if (openApiSpec) return openApiSpec;
  try {
    const raw = readFileSync(OPENAPI_PATH, 'utf-8');
    openApiSpec = JSON.parse(raw);
    return openApiSpec;
  } catch {
    return null;
  }
}

export function registerOpenApiCommands(program: Command): void {
  const openapi = new Command('openapi');
  openapi.description('OpenAPI spec inspection commands');

  openapi
    .command('dump')
    .description('Dump the full bundled OpenAPI spec')
    .option('--json', 'Emit JSON (default: true for this command)')
    .action((opts: { json?: boolean }) => {
      const spec = loadOpenApiSpec();
      if (!spec) {
        printEnvelope(errorEnvelope('SPEC_NOT_FOUND', 'OpenAPI spec not found', 500), true);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
    });

  openapi
    .command('paths')
    .description('List all API paths')
    .option('--methods', 'Include HTTP methods', false)
    .option('--json', 'Emit JSON', false)
    .action((opts: { methods?: boolean; json?: boolean }) => {
      const spec = loadOpenApiSpec();
      if (!spec) {
        printEnvelope(errorEnvelope('SPEC_NOT_FOUND', 'OpenAPI spec not found', 500), !!opts.json);
        process.exit(1);
      }

      const paths = spec.paths || {};
      const result: Array<{ path: string; methods?: string[] }> = [];

      for (const [path, item] of Object.entries(paths)) {
        const entry: { path: string; methods?: string[] } = { path };
        if (opts.methods) {
          entry.methods = Object.keys(item as Record<string, unknown>).filter(
            k => ['get', 'post', 'put', 'delete', 'patch'].includes(k)
          );
        }
        result.push(entry);
      }

      if (opts.json) {
        printEnvelope(successEnvelope(result), true);
      } else {
        for (const entry of result) {
          const methods = entry.methods ? ` [${entry.methods.join(', ')}]` : '';
          process.stdout.write(`${entry.path}${methods}\n`);
        }
      }
    });

  openapi
    .command('schemas')
    .description('List all schema names')
    .option('--json', 'Emit JSON', false)
    .action((opts: { json?: boolean }) => {
      const spec = loadOpenApiSpec();
      if (!spec) {
        printEnvelope(errorEnvelope('SPEC_NOT_FOUND', 'OpenAPI spec not found', 500), !!opts.json);
        process.exit(1);
      }

      const schemas = spec.components?.schemas || {};
      const names = Object.keys(schemas);

      if (opts.json) {
        printEnvelope(successEnvelope(names), true);
      } else {
        for (const name of names) {
          process.stdout.write(`${name}\n`);
        }
      }
    });

  openapi
    .command('schema')
    .description('Show a specific schema definition')
    .requiredOption('--name <name>', 'Schema name')
    .option('--json', 'Emit JSON (default: true for this command)')
    .action((opts: { name: string; json?: boolean }) => {
      const spec = loadOpenApiSpec();
      if (!spec) {
        printEnvelope(errorEnvelope('SPEC_NOT_FOUND', 'OpenAPI spec not found', 500), true);
        process.exit(1);
      }

      const schemas = spec.components?.schemas || {};
      const schema = schemas[opts.name];

      if (!schema) {
        printEnvelope(errorEnvelope('SCHEMA_NOT_FOUND', `Schema '${opts.name}' not found`, 404), true);
        process.exit(1);
      }

      process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
    });

  program.addCommand(openapi);
}
