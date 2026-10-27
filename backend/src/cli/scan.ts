import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScanManager } from '../core/orchestrator.js';
import { buildSummary, reportsDir } from '../core/report.js';
import { defaultProjectConfig } from '../core/scanner.js';
import { Store } from '../storage/store.js';
import type { ScanStatus } from '../model/types.js';

interface Args {
  project?: string;
  name?: string;
  dataDir?: string;
  json?: boolean;
  config?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') args.project = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--data-dir') args.dataDir = argv[++i];
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

const TERMINAL: ScanStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error('Usage: weblift scan --project <path> [--name <project name>] [--data-dir <dir>] [--config <json file>] [--json]');
    process.exitCode = 2;
    return;
  }
  const rootPath = resolve(args.project);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    console.error(`Not a directory: ${rootPath}`);
    process.exitCode = 2;
    return;
  }

  const store = new Store({ dataDir: args.dataDir });
  const scans = new ScanManager(store);

  let config = defaultProjectConfig();
  if (args.config) {
    const raw = JSON.parse(readFileSync(args.config, 'utf8')) as Partial<typeof config>;
    config = { ...config, ...raw };
  }

  const project = store.createProject(args.name ?? rootPath.split('/').pop() ?? 'project', rootPath, config);
  const scan = store.createScan(project, config);
  scans.start(scan.id);

  const started = Date.now();
  let lastLine = '';
  while (true) {
    const current = store.getScan(scan.id);
    if (!current) break;
    const line = `[${current.phase ?? current.status}] ${current.scannedFileCount} files · ${current.findingCount} findings`;
    if (!args.json && line !== lastLine) {
      process.stdout.write(`\r${line.padEnd(80)}`);
      lastLine = line;
    }
    if (TERMINAL.includes(current.status)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  const finished = store.getScan(scan.id);
  const summary = buildSummary(store, scan.id);
  if (args.json) {
    console.log(JSON.stringify({ scan: finished, summary, report: `${reportsDir()}/${scan.id}.json` }, null, 2));
  } else {
    process.stdout.write('\n');
    console.log(`Scan ${scan.id} finished with status ${finished?.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`Files: ${summary.totals.files} | Findings: ${summary.totals.findings} | High risk: ${summary.totals.highRisk}`);
    console.log(`Auto convertible: ${summary.totals.autoConvertible} | Manual: ${summary.totals.manual} | Unsupported: ${summary.totals.unsupported}`);
    console.log(`Report: ${reportsDir()}/${scan.id}.json`);
  }
  store.close();
}

void main();
