import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { RULES, RULE_MAP, ruleStats } from '../analysis/rules/index.js';
import { MigrationService } from '../core/migration.js';
import { ScanManager } from '../core/orchestrator.js';
import { buildSummary, reportAsCsv, reportAsHtml, reportAsJson, writeScanReport } from '../core/report.js';
import { countIgnoreMatches } from '../core/ignoreRules.js';
import { applyIgnoreRules } from '../core/ignoreApply.js';
import { defaultProjectConfig, discoverFiles, isWithinRoot, resolveProjectPath } from '../core/scanner.js';
import { ValidationService } from '../core/validation.js';
import { newId, sha256 } from '../model/ids.js';
import type { Category, FindingStatus, Language, MigrationLevel, ProjectConfig, Severity } from '../model/types.js';
import { automationHint, automationStatus, recipeForFinding, recipeForRule, ruleSignature } from '../recipes/registry.js';
import { RECIPES } from '../recipes/registry.js';
import { Store } from '../storage/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Adds the automation view to a finding without storing it: whether a recipe exists,
 * whether one is planned, and whether a shipped recipe is blocked for this occurrence.
 */
function withAutomation<T extends { ruleId: string; migrationLevel: string; evidence?: { detail?: Record<string, unknown> } }>(
  finding: T,
) {
  const detail = finding.evidence?.detail ?? {};
  const status = automationStatus(finding.ruleId, detail);
  return {
    ...finding,
    automationCandidate: status === 'PLANNED',
    automationHint: automationHint(finding.ruleId, detail),
    recipeAvailable: status === 'IMPLEMENTED',
    recipeBlocked: status === 'IMPLEMENTED' && finding.migrationLevel === 'MANUAL',
  };
}

export interface ServerContext {
  store: Store;
  scans: ScanManager;
  migrations: MigrationService;
  validation: ValidationService;
  app: express.Express;
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = fn(req, res);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

function normalizeConfig(input: unknown): ProjectConfig {
  const base = defaultProjectConfig();
  const raw = (input ?? {}) as Partial<ProjectConfig>;
  return {
    includeExtensions:
      Array.isArray(raw.includeExtensions) && raw.includeExtensions.length ? raw.includeExtensions : base.includeExtensions,
    excludeDirs: Array.isArray(raw.excludeDirs) ? [...new Set([...base.excludeDirs, ...raw.excludeDirs])] : base.excludeDirs,
    excludeGlobs: Array.isArray(raw.excludeGlobs) ? raw.excludeGlobs : base.excludeGlobs,
    maxFileSizeBytes: Number(raw.maxFileSizeBytes) > 0 ? Number(raw.maxFileSizeBytes) : base.maxFileSizeBytes,
    maxDepth: Number(raw.maxDepth) > 0 ? Number(raw.maxDepth) : base.maxDepth,
    encodingCandidates:
      Array.isArray(raw.encodingCandidates) && raw.encodingCandidates.length ? raw.encodingCandidates : base.encodingCandidates,
    forceEncoding: typeof raw.forceEncoding === 'string' && raw.forceEncoding ? raw.forceEncoding : undefined,
    modules: Array.isArray(raw.modules) && raw.modules.length ? raw.modules : base.modules,
  };
}

function parseIntParam(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function createServer(store: Store): ServerContext {
  const scans = new ScanManager(store);
  const migrations = new MigrationService(store);
  const validation = new ValidationService(store);
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // The Vite dev server runs on another port; allow it without opening the API to the world.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  /* ------------------------------- meta ------------------------------- */

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: '0.1.0', rules: RULES.length, recipes: RECIPES.length });
  });

  app.get('/api/meta', (_req, res) => {
    res.json({
      version: '0.1.0',
      ruleStats: ruleStats(),
      categories: ['JS_API', 'DOM_API', 'HTML_COMPAT', 'CSS_COMPAT', 'ACTIVEX_VBSCRIPT', 'BROWSER_BEHAVIOR', 'DYNAMIC_CODE'],
      severities: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'],
      migrationLevels: ['SAFE', 'CONDITIONAL', 'MANUAL', 'UNSUPPORTED'],
      statuses: ['DETECTED', 'READY_FOR_MIGRATION', 'MIGRATED', 'REVIEW_REQUIRED', 'VALIDATED', 'VALIDATION_FAILED', 'IGNORED'],
      languages: ['javascript', 'html', 'css', 'jsp'],
      defaultEncodings: defaultProjectConfig().encodingCandidates,
    });
  });

  /* ------------------------------- projects ------------------------------- */

  app.get('/api/projects', (_req, res) => {
    const projects = store.listProjects().map((project) => {
      const scansForProject = store.listScans(project.id, 1);
      return { ...project, lastScan: scansForProject[0] ?? null };
    });
    res.json({ items: projects });
  });

  app.post(
    '/api/projects',
    asyncHandler((req, res) => {
      const body = req.body as { name?: string; rootPath?: string; config?: unknown };
      if (!body.name || !body.name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      if (!body.rootPath) {
        res.status(400).json({ error: 'rootPath is required' });
        return;
      }
      const rootPath = resolve(body.rootPath);
      if (!existsSync(rootPath)) {
        res.status(400).json({ error: `rootPath does not exist: ${rootPath}` });
        return;
      }
      if (!statSync(rootPath).isDirectory()) {
        res.status(400).json({ error: `rootPath is not a directory: ${rootPath}` });
        return;
      }
      const project = store.createProject(body.name.trim(), rootPath, normalizeConfig(body.config));
      res.status(201).json(project);
    }),
  );

  app.get('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json({ ...project, scans: store.listScans(project.id, 50) });
  });

  app.patch(
    '/api/projects/:id',
    asyncHandler((req, res) => {
      const patch = req.body as { name?: string; rootPath?: string; config?: unknown };
      const next: { name?: string; rootPath?: string; config?: ProjectConfig } = {};
      if (patch.name) next.name = patch.name.trim();
      if (patch.rootPath) {
        const rootPath = resolve(patch.rootPath);
        if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
          res.status(400).json({ error: 'rootPath must be an existing directory' });
          return;
        }
        next.rootPath = rootPath;
      }
      if (patch.config) next.config = normalizeConfig(patch.config);
      const updated = store.updateProject(req.params.id, next);
      if (!updated) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      res.json(updated);
    }),
  );

  app.delete('/api/projects/:id', (req, res) => {
    const deleted = store.deleteProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    // Only the database record is removed. Source files are never touched.
    res.json({ deleted: true, note: 'Project record removed; source files were not modified.' });
  });

  /* ------------------------------- ignore rules ------------------------------- */

  app.get('/api/projects/:id/ignore-rules', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json({ items: store.listIgnoreRules(project.id) });
  });

  app.post('/api/projects/:id/ignore-rules', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const body = (req.body ?? {}) as { ruleId?: string | null; pathPattern?: string | null; reason?: string; enabled?: boolean };
    const reason = (body.reason ?? '').trim();
    if (!reason) {
      res.status(400).json({ error: 'reason is required: an accepted risk must say why it is accepted' });
      return;
    }
    const ruleId = body.ruleId?.trim() || null;
    if (ruleId && !RULE_MAP.has(ruleId)) {
      res.status(400).json({ error: `unknown rule: ${ruleId}` });
      return;
    }
    const pathPattern = body.pathPattern?.trim() || null;
    if (pathPattern) {
      if (pathPattern.startsWith('/') || pathPattern.split('/').includes('..')) {
        res.status(400).json({ error: 'pathPattern must be relative to the project root and must not contain ".." ' });
        return;
      }
      if (pathPattern.length > 200) {
        res.status(400).json({ error: 'pathPattern is too long' });
        return;
      }
    }
    const rule = store.createIgnoreRule({
      projectId: project.id,
      ruleId,
      pathPattern,
      reason,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      createdBy: 'user',
    });
    res.status(201).json(rule);
  });

  /**
   * How many findings of an existing scan would this rule silence?
   * Used by both the project form and the finding dialog, before anything is saved.
   */
  app.post('/api/projects/:id/ignore-rules/preview', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const body = (req.body ?? {}) as { ruleId?: string | null; pathPattern?: string | null; scanTaskId?: string };
    const ruleId = body.ruleId?.trim() || null;
    if (ruleId && !RULE_MAP.has(ruleId)) {
      res.status(400).json({ error: `unknown rule: ${ruleId}` });
      return;
    }
    const pathPattern = body.pathPattern?.trim() || null;

    const scans = store.listScans(project.id, 20);
    const scan = body.scanTaskId
      ? scans.find((item) => item.id === body.scanTaskId)
      : (scans.find((item) => item.status === 'COMPLETED') ?? scans[0]);
    if (!scan) {
      res.json({ scanTaskId: null, matched: 0, alreadyIgnored: 0, newlyIgnored: 0, byRule: [] });
      return;
    }

    const impact = countIgnoreMatches(store.listAllFindings(scan.id), {
      ruleId,
      pathPattern,
      enabled: true,
    });
    res.json({ scanTaskId: scan.id, ...impact });
  });

  /** Re-evaluate the stored findings of one scan against the current rules. */
  app.post('/api/projects/:id/ignore-rules/apply', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const body = (req.body ?? {}) as { scanTaskId?: string };
    const scans = store.listScans(project.id, 20);
    const scan = body.scanTaskId
      ? scans.find((item) => item.id === body.scanTaskId)
      : (scans.find((item) => item.status === 'COMPLETED') ?? scans[0]);
    if (!scan) {
      res.status(409).json({ error: 'this project has no scan to apply rules to' });
      return;
    }
    res.json(applyIgnoreRules(store, scan.id));
  });

  app.patch('/api/ignore-rules/:ruleId', (req, res) => {
    const enabled = Boolean((req.body as { enabled?: boolean }).enabled);
    const updated = store.setIgnoreRuleEnabled(req.params.ruleId, enabled);
    if (!updated) {
      res.status(404).json({ error: 'ignore rule not found' });
      return;
    }
    res.json({ id: req.params.ruleId, enabled });
  });

  app.delete('/api/ignore-rules/:ruleId', (req, res) => {
    const deleted = store.deleteIgnoreRule(req.params.ruleId);
    if (!deleted) {
      res.status(404).json({ error: 'ignore rule not found' });
      return;
    }
    res.json({ deleted: true });
  });

  /* ------------------------------- scans ------------------------------- */

  app.post(
    '/api/projects/:id/scans',
    asyncHandler((req, res) => {
      const project = store.getProject(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      if (!existsSync(project.rootPath)) {
        res.status(400).json({ error: `project root is missing on disk: ${project.rootPath}` });
        return;
      }
      const body = req.body as { config?: unknown };
      const config = body?.config ? normalizeConfig(body.config) : normalizeConfig(project.config);
      const scan = store.createScan(project, config, ruleSignature());
      scans.start(scan.id);
      res.status(202).json(scan);
    }),
  );

  app.get('/api/scans', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({ items: store.listScans(projectId, parseIntParam(req.query.limit, 100)) });
  });

  app.get('/api/scans/:id', (req, res) => {
    const scan = store.getScan(req.params.id);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    res.json(scan);
  });

  app.get('/api/scans/:id/summary', (req, res) => {
    const scan = store.getScan(req.params.id);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    res.json(buildSummary(store, scan.id));
  });

  app.get('/api/scans/:id/logs', (req, res) => {
    res.json({ items: store.getScanLog(req.params.id) });
  });

  app.post('/api/scans/:id/cancel', (req, res) => {
    const cancelled = scans.cancel(req.params.id);
    res.json({ cancelled });
  });

  app.get('/api/scans/:id/events', (req, res) => {
    const scanId = req.params.id;
    const scan = store.getScan(scanId);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({
      scanId,
      type: 'status',
      at: new Date().toISOString(),
      status: scan.status,
      phase: scan.phase,
      progress: {
        scannedFiles: scan.scannedFileCount,
        totalFiles: scan.scannedFileCount,
        parsedFiles: scan.parsedFileCount,
        failedFiles: scan.failedFileCount,
        findings: scan.findingCount,
        currentFile: scan.currentFile,
      },
    });
    const unsubscribe = scans.subscribe(scanId, send);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  /* ------------------------------- scan artifacts ------------------------------- */

  app.get('/api/scans/:id/files', (req, res) => {
    res.json({ items: store.listScanFiles(req.params.id) });
  });

  app.get(
    '/api/scans/:id/files/source',
    asyncHandler((req, res) => {
      const scan = store.getScan(req.params.id);
      if (!scan) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      const relPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!relPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const known = store.getScanFile(scan.id, relPath);
      if (!known) {
        res.status(403).json({ error: 'file is not part of this scan' });
        return;
      }
      const absPath = resolveProjectPath(scan.rootPath, relPath);
      if (!absPath || !isWithinRoot(scan.rootPath, absPath) || !existsSync(absPath)) {
        res.status(404).json({ error: 'file is no longer available on disk' });
        return;
      }
      const buffer = readFileSync(absPath);
      if (buffer.length > 4 * 1024 * 1024) {
        res.status(413).json({ error: 'file exceeds the 4 MB viewer limit' });
        return;
      }
      const text = buffer.toString('utf8');
      res.json({
        path: relPath,
        language: known.language,
        content: text,
        hash: sha256(buffer),
        scannedHash: known.hash,
        stale: sha256(buffer) !== known.hash,
        encoding: known.encoding,
        parseStatus: known.parseStatus,
      });
    }),
  );

  app.get('/api/scans/:id/findings', (req, res) => {
    const scan = store.getScan(req.params.id);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    const result = store.listFindings(scan.id, {
      category: req.query.category as Category | undefined,
      severity: req.query.severity as Severity | undefined,
      migrationLevel: req.query.migrationLevel as MigrationLevel | undefined,
      status: req.query.status as FindingStatus | undefined,
      ruleId: typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined,
      language: req.query.language as Language | undefined,
      pathContains: typeof req.query.path === 'string' ? req.query.path : undefined,
      modulePath: typeof req.query.module === 'string' ? req.query.module : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      sort: (req.query.sort as 'risk' | 'path' | 'type' | 'priority' | undefined) ?? 'risk',
      limit: parseIntParam(req.query.limit, 200),
      offset: parseIntParam(req.query.offset, 0),
    });
    res.json({ total: result.total, items: result.items.map(withAutomation) });
  });

  app.get('/api/scans/:id/relations', (req, res) => {
    const scan = store.getScan(req.params.id);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    res.json({ items: store.listRelations(scan.id) });
  });

  app.get('/api/scans/:id/report', (req, res) => {
    const scan = store.getScan(req.params.id);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    const format = String(req.query.format ?? 'json').toLowerCase();
    const base = `weblift-${scan.projectName.replace(/[^a-z0-9_-]+/gi, '-')}-${scan.id}`;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.send(reportAsCsv(store, scan.id));
      return;
    }
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(reportAsHtml(store, scan.id));
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    res.send(reportAsJson(store, scan.id));
  });

  app.post('/api/scans/:id/report', (req, res) => {
    const scan = store.getScan(req.params.id);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    const path = writeScanReport(store, scan.id);
    const record = store.insertReport(scan.id, 'json', path);
    res.status(201).json({ ...record, path });
  });

  /* ------------------------------- findings ------------------------------- */

  app.get('/api/findings/:id', (req, res) => {
    const finding = store.getFinding(req.params.id);
    if (!finding) {
      res.status(404).json({ error: 'finding not found' });
      return;
    }
    const rule = RULE_MAP.get(finding.ruleId);
    const recipe = recipeForFinding(finding);
    const scan = store.getScan(finding.scanTaskId);
    res.json({
      finding: withAutomation(finding),
      // The UI creates project-level ignore rules from here, so it needs the owner.
      projectId: scan?.projectId ?? null,
      projectName: scan?.projectName ?? null,
      rule: rule?.meta ?? null,
      recipe: recipe
        ? { id: recipe.id, name: recipe.name, level: recipe.level, summary: recipe.summary, caveats: recipe.caveats }
        : null,
      history: store.getFindingHistory(finding.id),
    });
  });

  app.get('/api/findings/:id/source', (req, res) => {
    const finding = store.getFinding(req.params.id);
    if (!finding) {
      res.status(404).json({ error: 'finding not found' });
      return;
    }
    const scan = store.getScan(finding.scanTaskId);
    if (!scan) {
      res.status(404).json({ error: 'scan not found' });
      return;
    }
    const absPath = resolveProjectPath(scan.rootPath, finding.filePath);
    if (!absPath || !existsSync(absPath)) {
      res.status(404).json({ error: 'source file is no longer available' });
      return;
    }
    const buffer = readFileSync(absPath);
    const known = store.getScanFile(scan.id, finding.filePath);
    res.json({
      path: finding.filePath,
      language: finding.language,
      content: buffer.toString('utf8'),
      stale: known ? known.hash !== sha256(buffer) : true,
      finding,
    });
  });

  app.post('/api/findings/:id/status', (req, res) => {
    const body = req.body as { status?: FindingStatus; note?: string };
    const statuses: FindingStatus[] = [
      'DETECTED',
      'READY_FOR_MIGRATION',
      'MIGRATED',
      'REVIEW_REQUIRED',
      'VALIDATED',
      'VALIDATION_FAILED',
      'IGNORED',
    ];
    if (!body.status || !statuses.includes(body.status)) {
      res.status(400).json({ error: `status must be one of ${statuses.join(', ')}` });
      return;
    }
    if (body.status === 'IGNORED' && (!body.note || !body.note.trim())) {
      res.status(400).json({ error: 'Ignoring a finding requires a reason in note' });
      return;
    }
    const updated = store.updateFindingStatus(req.params.id, body.status, 'user', body.note?.trim() ?? null);
    if (!updated) {
      res.status(404).json({ error: 'finding not found' });
      return;
    }
    res.json(updated);
  });

  app.get('/api/findings/:id/history', (req, res) => {
    res.json({ items: store.getFindingHistory(req.params.id) });
  });

  /* ------------------------------- rules ------------------------------- */

  app.get('/api/rules', (_req, res) => {
    const states = store.listRuleStates();
    const items = RULES.map((rule) => ({
      ...rule.meta,
      enabled: states.get(rule.meta.id) ?? true,
      implemented: Boolean(rule.meta.recipeId),
    }));
    res.json({ items, total: items.length });
  });

  app.get('/api/rules/:id', (req, res) => {
    const rule = RULE_MAP.get(req.params.id);
    if (!rule) {
      res.status(404).json({ error: 'rule not found' });
      return;
    }
    const states = store.listRuleStates();
    const recipe = rule.meta.recipeId ? RECIPES.find((item) => item.id === rule.meta.recipeId) : null;
    res.json({
      rule: { ...rule.meta, enabled: states.get(rule.meta.id) ?? true },
      recipe: recipe ? { id: recipe.id, name: recipe.name, level: recipe.level, summary: recipe.summary, caveats: recipe.caveats } : null,
    });
  });

  app.post('/api/rules/:id/state', (req, res) => {
    const rule = RULE_MAP.get(req.params.id);
    if (!rule) {
      res.status(404).json({ error: 'rule not found' });
      return;
    }
    const enabled = Boolean((req.body as { enabled?: boolean }).enabled);
    store.setRuleEnabled(rule.meta.id, enabled);
    res.json({ id: rule.meta.id, enabled });
  });

  /* ------------------------------- migrations ------------------------------- */

  app.post(
    '/api/migrations/preview',
    asyncHandler((req, res) => {
      const body = req.body as { scanTaskId?: string; findingIds?: string[] };
      if (!body.scanTaskId || !Array.isArray(body.findingIds) || body.findingIds.length === 0) {
        res.status(400).json({ error: 'scanTaskId and a non-empty findingIds array are required' });
        return;
      }
      const plan = migrations.preview({ scanTaskId: body.scanTaskId, findingIds: body.findingIds });
      res.json(plan);
    }),
  );

  app.post(
    '/api/migrations/execute',
    asyncHandler(async (req, res) => {
      const body = req.body as {
        scanTaskId?: string;
        findingIds?: string[];
        visual?: { pages?: Array<{ pageKey?: string; url?: string }>; maskSelectors?: string[] };
      };
      if (!body.scanTaskId || !Array.isArray(body.findingIds) || body.findingIds.length === 0) {
        res.status(400).json({ error: 'scanTaskId and a non-empty findingIds array are required' });
        return;
      }

      // Optional before/after screenshots. Only http(s) pages are accepted, and a page
      // that fails to capture is reported per page instead of blocking the migration.
      const pages = (body.visual?.pages ?? [])
        .filter((page) => typeof page.url === 'string' && /^https?:\/\//i.test(page.url))
        .slice(0, 5)
        .map((page, index) => ({ pageKey: page.pageKey?.trim() || `page-${index + 1}`, url: page.url as string }));
      const maskSelectors = (body.visual?.maskSelectors ?? []).map((selector) => selector.trim()).filter(Boolean);

      const result = await migrations.execute(
        body.scanTaskId,
        body.findingIds,
        pages.length > 0 ? { visual: { pages, capture: (url: string) => validation.captureScreenshot(url, 1280, 900, maskSelectors) } } : {},
      );
      res.status(result.ok ? 200 : 207).json(result);
    }),
  );

  app.post('/api/migrations/:id/rollback', (req, res) => {
    // Rolling back a single row of a batch restores the whole file, so the response
    // reports how many findings were reverted.
    const result = migrations.rollback(req.params.id);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/migrations/batch/:batchId/rollback', (req, res) => {
    const result = migrations.rollbackBatch(req.params.batchId);
    res.status(result.ok ? 200 : 409).json(result);
  });

  // A session is one execute() call, so this reverts every file that call touched.
  app.post('/api/migrations/session/:sessionId/rollback', (req, res) => {
    const result = migrations.rollbackSession(req.params.sessionId);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/migrations', (req, res) => {
    const scanTaskId = typeof req.query.scanTaskId === 'string' ? req.query.scanTaskId : undefined;
    res.json({ items: store.listMigrations(scanTaskId, parseIntParam(req.query.limit, 200)) });
  });

  /* ------------------------------- validation ------------------------------- */

  app.post(
    '/api/scans/:id/validation/static',
    asyncHandler((req, res) => {
      const scan = store.getScan(req.params.id);
      if (!scan) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      const body = (req.body ?? {}) as { filePaths?: string[] };
      const report = validation.validateStatic(scan.id, Array.isArray(body.filePaths) ? body.filePaths : undefined);
      res.json(report);
    }),
  );

  app.post(
    '/api/scans/:id/validation/browser',
    asyncHandler(async (req, res) => {
      const scan = store.getScan(req.params.id);
      if (!scan) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      const body = (req.body ?? {}) as { url?: string; timeoutMs?: number };
      if (!body.url || !/^https?:\/\//i.test(body.url)) {
        res.status(400).json({ error: 'url must be an absolute http(s) URL' });
        return;
      }
      const report = await validation.validateBrowser({ scanTaskId: scan.id, url: body.url, timeoutMs: body.timeoutMs });
      res.json(report);
    }),
  );

  app.post(
    '/api/scans/:id/validation/visual',
    asyncHandler(async (req, res) => {
      const scan = store.getScan(req.params.id);
      if (!scan) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        url?: string;
        pageKey?: string;
        updateBaseline?: boolean;
        width?: number;
        height?: number;
      };
      if (!body.url || !/^https?:\/\//i.test(body.url)) {
        res.status(400).json({ error: 'url must be an absolute http(s) URL' });
        return;
      }
      const result = await validation.validateVisual({
        scanTaskId: scan.id,
        url: body.url,
        pageKey: body.pageKey?.trim() || 'page',
        updateBaseline: Boolean(body.updateBaseline),
        width: Number(body.width) > 0 ? Number(body.width) : undefined,
        height: Number(body.height) > 0 ? Number(body.height) : undefined,
      });
      res.json(result);
    }),
  );

  app.post(
    '/api/scans/:id/validation/visual/matrix',
    asyncHandler(async (req, res) => {
      const scan = store.getScan(req.params.id);
      if (!scan) {
        res.status(404).json({ error: 'scan not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        url?: string;
        pageKey?: string;
        updateBaseline?: boolean;
        maskSelectors?: string[];
        viewports?: Array<{ name?: string; width?: number; height?: number }>;
      };
      if (!body.url || !/^https?:\/\//i.test(body.url)) {
        res.status(400).json({ error: 'url must be an absolute http(s) URL' });
        return;
      }
      const viewports = (body.viewports ?? [])
        .filter((item) => Number(item.width) > 0 && Number(item.height) > 0)
        .slice(0, 4)
        .map((item, index) => ({
          name: (item.name ?? `vp${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-'),
          width: Math.min(Number(item.width), 3840),
          height: Math.min(Number(item.height), 2160),
        }));
      const maskSelectors = (body.maskSelectors ?? [])
        .map((selector) => selector.trim())
        .filter(Boolean)
        .slice(0, 20);

      const result = await validation.validateVisualMatrix({
        scanTaskId: scan.id,
        url: body.url,
        pageKey: body.pageKey?.trim() || 'page',
        updateBaseline: Boolean(body.updateBaseline),
        maskSelectors,
        viewports: viewports.length > 0 ? viewports : undefined,
      });
      res.json(result);
    }),
  );

  app.get('/api/projects/:id/visual-baselines', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    // Paths are not exposed: baselines are identified by id and served inline.
    res.json({
      items: store.listVisualBaselines(project.id).map((baseline) => ({
        id: baseline.id,
        pageKey: baseline.pageKey,
        url: baseline.url,
        width: baseline.width,
        height: baseline.height,
        createdAt: baseline.createdAt,
      })),
    });
  });

  /* ------------------------------- static UI ------------------------------- */

  const uiDir = resolve(__dirname, '../../../web/dist');
  if (existsSync(uiDir)) {
    app.use(express.static(uiDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(uiDir, 'index.html'));
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[weblift] request failed:', err.message);
    res.status(500).json({ error: err.message });
  });

  return { store, scans, migrations, validation, app };
}

export function startServer(options: { port?: number; dataDir?: string } = {}): { server: ReturnType<express.Express['listen']>; context: ServerContext } {
  const store = new Store({ dataDir: options.dataDir });
  const context = createServer(store);
  const port = options.port ?? Number(process.env.WEBLIFT_PORT ?? 8787);
  const server = context.app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[weblift] API listening on http://localhost:${port}`);
  });
  return { server, context };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  startServer();
}
