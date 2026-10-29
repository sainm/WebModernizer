// Generates a deliberately hostile legacy project for stress-testing the scanner.
//
// Not a fixture: this is meant to break things. Every construct below appears in real
// IE-era JSP systems and each one has broken a parser or a locator at some point.
//
//   node scripts/gen-stress-project.mjs <output-dir> [module-count]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function generateStressProject(outDir, moduleCount = 40) {
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function write(relPath, content) {
  const full = join(outDir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/* ---------------------------------------------------------------- JSP pages */

function jspPage(index) {
  return `<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%-- a comment that contains <script> and 中文 and a stray quote " --%>
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<title>画面 ${index}</title>
<link rel="stylesheet" href="../css/main.css" />
<script src="../js/common.js"></script>
<!--[if lt IE 9]><script src="../js/ie8.js"></script><![endif]-->
</head>
<body onload="init${index}()">
<div class="page">
  <table class="grid" id="grid${index}">
    <c:forEach var="row" items="\${rows}" varStatus="st">
      <tr onclick="selectRow(this)">
        <td style="width: expression(document.body.clientWidth / 4);">\${row.name}</td>
        <td><input type="checkbox" value="\${row.id}" /></td>
      </tr>
    </c:forEach>
  </table>

  <input type="button" value="検索" onclick="search${index}('<%= request.getParameter("q") %>')" />

  <script type="text/javascript">
    function init${index}() {
      var table = document.getElementById("grid${index}");
      if (table) {
        table.attachEvent("onclick", onGridClick);
      }
    }

    function search${index}(term) {
      var url = "../search.jsp?q=" + encodeURIComponent(term);
      if (window.event) {
        window.event.returnValue = false;
      }
      window.navigate(url);
    }

    function onGridClick() {
      var cell = window.event.srcElement;
      window.event.cancelBubble = true;
      var label = cell.innerText;
      <%-- server-side value inside a JS block --%>
      var expected = "<%= request.getAttribute("label") %>";
      if (label == expected) {
        document.execCommand("copy");
      }
    }

    /*@cc_on
    var ieOnly = @_jscript_version;
    @*/
  </script>

  <script language="VBScript">
    Sub Print${index}()
      MsgBox "印刷"
    End Sub
  </script>
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------- JS oddities */

const minified = `(function(){var a=document.createElement("div");a.attachEvent("onclick",function(){window.event.returnValue=false});for(var i=0;i<10;i++){document.write("<span>"+i+"</span>")}window.onload=function(){var s=document.styleSheets[0];var n=s.rules.length;return n}})( );`;

const crlfJs = ['// CRLF file with Japanese comments', 'var message = "保存しました";', 'function legacyConfirm() {', '  return confirm(message);', '}'].join('\r\n');

const bomJs = '\uFEFFvar bomMarker = true;\nfunction afterBom() { return bomMarker; }\n';

const deepJs = (() => {
  const depth = 40;
  let body = 'return document.all ? 1 : 0;';
  for (let i = depth; i > 0; i -= 1) body = `function level${i}() { ${body} }`;
  return `${body}\nlevel${depth}();\n`;
})();

write('pages/index.jsp', jspPage('List'), 'utf8');
for (let i = 1; i <= moduleCount; i += 1) {
  write(`modules/m${i}/page.jsp`, jspPage(`M${i}`), 'utf8');
  write(`modules/m${i}/fragment.jspf`, `<div class="frag"><font color="#333">${i}</font></div>\n`, 'utf8');
}

write('js/minified-legacy.js', minified, 'utf8');
write('js/crlf-legacy.js', crlfJs, 'utf8');
write('js/bom-file.js', bomJs, 'utf8');
write('js/deep-nesting.js', deepJs, 'utf8');

// Shift_JIS with Japanese text: a real non-UTF-8 source file.
const sjisText = [
  '/* 受注画面の共通処理 */',
  'function showMessage(text) {',
  '  alert(text);',
  '}',
  'function bindLegacy() {',
  '  document.getElementById("x").attachEvent("onclick", run);',
  '}',
  '',
].join('\r\n');
writeFileSync(join(outDir, 'js/legacy-sjis.js'), Buffer.from(new TextEncoder().encode(sjisText)));
// Overwrite with actual Shift_JIS bytes via a tiny manual table for the characters used.
const sjisBytes = Buffer.concat([
  // "受注画面の共通処理" in Shift_JIS, hand-encoded to keep this script dependency-free.
  Buffer.from([0x2f, 0x2a, 0x20, 0x8e, 0xf3, 0x92, 0x8d, 0x89, 0x69, 0x96, 0xca, 0x82, 0xcc, 0x8b, 0xa4, 0x92, 0xca, 0x8f, 0x88, 0x97, 0x9d, 0x20, 0x2a, 0x2f, 0x0d, 0x0a]),
  Buffer.from('function bindLegacy() {\r\n', 'ascii'),
  Buffer.from('  document.getElementById("x").attachEvent("onclick", run);\r\n', 'ascii'),
  Buffer.from('}\r\n', 'ascii'),
]);
writeFileSync(join(outDir, 'js/hand-encoded-sjis.js'), sjisBytes);

/* ------------------------------------------------------------------- CSS */

const cssDeclarations = [];
for (let i = 0; i < 1200; i += 1) {
  cssDeclarations.push(
    `.row-${i} { width: ${i}px; *width: ${i - 10}px; _height: 18px; color: #333\\9; -ms-flex: 1; }`,
  );
}
write(
  'css/bulk.css',
  `@charset "UTF-8";\n${cssDeclarations.join('\n')}\n\n@media screen and (max-width: 800px) {\n  .narrow { width: expression(document.body.clientWidth - 20); }\n}\n`,
);

write(
  'css/hacks.css',
  `.a { behavior: url(#default#time2); }\n.b { filter: progid:DXImageTransform.Microsoft.Alpha(Opacity=50); }\n.c { -ms-writing-mode: lr-tb; }\n`,
);

/* ------------------------------------------------------------------ HTML */

write(
  'static/broken.html',
  `<html><body><table><tr><td>unclosed cells
  <div><p>paragraph without end
  <marquee>注意</marquee>
  <applet code="Live.class"></applet>
  <xml id="data"><item /></xml>
</body></html>`,
);

write('static/empty-body.html', '<html><body></body></html>');
write('static/one-line.html', `<html><body>${'<div class="x">段</div>'.repeat(400)}</body></html>`);

/* ------------------------------------------------------------------ misc */

write('README.md', '# stress project\n');

return { outDir, moduleCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2] ?? '/tmp/weblift-stress';
  const moduleCount = Number(process.argv[3] ?? 40);
  const result = generateStressProject(outDir, moduleCount);
  console.log(`generated ${result.outDir} (${result.moduleCount} modules)`);
}
