import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { ProjectConfig } from '../model/types.js';
import { LANGUAGE_BY_EXTENSION } from '../model/types.js';
import { DEFAULT_ENCODINGS } from './textDecode.js';

export const DEFAULT_EXCLUDED_DIRS = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.idea',
  '.vscode',
  '.weblift',
  '__pycache__',
];

export const DEFAULT_INCLUDED_EXTENSIONS = ['.js', '.html', '.htm', '.jsp', '.jspf', '.css', '.xhtml'];

export interface SkippedEntry {
  path: string;
  reason: 'SYMLINK_ESCAPE' | 'TOO_LARGE' | 'BINARY' | 'UNSUPPORTED_EXTENSION' | 'UNREADABLE' | 'NOT_A_FILE';
  detail?: string;
}

export interface DiscoveredFile {
  /** POSIX path relative to the project root */
  relPath: string;
  absolutePath: string;
  size: number;
  extension: string;
}

export interface DiscoveryResult {
  rootPath: string;
  files: DiscoveredFile[];
  skipped: SkippedEntry[];
  /** Directories that were skipped, with the reason */
  skippedDirs: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    includeExtensions: [...DEFAULT_INCLUDED_EXTENSIONS],
    excludeDirs: [...DEFAULT_EXCLUDED_DIRS],
    excludeGlobs: [],
    maxFileSizeBytes: 2 * 1024 * 1024,
    maxDepth: 32,
    encodingCandidates: [...DEFAULT_ENCODINGS],
    modules: [{ name: 'root', path: '.' }],
  };
}

/** Rejects paths that resolve outside the project root (traversal, absolute escapes). */
export function isWithinRoot(rootPath: string, candidate: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(candidate);
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function resolveProjectPath(rootPath: string, relPath: string): string | null {
  const normalizedRoot = resolve(rootPath);
  const target = resolve(normalizedRoot, relPath);
  if (!isWithinRoot(normalizedRoot, target)) return null;
  return target;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isProbablyBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function discoverFiles(rootPath: string, config: ProjectConfig): DiscoveryResult {
  const warnings: string[] = [];
  const skipped: SkippedEntry[] = [];
  const skippedDirs: Array<{ path: string; reason: string }> = [];
  const files: DiscoveredFile[] = [];

  const root = resolve(rootPath);
  if (!existsSync(root)) {
    return { rootPath: root, files, skipped, skippedDirs, warnings: [`Project root does not exist: ${root}`] };
  }
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    return { rootPath: root, files, skipped, skippedDirs, warnings: [`Project root is not a directory: ${root}`] };
  }

  const realRoot = realpathSync(root);
  const includeExt = new Set(config.includeExtensions.map((ext) => ext.toLowerCase()));
  const excludeDirs = new Set(config.excludeDirs.map((dir) => dir.toLowerCase()));
  const maxDepth = config.maxDepth || 32;
  let realRootResolved: string | null = null;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      skippedDirs.push({ path: toPosix(relative(root, dir)) || '.', reason: 'MAX_DEPTH_EXCEEDED' });
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Cannot read directory ${dir}: ${(err as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));

      if (entry.isSymbolicLink()) {
        // Symlinks are never followed: they are the classic way a scan escapes its root.
        let targetReal: string;
        try {
          targetReal = realpathSync(abs);
        } catch {
          skipped.push({ path: rel, reason: 'SYMLINK_ESCAPE', detail: 'broken symlink' });
          continue;
        }
        realRootResolved = realRootResolved ?? realpathSync(root);
        if (!targetReal.startsWith(realRootResolved)) {
          skipped.push({ path: rel, reason: 'SYMLINK_ESCAPE', detail: targetReal });
          continue;
        }
        skipped.push({ path: rel, reason: 'SYMLINK_ESCAPE', detail: 'symlink inside root, skipped to keep the scan deterministic' });
        continue;
      }

      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name.toLowerCase())) {
          skippedDirs.push({ path: rel, reason: 'EXCLUDED_DIR' });
          continue;
        }
        walk(abs, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        skipped.push({ path: rel, reason: 'NOT_A_FILE' });
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (!includeExt.has(ext) || !LANGUAGE_BY_EXTENSION[ext]) {
        continue;
      }

      let size = 0;
      try {
        size = lstatSync(abs).size;
      } catch {
        skipped.push({ path: rel, reason: 'UNREADABLE' });
        continue;
      }
      if (size > config.maxFileSizeBytes) {
        skipped.push({
          path: rel,
          reason: 'TOO_LARGE',
          detail: `${size} bytes > ${config.maxFileSizeBytes} bytes limit`,
        });
        continue;
      }
      if (size === 0) continue;

      files.push({ relPath: rel, absolutePath: abs, size, extension: ext });
    }
  };

  walk(root, 0);

  // Binary check needs a read; keep it separate so directory walking stays cheap.
  const textFiles: DiscoveredFile[] = [];
  for (const file of files) {
    try {
      const head = readFileHead(file.absolutePath, 8192);
      if (isProbablyBinary(head)) {
        skipped.push({ path: file.relPath, reason: 'BINARY' });
        continue;
      }
      textFiles.push(file);
    } catch (err) {
      skipped.push({ path: file.relPath, reason: 'UNREADABLE', detail: (err as Error).message });
    }
  }

  files.length = 0;
  files.push(...textFiles);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { rootPath: root, files, skipped, skippedDirs, warnings };
}

function readFileHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export function modulePathOf(relPath: string, config: ProjectConfig): string {
  const modules = [...config.modules].sort((a, b) => b.path.length - a.path.length);
  for (const module of modules) {
    if (module.path === '.' || module.path === '') return module.name;
    const prefix = module.path.replace(/\/$/, '');
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return module.name;
  }
  return config.modules[0]?.name ?? 'root';
}
