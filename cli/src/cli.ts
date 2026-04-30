#!/usr/bin/env node
import { confirm } from '@clack/prompts';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import * as projects from './commands/projects/index.js';
import * as agents from './commands/agents/index.js';
import * as stages from './commands/stages/index.js';
import * as classifiers from './commands/classifiers/index.js';
import * as tools from './commands/tools/index.js';
import * as globalActions from './commands/global-actions/index.js';
import * as guardrails from './commands/guardrails/index.js';
import * as knowledge from './commands/knowledge/index.js';
import * as users from './commands/users/index.js';
import * as conversations from './commands/conversations/index.js';
import * as providers from './commands/providers/index.js';
import * as environments from './commands/environments/index.js';
import * as apiKeys from './commands/api-keys/index.js';
import * as operators from './commands/operators/index.js';
import * as issues from './commands/issues/index.js';
import * as testers from './commands/testers/index.js';
import * as scenarios from './commands/scenarios/index.js';
import * as scenarioRuns from './commands/scenario-runs/index.js';
import * as analytics from './commands/analytics/index.js';
import * as auditLogs from './commands/audit-logs/index.js';
import * as migrations from './commands/migrations/index.js';
import * as secrets from './commands/secrets/index.js';
import * as sampleCopies from './commands/sample-copies/index.js';
import * as copyDecorators from './commands/copy-decorators/index.js';
import * as contextTransformers from './commands/context-transformers/index.js';
import * as savedSliceQueries from './commands/saved-slice-queries/index.js';
import * as scenarioConversations from './commands/scenario-conversations/index.js';

const VERSION = '0.1.0';

function printUsage() {
  console.log(`\n  Bonsai CLI v${VERSION}\n`);
 console.log('  Usage:');
    console.log('    bonsai-cli <command> [subcommand] [options]\n');
  console.log('  Auth:');
  console.log('    login              Log in with email/password');
  console.log('    logout             Clear stored credentials');
  console.log('    whoami             Show current operator profile\n');
  console.log('  Projects:');
  console.log('    projects list [--search TERM] [--archived]');
  console.log('    projects show <id>');
  console.log('    projects create --name NAME [--description DESC]');
  console.log('    projects archive <id>');
  console.log('    projects delete <id>\n');
  console.log('  Agents:');
  console.log('    agents list [--search TERM]');
  console.log('    agents show <id>');
  console.log('    agents create --name NAME [--description DESC] [--prompt TEXT] [--tags a,b,c]');
  console.log('    agents edit <id> [--name NAME] [--description DESC] [--prompt TEXT]');
  console.log('    agents clone <id> [new-name]');
  console.log('    agents delete <id>\n');
  console.log('  Stages:');
  console.log('    stages list [--search TERM]');
  console.log('    stages show <id>');
  console.log('    stages create --name NAME [--description DESC] [--prompt TEXT] [--tags a,b,c]');
  console.log('    stages edit <id> [--name NAME] [--description DESC] [--prompt TEXT]');
  console.log('    stages clone <id> [new-name]');
  console.log('    stages delete <id>\n');
  console.log('  Classifiers:');
  console.log('    classifiers list [--search TERM]');
  console.log('    classifiers show <id>');
  console.log('    classifiers create --name NAME [--description DESC] [--prompt TEXT] [--tags a,b,c]');
  console.log('    classifiers edit <id> [--name NAME] [--description DESC] [--prompt TEXT]');
  console.log('    classifiers clone <id> [new-name]');
  console.log('    classifiers delete <id>\n');
  console.log('  Tools:');
  console.log('    tools list [--search TERM]');
  console.log('    tools show <id>');
  console.log('    tools create --name NAME [--description DESC] [--type smart_function|webhook|script] [--tags a,b,c]');
  console.log('    tools edit <id> [--name NAME] [--description DESC] [--type TYPE]');
  console.log('    tools clone <id> [new-name]');
  console.log('    tools delete <id>\n');
  console.log('  Global Actions:');
  console.log('    global-actions list [--search TERM]');
  console.log('    global-actions show <id>');
  console.log('    global-actions create --name NAME [--description DESC] [--tags a,b,c]');
  console.log('    global-actions edit <id> [--name NAME] [--description DESC]');
  console.log('    global-actions clone <id> [new-name]');
  console.log('    global-actions delete <id>\n');
  console.log('  Guardrails:');
  console.log('    guardrails list [--search TERM]');
  console.log('    guardrails show <id>');
  console.log('    guardrails create --name NAME [--description DESC] [--tags a,b,c]');
  console.log('    guardrails edit <id> [--name NAME] [--description DESC]');
  console.log('    guardrails clone <id> [new-name]');
  console.log('    guardrails delete <id>\n');
  console.log('  Knowledge:');
  console.log('    knowledge categories list [--search TERM]');
  console.log('    knowledge categories show <id>');
  console.log('    knowledge categories create --name NAME --trigger TRIGGER [--tags a,b,c]');
  console.log('    knowledge categories edit <id> [--name NAME] [--trigger TRIGGER] [--version N]');
  console.log('    knowledge categories delete <id>');
  console.log('    knowledge items list [--category CAT_ID]');
  console.log('    knowledge items show <id>');
  console.log('    knowledge items create --category CAT_ID --question Q --answer A');
  console.log('    knowledge items edit <id> [--question Q] [--answer A] [--version N]');
  console.log('    knowledge items delete <id>\n');

  console.log('  Users:');
  console.log('    users list');
  console.log('    users show <id>');
  console.log('    users create --profile \'{"email":"user@example.com"}\'');
  console.log('    users edit <id> [--profile JSON] [--banned true/false] [--ban-reason TEXT]');
  console.log('    users delete <id>\n');

  console.log('  Conversations:');
  console.log('    conversations list');
  console.log('    conversations show <id>');
  console.log('    conversations events <id>');
  console.log('    conversations event <conv-id> <event-id>');
  console.log('    conversations patch <id> [--status status] [--stage STAGE_ID]');
  console.log('    conversations delete <id>\n');

  console.log('  Providers:');
  console.log('    providers list [--type ASR|TTS|LLM|Embeddings|Storage|Moderation]');
  console.log('    providers show <id>');
  console.log('    providers models <id>');
  console.log('    providers create --name NAME --type TYPE [--active true/false]');
  console.log('    providers edit <id> [--name NAME] [--type TYPE] [--active true/false]');
  console.log('    providers delete <id>\n');

  console.log('  Environments:');
  console.log('    environments list');
  console.log('    environments show <id>');
  console.log('    environments create --name NAME [--description DESC]');
  console.log('    environments edit <id> [--name NAME] [--description DESC]');
  console.log('    environments delete <id>\n');

  console.log('  API Keys:');
  console.log('    api-keys list');
  console.log('    api-keys show <id>');
  console.log('    api-keys create --name NAME [--permissions a,b,c] [--expires DATE]');
  console.log('    api-keys edit <id> [--name NAME] [--permissions a,b,c] [--expires DATE]');
  console.log('    api-keys delete <id>\n');

  console.log('  Operators:');
  console.log('    operators list');
  console.log('    operators show <id>');
  console.log('    operators create --email EMAIL --password PASS [--name NAME] [--roles a,b,c]');
  console.log('    operators edit <id> [--name NAME] [--roles a,b,c]\n');

  console.log('  Issues:');
  console.log('    issues list [--project ID] [--status STATUS]');
  console.log('    issues show <id>\n');

  console.log('  Testers:');
  console.log('    testers list');
  console.log('    testers show <id>');
  console.log('    testers create --name NAME [--type web|nodejs]');
  console.log('    testers edit <id> [--name NAME]\n');

  console.log('  Scenarios:');
  console.log('    scenarios list');
  console.log('    scenarios show <id>');
  console.log('    scenarios create --name NAME --language LANG --starting-stage ID --max-turns N');
  console.log('    scenarios edit <id> [--name NAME] [--version N]\n');

  console.log('  Scenario Runs:');
  console.log('    scenario-runs list [--scenario SCENARIO_ID]');
  console.log('    scenario-runs show <id>\n');

  console.log('  Analytics:');
  console.log('    analytics latency [--from DATE] [--to DATE] [--stage ID]');
  console.log('    analytics percentiles [--from DATE] [--to DATE]');
  console.log('    analytics trend [--interval day|hour|week]');
  console.log('    analytics timeline <conversation-id>');
  console.log('    analytics usage [--from DATE] [--to DATE]');
  console.log('    analytics usage-trend [--interval day]\n');

  console.log('  Audit Logs:');
  console.log('    audit-logs list [--entity-type TYPE] [--action CREATE|UPDATE|DELETE]');
  console.log('    audit-logs show <id>\n');

  console.log('  Migrations:');
  console.log('    migrations preview [--projects ID1,ID2]');
  console.log('    migrations pull <environment-id> [--dry-run]\n');

  console.log('  Secrets:');
  console.log('    secrets list');
  console.log('    secrets reveal <id> (super_admin only)');
  console.log('    secrets delete <id>\n');

  console.log('  Sample Copies:');
  console.log('    sample-copies list --project ID');
  console.log('    sample-copies show <id> --project ID');
  console.log('    sample-copies create --name NAME --prompt-trigger TEXT --content TEXT --project ID [--amount N] [--sampling-method random|round_robin] [--mode regular|forced] [--classifier-override-id ID] [--decorator-id ID] [--stages a,b,c] [--agents a,b,c]');
  console.log('    sample-copies edit <id> --project ID [--name NAME] [--prompt-trigger TEXT] [--content TEXT] [--amount N] [--version N]');
  console.log('    sample-copies clone <id> --project ID [new-name]');
  console.log('    sample-copies delete <id> --project ID\n');

  console.log('  Copy Decorators:');
  console.log('    copy-decorators list --project ID');
  console.log('    copy-decorators show <id> --project ID');
  console.log('    copy-decorators create --name NAME --template TEXT --project ID');
  console.log('    copy-decorators edit <id> --project ID [--name NAME] [--template TEXT] [--version N]');
  console.log('    copy-decorators delete <id> --project ID\n');

  console.log('  Context Transformers:');
  console.log('    context-transformers list --project ID');
  console.log('    context-transformers show <id> --project ID');
  console.log('    context-transformers create --name NAME --prompt TEXT --llm-provider-id ID --project ID [--description DESC] [--context-fields a,b,c] [--tags a,b,c]');
  console.log('    context-transformers edit <id> --project ID [--name NAME] [--prompt TEXT] [--version N]');
  console.log('    context-transformers clone <id> --project ID [new-name]');
  console.log('    context-transformers delete <id> --project ID\n');

  console.log('  Saved Slice Queries:');
  console.log('    saved-slice-queries list --project ID');
  console.log('    saved-slice-queries show <id> --project ID');
  console.log('    saved-slice-queries create --name NAME --query JSON --project ID [--shared true/false]');
  console.log('    saved-slice-queries edit <id> --project ID [--name NAME] [--query JSON] [--version N]');
  console.log('    saved-slice-queries delete <id> --project ID\n');

  console.log('  Scenario Conversations:');
  console.log('    scenario-conversations list --project ID [--run-id RUN_ID]');
  console.log('    scenario-conversations show <id> --project ID\n');

  console.log('  Coming soon:');
  console.log('    catalog, export, import\n');
  console.log('  Environment variables:');
  console.log('    BONSAI_API_URL     API base URL (default: https://app.bonsai.ai)');
  console.log('    BONSAI_PROJECT_ID  Default project ID');
  console.log('    BONSAI_API_KEY     Use API key auth instead of JWT\n');
}

function requireAuth(): boolean {
  const config = loadConfig();
  if (!config?.accessToken) {
    console.error(chalk.red('  ✖ Not logged in. Run `bonsai login` first.'));
    return false;
  }
  return true;
}

function getProjectId(args?: string[]): string | never {
  const config = loadConfig();
  const flagProj = args ? getFlag(args, '--project') : undefined;
  return flagProj || process.env.BONSAI_PROJECT_ID || config?.lastProjectId || (() => {
    console.error(chalk.red('  ✖ Project ID required. Use --project <id> or set BONSAI_PROJECT_ID.'));
    process.exit(1);
  })();
}

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function getPosArg(args: string[]): string | undefined {
  return args.find(a => !a.startsWith('--'));
}

interface ResourceCommands {
  list?: (search?: string) => Promise<void>;
  show?: (id: string) => Promise<void>;
  create?: (flags?: Record<string, string>) => Promise<void>;
  edit?: (id: string, flags?: Record<string, string>) => Promise<void>;
  clone?: (id: string, newName?: string) => Promise<void>;
  delete?: (id: string) => Promise<void>;
}

async function handleResourceCommand(
  command: string, subcommand: string, args: string[],
  cmds: ResourceCommands
): Promise<void> {
  switch (subcommand) {
    case 'list':
    case 'ls': {
      const search = getFlag(args, '--search');
      if (cmds.list) await cmds.list(search);
      break;
    }
    case 'show':
    case 'get': {
      const id = getPosArg(args);
      if (id && cmds.show) await cmds.show(id);
      break;
    }
    case 'create':
    case 'new': {
      const flags: Record<string, string> = {};
      for (const flag of ['--name', '--description', '--prompt', '--type', '--tags']) {
        const val = getFlag(args, flag);
        if (val) flags[flag.replace('--', '')] = val;
      }
      if (cmds.create) await cmds.create(flags);
      break;
    }
    case 'edit':
    case 'update': {
      const id = getPosArg(args);
      const flags: Record<string, string> = {};
      for (const flag of ['--name', '--description', '--prompt', '--type', '--tags']) {
        const val = getFlag(args, flag);
        if (val) flags[flag.replace('--', '')] = val;
      }
      if (id && cmds.edit) await cmds.edit(id, flags);
      break;
    }
    case 'clone': {
      const id = getPosArg(args);
      const newName = args.find(a => !a.startsWith('--') && a !== id);
      if (id && cmds.clone) await cmds.clone(id, newName);
      break;
    }
    case 'delete':
    case 'rm': {
      const id = getPosArg(args);
      if (id && cmds.delete) await cmds.delete(id);
      break;
    }
    default:
      console.error(chalk.red(`  ✖ Unknown ${command} subcommand: ${subcommand}`));
      printUsage();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];
  const restArgs = args.slice(2);

  if (args.length === 0 || command === '-h' || command === '--help' || command === 'help') {
    printUsage();
    return;
  }

  if (command === '-v' || command === '--version' || command === 'version') {
    console.log(`bonsai-cli v${VERSION}`);
    return;
  }

  switch (command) {
    case 'login': await loginCommand(); break;
    case 'logout': await logoutCommand(); break;
    case 'whoami': await whoamiCommand(); break;

    case 'projects': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': {
          const search = getFlag(restArgs, '--search');
          const archived = restArgs.includes('--archived');
          await projects.listProjects(search, archived);
          break;
        }
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await projects.showProject(id);
          break;
        }
        case 'create':
        case 'new': {
          const name = getFlag(restArgs, '--name');
          const description = getFlag(restArgs, '--description');
          if (name) await projects.createProject(name, description);
          break;
        }
        case 'archive': {
          const id = getPosArg(restArgs);
          if (id) await projects.archiveProject(id);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await projects.deleteProject(id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown projects subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'agents': {
      if (!requireAuth()) return;
      await handleResourceCommand('agents', subcommand, restArgs, agents as ResourceCommands);
      break;
    }

    case 'stages': {
      if (!requireAuth()) return;
      await handleResourceCommand('stages', subcommand, restArgs, stages as ResourceCommands);
      break;
    }

    case 'classifiers': {
      if (!requireAuth()) return;
      await handleResourceCommand('classifiers', subcommand, restArgs, classifiers as ResourceCommands);
      break;
    }

    case 'tools': {
      if (!requireAuth()) return;
      await handleResourceCommand('tools', subcommand, restArgs, tools as ResourceCommands);
      break;
    }

    case 'global-actions': {
      if (!requireAuth()) return;
      await handleResourceCommand('global-actions', subcommand, restArgs, globalActions as ResourceCommands);
      break;
    }

    case 'guardrails': {
      if (!requireAuth()) return;
      await handleResourceCommand('guardrails', subcommand, restArgs, guardrails as ResourceCommands);
      break;
    }

    case 'knowledge': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      if (!subcommand || !['categories', 'items'].includes(subcommand)) {
        console.error(chalk.red(`  ✖ Unknown knowledge subcommand: ${subcommand}`));
        printUsage();
        break;
      }
      const resourceSub = args[0];
      const resourceArgs = args.slice(1);
      if (subcommand === 'categories') {
        switch (resourceSub) {
          case 'list':
          case 'ls': {
            const search = getFlag(resourceArgs, '--search');
            await knowledge.listCategories(projectId);
            break;
          }
          case 'show':
          case 'get': {
            const id = getPosArg(resourceArgs);
            if (id) await knowledge.showCategory(projectId, id);
            break;
          }
          case 'create':
          case 'new': {
            const flags: Record<string, string> = {};
            for (const flag of ['--name', '--trigger', '--tags', '--order']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            await knowledge.createCategory(projectId, flags);
            break;
          }
          case 'edit':
          case 'update': {
            const id = getPosArg(resourceArgs);
            const flags: Record<string, string> = {};
            for (const flag of ['--name', '--trigger', '--tags', '--order', '--version']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            if (id) await knowledge.editCategory(projectId, id, flags);
            break;
          }
          case 'delete':
          case 'rm': {
            const id = getPosArg(resourceArgs);
            if (id) await knowledge.deleteCategory(projectId, id);
            break;
          }
          default:
            console.error(chalk.red(`  ✖ Unknown knowledge categories subcommand: ${resourceSub}`));
            printUsage();
        }
      } else {
        switch (resourceSub) {
          case 'list':
          case 'ls': {
            const flags: Record<string, string> = {};
            for (const flag of ['--category']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            await knowledge.listItems(projectId, flags?.category);
            break;
          }
          case 'show':
          case 'get': {
            const id = getPosArg(resourceArgs);
            const flags: Record<string, string> = {};
            for (const flag of ['--category']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            if (id) await knowledge.showItem(projectId, id, flags);
            break;
          }
          case 'create':
          case 'new': {
            const flags: Record<string, string> = {};
            for (const flag of ['--category', '--question', '--answer', '--order']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            await knowledge.createItem(projectId, flags);
            break;
          }
          case 'edit':
          case 'update': {
            const id = getPosArg(resourceArgs);
            const flags: Record<string, string> = {};
            for (const flag of ['--category', '--question', '--answer', '--order', '--version']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            if (id) await knowledge.editItem(projectId, id, flags);
            break;
          }
          case 'delete':
          case 'rm': {
            const id = getPosArg(resourceArgs);
            const flags: Record<string, string> = {};
            for (const flag of ['--category']) {
              const val = getFlag(resourceArgs, flag);
              if (val) flags[flag.replace('--', '')] = val;
            }
            if (id) await knowledge.deleteItem(projectId, id, flags);
            break;
          }
          default:
            console.error(chalk.red(`  ✖ Unknown knowledge items subcommand: ${resourceSub}`));
            printUsage();
        }
      }
      break;
    }

    case 'users': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await users.listUsers(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await users.showUser(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--profile']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await users.createUser(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--profile', '--banned', '--ban-reason']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await users.editUser(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await users.deleteUser(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown users subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'conversations': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      if (subcommand === 'events') {
        const id = getPosArg(restArgs);
        if (id && conversations.listConversationEvents) await conversations.listConversationEvents(projectId, id);
        break;
      }
      if (subcommand === 'event') {
        const convId = restArgs[0];
        const eventId = restArgs[1];
        if (convId && eventId && conversations.showConversationEvent) await conversations.showConversationEvent(projectId, convId, eventId);
        break;
      }
      if (subcommand === 'patch') {
        const id = getPosArg(restArgs);
        const flags: Record<string, string> = {};
        for (const flag of ['--status', '--stage']) {
          const val = getFlag(restArgs, flag);
          if (val) flags[flag.replace('--', '')] = val;
        }
        if (id && conversations.patchConversation) await conversations.patchConversation(projectId, id, flags);
        break;
      }
      await handleResourceCommand('conversations', subcommand, restArgs, {
        list: () => conversations.listConversations(projectId),
        show: (id: string) => conversations.showConversation(projectId, id),
        delete: (id: string) => conversations.deleteConversation(projectId, id),
      } as ResourceCommands);
      break;
    }

    case 'providers': {
      if (!requireAuth()) return;
      const search = getFlag(restArgs, '--search');
      const type = getFlag(restArgs, '--type');
      if (subcommand === 'models') {
        const id = getPosArg(restArgs);
        if (id && providers.listProviderModels) await providers.listProviderModels(id);
        break;
      }
      await handleResourceCommand('providers', subcommand, restArgs, providers as ResourceCommands);
      break;
    }

    case 'environments': {
      if (!requireAuth()) return;
      await handleResourceCommand('environments', subcommand, restArgs, environments as ResourceCommands);
      break;
    }

    case 'api-keys': {
      if (!requireAuth()) return;
      await handleResourceCommand('api-keys', subcommand, restArgs, apiKeys as ResourceCommands);
      break;
    }

    case 'operators': {
      if (!requireAuth()) return;
      switch (subcommand) {
        case 'list':
        case 'ls': await operators.listOperators(); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await operators.showOperator(id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--email', '--password', '--name', '--roles']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await operators.createOperator(flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--roles', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await operators.editOperator(id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await operators.deleteOperator(id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown operators subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'issues': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await issues.listIssues(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await issues.showIssue(id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown issues subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'testers': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await testers.listTesters(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await testers.showTester(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--type']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await testers.createTester(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await testers.editTester(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await testers.deleteTester(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown testers subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'scenarios': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await scenarios.listScenarios(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await scenarios.showScenario(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--description', '--language', '--starting-stage', '--max-turns', '--ending-stages', '--hang-up', '--opener', '--tags']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await scenarios.createScenario(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--description', '--language', '--starting-stage', '--max-turns', '--ending-stages', '--hang-up', '--opener', '--tags', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await scenarios.editScenario(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await scenarios.deleteScenario(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown scenarios subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'scenario-runs': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': {
          const flags: Record<string, string> = {};
          for (const flag of ['--scenario']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await scenarioRuns.listScenarioRuns(projectId, flags?.scenario);
          break;
        }
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await scenarioRuns.showScenarioRun(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown scenario-runs subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'analytics': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'latency': {
          const flags: Record<string, string> = {};
          for (const flag of ['--from', '--to', '--stage', '--source']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await analytics.latencyStats(projectId, flags);
          break;
        }
        case 'percentiles': {
          const flags: Record<string, string> = {};
          for (const flag of ['--from', '--to', '--stage', '--source']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await analytics.latencyPercentiles(projectId, flags);
          break;
        }
        case 'trend': {
          const flags: Record<string, string> = {};
          for (const flag of ['--interval', '--from', '--to', '--stage', '--source']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await analytics.latencyTrend(projectId, flags);
          break;
        }
        case 'timeline': {
          const id = getPosArg(restArgs);
          if (id) await analytics.conversationTimeline(projectId, id);
          break;
        }
        case 'usage': {
          const flags: Record<string, string> = {};
          for (const flag of ['--from', '--to', '--stage', '--source']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await analytics.tokenUsage(projectId, flags);
          break;
        }
        case 'usage-trend': {
          const flags: Record<string, string> = {};
          for (const flag of ['--interval', '--from', '--to', '--stage', '--source']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await analytics.tokenUsageTrend(projectId, flags);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown analytics subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'audit-logs': {
      if (!requireAuth()) return;
      switch (subcommand) {
        case 'list':
        case 'ls': {
          const flags: Record<string, string> = {};
          for (const flag of ['--entity-type', '--action', '--user-id']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await auditLogs.listAuditLogs(flags);
          break;
        }
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await auditLogs.showAuditLog(id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown audit-logs subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'migrations': {
      if (!requireAuth()) return;
      switch (subcommand) {
        case 'preview': {
          const flags: Record<string, string> = {};
          for (const flag of ['--projects', '--stages', '--agents', '--classifiers', '--tools']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await migrations.preview(flags);
          break;
        }
        case 'export': {
          const flags: Record<string, string> = {};
          for (const flag of ['--projects', '--stages', '--agents']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await migrations.exportBundle(flags);
          break;
        }
        case 'pull': {
          const id = getPosArg(restArgs);
          if (!id) { console.error(chalk.red('  ✖ environment-id is required')); break; }
          const flags: Record<string, string> = {};
          for (const flag of ['--dry-run', '--force']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await migrations.pull(id, flags);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown migrations subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'secrets': {
      if (!requireAuth()) return;
      switch (subcommand) {
        case 'list':
        case 'ls': await secrets.listSecrets(); break;
        case 'reveal': {
          const id = getPosArg(restArgs);
          if (id) await secrets.showSecretValue(id);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await secrets.deleteSecret(id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown secrets subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'sample-copies': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await sampleCopies.listSampleCopies(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await sampleCopies.showSampleCopy(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--prompt-trigger', '--prompt_trigger', '--content', '--amount', '--sampling-method', '--sampling_method', '--mode', '--classifier-override-id', '--classifier_override_id', '--decorator-id', '--decorator_id', '--stages', '--agents']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await sampleCopies.createSampleCopy(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--prompt-trigger', '--prompt_trigger', '--content', '--amount', '--sampling-method', '--sampling_method', '--mode', '--classifier-override-id', '--classifier_override_id', '--decorator-id', '--decorator_id', '--stages', '--agents', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await sampleCopies.editSampleCopy(projectId, id, flags);
          break;
        }
        case 'clone': {
          const id = getPosArg(restArgs);
          const newName = restArgs.find(a => !a.startsWith('--') && a !== id);
          const flags: Record<string, string> = {};
          if (newName) flags.name = newName;
          if (id) await sampleCopies.cloneSampleCopy(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await sampleCopies.deleteSampleCopy(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown sample-copies subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'copy-decorators': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await copyDecorators.listCopyDecorators(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await copyDecorators.showCopyDecorator(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--template']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await copyDecorators.createCopyDecorator(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--template', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await copyDecorators.editCopyDecorator(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await copyDecorators.deleteCopyDecorator(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown copy-decorators subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'context-transformers': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await contextTransformers.listContextTransformers(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await contextTransformers.showContextTransformer(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--description', '--prompt', '--llm-provider-id', '--llm_provider_id', '--context-fields', '--context_fields', '--tags']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await contextTransformers.createContextTransformer(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--description', '--prompt', '--llm-provider-id', '--llm_provider_id', '--context-fields', '--context_fields', '--tags', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await contextTransformers.editContextTransformer(projectId, id, flags);
          break;
        }
        case 'clone': {
          const id = getPosArg(restArgs);
          const newName = restArgs.find(a => !a.startsWith('--') && a !== id);
          const flags: Record<string, string> = {};
          if (newName) flags.name = newName;
          if (id) await contextTransformers.cloneContextTransformer(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await contextTransformers.deleteContextTransformer(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown context-transformers subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'saved-slice-queries': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': await savedSliceQueries.listSavedSliceQueries(projectId); break;
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await savedSliceQueries.showSavedSliceQuery(projectId, id);
          break;
        }
        case 'create':
        case 'new': {
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--query', '--shared', '--metadata']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await savedSliceQueries.createSavedSliceQuery(projectId, flags);
          break;
        }
        case 'edit':
        case 'update': {
          const id = getPosArg(restArgs);
          const flags: Record<string, string> = {};
          for (const flag of ['--name', '--query', '--shared', '--metadata', '--version']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          if (id) await savedSliceQueries.editSavedSliceQuery(projectId, id, flags);
          break;
        }
        case 'delete':
        case 'rm': {
          const id = getPosArg(restArgs);
          if (id) await savedSliceQueries.deleteSavedSliceQuery(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown saved-slice-queries subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'scenario-conversations': {
      if (!requireAuth()) return;
      const projectId = getProjectId(restArgs);
      switch (subcommand) {
        case 'list':
        case 'ls': {
          const flags: Record<string, string> = {};
          for (const flag of ['--run-id', '--scenario-run-id']) {
            const val = getFlag(restArgs, flag);
            if (val) flags[flag.replace('--', '')] = val;
          }
          await scenarioConversations.listScenarioConversations(projectId, flags);
          break;
        }
        case 'show':
        case 'get': {
          const id = getPosArg(restArgs);
          if (id) await scenarioConversations.showScenarioConversation(projectId, id);
          break;
        }
        default:
          console.error(chalk.red(`  ✖ Unknown scenario-conversations subcommand: ${subcommand}`));
          printUsage();
      }
      break;
    }

    case 'catalog':
    case 'export':
    case 'import': {
      console.error(chalk.red(`  ✖ Command "${command}" not yet implemented.`));
      break;
    }

    default:
      console.error(chalk.red(`  ✖ Unknown command: ${command}`));
      printUsage();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
