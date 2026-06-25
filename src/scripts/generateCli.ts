import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOpenAPISpec } from '../swagger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '../..');
const CLI_DIR = join(ROOT, 'cli');
const CLI_SRC = join(CLI_DIR, 'src');
const BUNDLED_DIR = join(CLI_DIR, 'bundled');
const GENERATED_DIR = join(CLI_SRC, 'generated');

// ─── Types ───────────────────────────────────────────────────────────────────

interface PathParam {
  name: string;
  required: boolean;
}

interface Operation {
  method: string;
  path: string;
  pathTemplate: string;
  pathParams: PathParam[];
  queryParamNames: string[];
  hasBody: boolean;
  bodySchemaRef: string | null;
  action: string;
  summary: string;
  description: string;
}

interface ResourceDef {
  name: string;
  scope: 'global' | 'project';
  operations: Operation[];
}

// ─── Path Parsing ────────────────────────────────────────────────────────────

const SKIP_PATTERNS = ['/callback', '/webhook', '/signaling', '/verify', '/authorize'];

function shouldSkip(path: string): boolean {
  return SKIP_PATTERNS.some(p => path.includes(p));
}

function extractPathParams(path: string): PathParam[] {
  const params: PathParam[] = [];
  const regex = /\{(\w+)\}/g;
  let match;
  while ((match = regex.exec(path)) !== null) {
    params.push({ name: match[1], required: true });
  }
  return params;
}

function toResourceName(pathSegment: string): string {
  return pathSegment.replace(/{/, '').replace(/}/, '').replace(/-([a-z])/g, (_, c) => `_${c.toLowerCase()}`);
}

function isProjectScoped(path: string): boolean {
  return path.match(/\/projects\/\{projectId\}\//) !== null;
}

const ACTION_SEGMENTS = new Set(['clone', 'archive', 'unarchive', 'events', 'event', 'artifacts', 'artifact', 'artifact_download', 'audit-logs', 'results', 'cancel', 'execute', 'preview', 'reveal', 'models', 'login', 'refresh', 'status', 'initial-operator', 'profile', 'scope', 'pull', 'jobs']);

function extractResourceName(path: string): string {
  const segs = path.split('/').filter(Boolean);

  if (isProjectScoped(path)) {
    const projectIdx = segs.findIndex(s => s === '{projectId}');
    if (projectIdx >= 0 && projectIdx + 1 < segs.length) {
      const afterProject = segs.slice(projectIdx + 1);
      let parts: string[] = [];
      for (const s of afterProject) {
        if (s.startsWith('{')) break;
        if (ACTION_SEGMENTS.has(s)) break;
        parts.push(s);
      }
      if (parts.length === 0) parts.push(afterProject[0]);
      return parts.map(toResourceName).join('_');
    }
  }

  const apiIdx = segs.findIndex(s => s === 'api');
  if (apiIdx >= 0 && apiIdx + 1 < segs.length) {
    const afterApi = segs.slice(apiIdx + 1);
    let parts: string[] = [];
    for (const s of afterApi) {
      if (s.startsWith('{')) break;
      if (ACTION_SEGMENTS.has(s)) break;
      parts.push(s);
    }
    if (parts.length === 0) parts.push(afterApi[0]);
    return parts.map(toResourceName).join('_');
  }

  return '';
}

function determineAction(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  const secondLast = segs.length > 1 ? segs[segs.length - 2] : '';

  if (path.includes('/login')) return 'login';
  if (path.includes('/refresh')) return 'refresh';
  if (path.includes('/status')) return 'status';
  if (path.includes('/initial-operator')) return 'setup';
  if (path.includes('/profile')) return 'profile';
  if (path.includes('/models')) return 'models';

  if (last === 'clone') return 'clone';
  if (last === 'archive') return 'archive';
  if (last === 'unarchive') return 'unarchive';
  if (last === 'events') return 'events';
  if (last === 'event' && secondLast === 'events') return 'event';
  if (last === 'artifacts') return 'artifacts';
  if (last === 'artifact' && secondLast === 'artifacts') return 'artifact';
  if (last === 'artifact_download') return 'artifact_download';
  if (last === 'audit-logs') return 'audit';
  if (last === 'results') return 'results';
  if (last === 'cancel') return 'cancel';
  if (last === 'execute') return 'execute';
  if (last === 'preview') return 'preview';
  if (last === 'reveal') return 'reveal';

  if (method === 'get' && last.includes('{')) return 'get';
  if (method === 'get') return 'list';
  if (method === 'post') return 'create';
  if (method === 'put') return 'update';
  if (method === 'delete') return 'delete';

  return last || 'execute';
}

function parseOperations(spec: any): Map<string, ResourceDef> {
  const resources = new Map<string, ResourceDef>();

  const paths = spec.paths || {};

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (shouldSkip(rawPath)) continue;

    const allPathParams = extractPathParams(rawPath);
    const scope: 'global' | 'project' = isProjectScoped(rawPath) ? 'project' : 'global';
    const resourceName = extractResourceName(rawPath);

    if (!resourceName) continue;

    const pathParams = allPathParams.filter(p => p.name !== 'projectId');

    for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
      const op = (pathItem as any)[method];
      if (!op) continue;

      const queryParamNames: string[] = [];
      if (op.parameters && Array.isArray(op.parameters)) {
        for (const param of op.parameters) {
          if (param.in === 'query' && param.name) {
            queryParamNames.push(param.name);
          }
        }
      }

      const requestBody = op.requestBody;
      let hasBody = !!requestBody;
      let bodySchemaRef: string | null = null;

      if (requestBody && requestBody.content && requestBody.content['application/json']) {
        const schema = requestBody.content['application/json'].schema;
        if (schema && schema.$ref) {
          bodySchemaRef = schema.$ref.replace('#/components/schemas/', '');
        }
        hasBody = true;
      }

      let action = determineAction(method, rawPath);
      const summary = op.summary || `${action} ${resourceName}`;
      const description = op.description || summary;

      const key = `${scope}/${resourceName}`;
      let resource = resources.get(key);

      if (!resource) {
        resource = { name: resourceName, scope, operations: [] };
        resources.set(key, resource);
      }

      resource.operations.push({
        method,
        path: rawPath,
        pathTemplate: rawPath,
        pathParams,
        queryParamNames,
        hasBody,
        bodySchemaRef,
        action,
        summary,
        description,
      });
    }
  }

  // Deduplicate action names within each resource
  for (const [, resource] of resources) {
    const seen = new Map<string, number>();
    for (const op of resource.operations) {
      const count = seen.get(op.action) || 0;
      seen.set(op.action, count + 1);
      if (count > 0) {
        op.action = `${op.action}_${count}`;
      }
    }
  }

  return resources;
}

// ─── Code Generation ─────────────────────────────────────────────────────────

function generateResourcesManifest(resources: Map<string, ResourceDef>): string {
  let code = '// Auto-generated by generateCli.ts — DO NOT EDIT\n\n';
  code += 'export interface PathParam { name: string; required: boolean; }\n';
  code += 'export interface Operation {\n';
  code += '  method: string;\n  path: string;\n  pathTemplate: string;\n';
  code += '  pathParams: PathParam[];\n  queryParamNames: string[];\n';
  code += '  hasBody: boolean;\n  bodySchemaRef: string | null;\n';
  code += '  action: string;\n  summary: string;\n  description: string;\n';
  code += '}\nexport interface ResourceDef {\n';
  code += '  name: string;\n  scope: "global" | "project";\n  operations: Operation[];\n}\n\n';

  code += 'export const RESOURCES: Record<string, ResourceDef> = {\n';
  for (const [, resource] of resources) {
    code += `  "${resource.name}": {\n`;
    code += `    name: "${resource.name}",\n`;
    code += `    scope: "${resource.scope}",\n`;
    code += `    operations: [\n`;
    for (const op of resource.operations) {
      code += `      {\n`;
      code += `        method: "${op.method}",\n`;
      code += `        path: "${op.path}",\n`;
      code += `        pathTemplate: "${op.pathTemplate}",\n`;
      code += `        pathParams: ${JSON.stringify(op.pathParams)},\n`;
      code += `        queryParamNames: ${JSON.stringify(op.queryParamNames)},\n`;
      code += `        hasBody: ${op.hasBody},\n`;
      code += `        bodySchemaRef: ${op.bodySchemaRef ? `"${op.bodySchemaRef}"` : 'null'},\n`;
      code += `        action: "${op.action}",\n`;
      code += `        summary: ${JSON.stringify(op.summary)},\n`;
      code += `        description: ${JSON.stringify(op.description)},\n`;
      code += `      },\n`;
    }
    code += `    ],\n`;
    code += `  },\n`;
  }
  code += '};\n\n';

  code += 'export function getResourceNames(): string[] {\n';
  code += '  return Object.keys(RESOURCES);\n';
  code += '}\n';

  return code;
}

function generateCommandsFile(resources: Map<string, ResourceDef>): string {
  let code = '// Auto-generated by generateCli.ts — DO NOT EDIT\n\n';
  code += "import { Command } from 'commander';\n";
  code += "import { RESOURCES, ResourceDef } from './resources.js';\n";
  code += "import { runOperation } from '../lib/handler.js';\n\n";

  code += 'export function registerCommands(program: Command): void {\n';
  code += '  const resourceNames = Object.keys(RESOURCES);\n\n';

  code += '  for (const name of resourceNames) {\n';
  code += '    const res = RESOURCES[name] as ResourceDef;\n\n';

  code += '    const cmd = new Command(res.name)\n';
  code += '      .description(`${res.name.charAt(0).toUpperCase() + res.name.slice(1)} ${res.scope === "project" ? "(project-scoped)" : "(global)"}`)\n';
  code += '      .option(\'--json\', \'Emit JSON envelope\', false)\n';
  code += '      .option(\'-v, --verbose\', \'Verbose output\', false)\n';

  code += '    if (res.scope === "project") {\n';
  code += '      cmd.option(\'--project <id>\', \'Project ID\');\n';
  code += '    }\n\n';

  code += '    for (const op of res.operations) {\n';
  code += '      const argStr = op.pathParams.map(p => `<${p.name}>`).join(\' \');\n';
   code += '      const actionCmd = cmd.command(op.action)\n';
  code += '        .description(op.summary)\n';
  code += '        .option(\'--json\', \'Emit JSON envelope\', false)\n';
  code += '        .option(\'-v, --verbose\', \'Verbose output\', false)\n';

  code += '      if (res.scope === "project") {\n';
  code += '        actionCmd.option(\'--project <id>\', \'Project ID\');\n';
  code += '      }\n';

  code += '      if (op.hasBody) {\n';
  code += '        actionCmd\n';
  code += '          .option(\'--data <json>\', \'Request body as JSON string, or "-" for stdin\')\n';
  code += '          .option(\'--data-file <path>\', \'Request body from JSON file\');\n';
  code += '      }\n';

  code += '      for (const qp of op.queryParamNames) {\n';
  code += '        actionCmd.option(`--${qp} <value>`, qp);\n';
  code += '      }\n\n';

  code += '      actionCmd\n';
  code += '        .action(async (args: Record<string, string>, opts: any) => {\n';
  code += '          const allOpts = { ...opts };\n';
  code += '          if (args && typeof args === "object") {\n';
  code += '            Object.assign(allOpts, args);\n';
  code += '          }\n';
  code += '          const exitCode = await runOperation(\n';
  code += '            { method: op.method, pathTemplate: op.pathTemplate, scope: res.scope, action: op.action, pathParamNames: op.pathParams.map(p => p.name), queryParamNames: op.queryParamNames },\n';
  code += '            allOpts\n';
  code += '          );\n';
  code += '          process.exit(exitCode);\n';
  code += '        });\n';
  code += '    }\n\n';

  code += '    program.addCommand(cmd);\n';
  code += '  }\n';
  code += '}\n';

  return code;
}

function generateIndex(resources: Map<string, ResourceDef>): string {
  const resourceList = [...resources.values()]
    .map(r => `  ${r.name.padEnd(25)} ${r.scope === 'project' ? '(project)' : '(global)'}`)
    .join('\\n');

  let code = '// Auto-generated by generateCli.ts — DO NOT EDIT\n\n';
  code += "import { Command } from 'commander';\n";
  code += "import { registerCommands } from './generated/commands.js';\n";
  code += "import { getResourceNames } from './generated/resources.js';\n";
  code += "import { loadConfig } from './lib/config.js';\n\n";

  code += 'const program = new Command();\n\n';
  code += 'program\n';
  code += '  .name(\'bonsai\')\n';
  code += '  .description(\'Bonsai agentic CLI\\n\\nResources:\\n\' + \'' + resourceList + '\')\n';
  code += '  .version(process.env.npm_package_version || \'0.1.0\')\n';
  code += '  .option(\'--json\', \'Emit JSON envelope\', false)\n';
  code += '  .option(\'-v, --verbose\', \'Verbose output\', false)\n';
  code += '  .option(\'-q, --quiet\', \'Suppress non-essential output\', false)\n';
  code += '  .option(\'--base-url <url>\', \'API base URL\')\n';
  code += '  .option(\'--project <id>\', \'Default project ID\')\n';
  code += '  .option(\'--token <string>\', \'Auth token\')\n';
  code += '  .option(\'--timeout <ms>\', \'Request timeout\', \'30000\')\n';
  code += '  .hook(\'preAction\', async () => {\n';
  code += '    // Config is resolved per-command in handler\n';
  code += '  })\n';

  code += '\nregisterCommands(program);\n\n';

  code += '// Discovery commands\n';
  code += 'program.command(\'resources\')\n';
  code += '  .description(\'List all available resources\')\n';
  code += '  .option(\'--json\', \'Emit JSON\', false)\n';
  code += '  .action((opts: any) => {\n';
  code += '    const names = getResourceNames();\n';
  code += '    if (opts.json) {\n';
  code += '      process.stdout.write(JSON.stringify({ status: "ok", data: names, error: null, meta: {} }) + "\\n");\n';
  code += '    } else {\n';
  code += '      for (const name of names) {\n';
  code += '        process.stdout.write(name + "\\n");\n';
  code += '      }\n';
  code += '    }\n';
  code += '  });\n\n';

  code += 'program.parse();\n';

  return code;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('Generating OpenAPI spec...');
  const spec = getOpenAPISpec();

  // Write bundled OpenAPI spec
  mkdirSync(BUNDLED_DIR, { recursive: true });
  writeFileSync(join(BUNDLED_DIR, 'openapi.json'), JSON.stringify(spec, null, 2));
  console.log(`  → ${BUNDLED_DIR}/openapi.json`);

  // Parse resources
  const resources = parseOperations(spec);
  console.log(`  Found ${resources.size} resources`);

  for (const [, res] of resources) {
    console.log(`  ${res.name} (${res.scope}): ${res.operations.map(o => o.action).join(', ')}`);
  }

  // Clear generated directory
  if (true) {
    try {
      rmSync(GENERATED_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  mkdirSync(GENERATED_DIR, { recursive: true });

  // Generate resources manifest
  const manifestCode = generateResourcesManifest(resources);
  writeFileSync(join(GENERATED_DIR, 'resources.ts'), manifestCode);
  console.log(`  → ${GENERATED_DIR}/resources.ts`);

  // Generate commands registration
  const commandsCode = generateCommandsFile(resources);
  writeFileSync(join(GENERATED_DIR, 'commands.ts'), commandsCode);
  console.log(`  → ${GENERATED_DIR}/commands.ts`);

  // Generate index.ts
  const indexCode = generateIndex(resources);
  writeFileSync(join(CLI_SRC, 'index.ts'), indexCode);
  console.log(`  → ${CLI_SRC}/index.ts`);

  console.log('\nDone. Run `cd cli && npm install && npx tsx src/index.ts --help` to test.');
}

main();
