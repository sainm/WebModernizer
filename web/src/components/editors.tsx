import { useCallback, useEffect, useRef } from 'react';
import { DiffEditor, Editor, loader, type Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Bundle Monaco locally instead of pulling it from a CDN: the tool must work on a
// machine with no external network access.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

const THEME = 'weblift-light';

let themeRegistered = false;
function ensureTheme(instance: Monaco): void {
  if (themeRegistered) return;
  instance.editor.defineTheme(THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280' },
      { token: 'keyword', foreground: '2456d6' },
      { token: 'string', foreground: '0f766e' },
      { token: 'number', foreground: '9a3412' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#f7f9fc',
      'editorLineNumber.foreground': '#aab2c0',
      'editorLineNumber.activeForeground': '#4a5260',
      'editor.selectionBackground': '#dbe6ff',
      'diffEditor.insertedTextBackground': '#dcf3e5',
      'diffEditor.removedTextBackground': '#fbdcd9',
    },
  });
  themeRegistered = true;
}

const BASE_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 18,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  renderLineHighlight: 'none' as const,
  smoothScrolling: true,
  scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
  padding: { top: 8, bottom: 8 },
  automaticLayout: true,
  // A blinking caret makes every screenshot differ by a few thousand pixels, which
  // shows up as a false visual regression. Render a steady one instead.
  cursorBlink: 'solid' as const,
  contextmenu: false,
  wordWrap: 'off' as const,
};

function monacoLanguage(language: string): string {
  switch (language) {
    case 'javascript':
    case 'jsp':
      return 'javascript';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    default:
      return 'plaintext';
  }
}

export function languageForPath(path: string): string {
  if (/\.(jsp|jspf|jspx|tag)$/i.test(path)) return 'jsp';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.html?$/i.test(path)) return 'html';
  return 'javascript';
}

/**
 * Read-only code view with a highlighted range. The range comes straight from the
 * backend (1-based line and column), so the highlight is the analyzer's evidence,
 * not a client-side guess.
 */
export function CodeViewer({
  value,
  language = 'javascript',
  startLine,
  endLine,
  height = 320,
  revealLine,
}: {
  value: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  height?: number | string;
  revealLine?: number;
}) {
  const decorations = useRef<string[]>([]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const highlightRange = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !startLine) return;
    const model = editor.getModel();
    if (!model) return;
    const lastLine = model.getLineCount();
    const from = Math.min(Math.max(1, startLine), lastLine);
    const to = Math.min(Math.max(from, endLine ?? from), lastLine);
    decorations.current = editor.deltaDecorations(decorations.current, [
      {
        range: new monaco.Range(from, 1, to, model.getLineMaxColumn(to)),
        options: { isWholeLine: true, className: 'wl-highlight-line', linesDecorationsClassName: 'wl-highlight-gutter' },
      },
    ]);
    editor.revealLineInCenter(from, monaco.editor.ScrollType.Immediate);
  }, [startLine, endLine]);

  // Monaco recalculates its layout asynchronously (automaticLayout), which resets the
  // scroll position. Re-applying the highlight once the layout has settled keeps the
  // file scrolled to the finding instead of opening at line 1.
  useEffect(() => {
    const first = setTimeout(highlightRange, 0);
    const settled = setTimeout(highlightRange, 180);
    return () => {
      clearTimeout(first);
      clearTimeout(settled);
    };
  }, [highlightRange, value]);

  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    editorRef.current.revealLineInCenter(revealLine, monaco.editor.ScrollType.Smooth);
  }, [revealLine]);

  return (
    <div className="editor-shell">
      <Editor
        height={height}
        language={monacoLanguage(language)}
        theme={THEME}
        value={value}
        options={BASE_OPTIONS}
        beforeMount={ensureTheme}
        onMount={(editor) => {
          editorRef.current = editor;
          if (startLine) {
            const model = editor.getModel();
            if (model) {
              editor.deltaDecorations([], [
                {
                  range: new monaco.Range(
                    Math.min(startLine, model.getLineCount()),
                    1,
                    Math.min(endLine ?? startLine, model.getLineCount()),
                    model.getLineMaxColumn(Math.min(endLine ?? startLine, model.getLineCount())),
                  ),
                  options: { isWholeLine: true, className: 'wl-highlight-line', linesDecorationsClassName: 'wl-highlight-gutter' },
                },
              ]);
              editor.revealLineInCenter(startLine, monaco.editor.ScrollType.Smooth);
            }
          }
        }}
      />
    </div>
  );
}

/** Side-by-side diff. Used for migration preview: left = disk, right = result. */
export function DiffViewer({
  original,
  modified,
  language = 'javascript',
  height = 360,
}: {
  original: string;
  modified: string;
  language?: string;
  height?: number | string;
}) {
  return (
    <div className="editor-shell">
      <DiffEditor
        height={height}
        language={monacoLanguage(language)}
        theme={THEME}
        original={original}
        modified={modified}
        beforeMount={ensureTheme}
        options={{
          ...BASE_OPTIONS,
          readOnly: true,
          renderSideBySide: true,
          ignoreTrimWhitespace: false,
          renderIndicators: true,
        }}
      />
    </div>
  );
}
