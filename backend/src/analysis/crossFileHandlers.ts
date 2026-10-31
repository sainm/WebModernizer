import { extname } from 'node:path';
import type { AnalysisFinding, Language } from '../model/types.js';
import { LANGUAGE_BY_EXTENSION } from '../model/types.js';
import { newId, nowIso } from '../model/ids.js';
import type { FileRefFacts } from './projectReferences.js';
import type { HandlerRegistrationFact, InlineHandlerCallFact } from './handlers.js';
import { getRule } from './rules/index.js';

export interface CrossFileHandlerFile {
  path: string;
  facts: FileRefFacts;
}

export interface CrossFileHandlerResult {
  findings: AnalysisFinding[];
  suppressed: Array<{ filePath: string; starts: number[] }>;
  superseded: Array<{ filePath: string; handlerStart: number }>;
}

interface RegistrationUse {
  filePath: string;
  registration: HandlerRegistrationFact;
}

interface InlineCallUse {
  filePath: string;
  call: InlineHandlerCallFact;
}

function languageOf(path: string): Language {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? 'javascript';
}

export function buildCrossFileHandlerFindings(
  files: CrossFileHandlerFile[],
  scanTaskId: string,
): CrossFileHandlerResult {
  const rule = getRule('WL-JS-017');
  if (!rule) return { findings: [], suppressed: [], superseded: [] };

  const directCalls = new Set<string>();
  for (const file of files) {
    for (const name of file.facts.directCalls ?? []) directCalls.add(name);
  }

  const registrationsByName = new Map<string, RegistrationUse[]>();
  for (const file of files) {
    for (const registration of file.facts.registrations ?? []) {
      const list = registrationsByName.get(registration.name) ?? [];
      list.push({ filePath: file.path, registration });
      registrationsByName.set(registration.name, list);
    }
  }

  const inlineCallsByName = new Map<string, InlineCallUse[]>();
  for (const file of files) {
    for (const call of file.facts.inlineCalls ?? []) {
      const list = inlineCallsByName.get(call.name) ?? [];
      list.push({ filePath: file.path, call });
      inlineCallsByName.set(call.name, list);
    }
  }

  const findings: AnalysisFinding[] = [];
  const suppressed: Array<{ filePath: string; starts: number[] }> = [];
  const superseded: Array<{ filePath: string; handlerStart: number }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.js')) continue;
    for (const handler of file.facts.handlers ?? []) {
      if (handler.otherUses) continue;
      if (directCalls.has(handler.name)) continue;

      const registrations = registrationsByName.get(handler.name) ?? [];
      if (handler.paramCount > 0 && registrations.length > 0) continue;
      const crossFileRegistrations = registrations.filter((use) => use.filePath !== file.path);
      const inlineCalls = inlineCallsByName.get(handler.name) ?? [];
      if (crossFileRegistrations.length === 0 && inlineCalls.length === 0) continue;

      const key = `${file.path}|${handler.start}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const registrationFiles = [...new Set(crossFileRegistrations.map((use) => use.filePath))];
      const inlineCallFiles = [...new Set(inlineCalls.map((use) => use.filePath))];
      const level = rule.meta.defaultMigrationLevel;
      const definition: AnalysisFinding = {
        id: newId('fnd'),
        scanTaskId,
        ruleId: rule.meta.id,
        ruleVersion: rule.meta.version,
        filePath: file.path,
        language: 'javascript',
        startLine: handler.startLine,
        endLine: handler.endLine,
        startColumn: handler.startColumn,
        endColumn: handler.endColumn,
        startOffset: handler.start,
        endOffset: handler.signatureEnd,
        category: rule.meta.category,
        severity: rule.meta.defaultSeverity,
        migrationLevel: level,
        confidence: 'CONFIRMED',
        message:
          inlineCalls.length > 0
            ? `IE event handler ${handler.name} is called from ${inlineCalls.length} inline handler(s) and uses window.event`
            : `IE event handler ${handler.name} is registered in ${registrationFiles.join(', ')} and uses window.event ` +
              `(${handler.windowEventCount} reference${handler.windowEventCount === 1 ? '' : 's'})`,
        messageKey: inlineCalls.length > 0 ? 'rules.WL-JS-017.inlineCalls' : 'rules.WL-JS-017.crossFile',
        messageParams: {
          handler: handler.name,
          registrationFile: registrationFiles[0] ?? '',
          registrationFiles: registrationFiles.join(', '),
          registrationCount: crossFileRegistrations.length,
          inlineCallFiles: inlineCallFiles.join(', '),
          inlineCallCount: inlineCalls.length,
          windowEventCount: handler.windowEventCount,
        },
        risk:
          inlineCalls.length > 0
            ? 'The function is defined here and called from inline on* handlers in other files. Those callers have the standard event object in scope, but the function reads the IE-only window.event, so it throws when the event fires. The definition and every caller must change together.'
            : 'The function is defined here and registered as a handler by reference in another file. Chrome passes the event object as the first handler argument, but the function still reads the IE-only window.event global, so it throws when the event fires. The registration site does not need an edit for a by-reference registration, but the function signature does.',
        recommendation:
          inlineCalls.length > 0
            ? 'Migrate the whole companion group: inject the event parameter and replace window.event in this function, and pass event from every inline call site. The preview verifies that each call-site file still has its scan-time hash. Rescan afterwards to migrate the dependent srcElement/returnValue/cancelBubble findings.'
            : 'Migrate this finding to add the event parameter and replace every window.event reference in the function. The registration file must stay unchanged and must not call the function directly; the preview verifies its hash. Rescan afterwards to migrate the dependent srcElement/returnValue/cancelBubble findings.',
        evidence: {
          kind: 'Function',
          matched: handler.snippet,
          container: handler.container,
          detail: {
            handler: handler.name,
            registrationFile: registrationFiles[0] ?? '',
            registrationFiles: registrationFiles.join(', '),
            registrationCount: crossFileRegistrations.length,
            inlineCallFiles: inlineCallFiles.join(', '),
            inlineCallCount: inlineCalls.length,
            windowEventCount: handler.windowEventCount,
            paramCount: handler.paramCount,
            handlerStart: handler.start,
            handlerEnd: handler.end,
            inlineInDefinitionFile: false,
            crossFile: true,
          },
        },
        snippet: handler.snippet,
        status: level === 'SAFE' || level === 'CONDITIONAL' ? 'READY_FOR_MIGRATION' : 'DETECTED',
        statusUpdatedAt: nowIso(),
      };
      findings.push(definition);
      suppressed.push({ filePath: file.path, starts: handler.windowEventStarts });
      superseded.push({ filePath: file.path, handlerStart: handler.start });

      const callSiteFindings: AnalysisFinding[] = [];
      for (const use of inlineCalls) {
        const callSite: AnalysisFinding = {
          id: newId('fnd'),
          scanTaskId,
          ruleId: rule.meta.id,
          ruleVersion: rule.meta.version,
          filePath: use.filePath,
          language: languageOf(use.filePath),
          startLine: use.call.startLine,
          endLine: use.call.endLine,
          startColumn: use.call.startColumn,
          endColumn: use.call.endColumn,
          startOffset: use.call.start,
          endOffset: use.call.end,
          category: rule.meta.category,
          severity: rule.meta.defaultSeverity,
          migrationLevel: level,
          confidence: 'CONFIRMED',
          message: `Inline ${use.call.eventName} handler calls ${handler.name}(...) without the event argument`,
          messageKey: 'rules.WL-JS-017.inlineCallSite',
          messageParams: {
            handler: handler.name,
            definitionFile: file.path,
            attribute: use.call.eventName,
          },
          risk:
            'The inline handler has the standard event object in scope, but it calls a function that reads window.event with no argument. Injecting the parameter in the definition without updating this call leaves the parameter undefined; both edits belong to the same migration.',
          recommendation:
            'Migrate the companion group, not this finding alone. The call becomes fn(event) while the definition takes the event parameter and replaces window.event. The preview includes both files and refuses if either changed since the scan.',
          evidence: {
            kind: 'CallExpression',
            matched: use.call.snippet,
            container: use.call.container,
            detail: {
              inlineCallSite: true,
              handler: handler.name,
              definitionFile: file.path,
              handlerStart: handler.start,
              handlerEnd: handler.end,
              callStart: use.call.start,
              callEnd: use.call.end,
              attribute: use.call.eventName,
              paramCount: handler.paramCount,
              argumentCount: use.call.argumentCount,
            },
          },
          snippet: use.call.snippet,
          status: level === 'SAFE' || level === 'CONDITIONAL' ? 'READY_FOR_MIGRATION' : 'DETECTED',
          statusUpdatedAt: nowIso(),
        };
        callSiteFindings.push(callSite);
      }

      const companionIds = [definition.id, ...callSiteFindings.map((finding) => finding.id)].join(',');
      definition.evidence.detail = { ...definition.evidence.detail, companionFindingIds: companionIds };
      for (const callSite of callSiteFindings) {
        callSite.evidence.detail = { ...callSite.evidence.detail, companionFindingIds: companionIds };
      }
      findings.push(...callSiteFindings);
    }
  }
  return { findings, suppressed, superseded };
}
