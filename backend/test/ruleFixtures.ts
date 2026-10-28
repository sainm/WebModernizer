/**
 * One firing fixture per rule, shared by the coverage test and the message-contract test.
 * Adding a rule without a fixture here fails the coverage suite.
 */
export interface Fixture {
  id: string;
  file: string;
  code: string;
}

export const FIXTURES: Fixture[] = [
  { id: 'WL-JS-001', file: 'r.js', code: 'el.attachEvent("onclick", handler);' },
  { id: 'WL-JS-002', file: 'r.js', code: 'el.detachEvent("onclick", handler);' },
  { id: 'WL-JS-003', file: 'r.js', code: 'var current = window.event;' },
  { id: 'WL-JS-004', file: 'r.js', code: 'var everything = document.all;' },
  { id: 'WL-JS-005', file: 'r.js', code: 'var legacyEvent = document.createEventObject();' },
  { id: 'WL-JS-006', file: 'r.js', code: 'function f(event) { return event.srcElement; }' },
  { id: 'WL-JS-007', file: 'r.js', code: 'function f(event) { event.returnValue = false; }' },
  { id: 'WL-JS-008', file: 'r.js', code: 'function f(event) { event.cancelBubble = true; }' },
  { id: 'WL-JS-009', file: 'r.js', code: 'window.showModalDialog("pick.jsp");' },
  { id: 'WL-JS-010', file: 'r.js', code: 'window.showModelessDialog("pick.jsp");' },
  { id: 'WL-JS-011', file: 'r.js', code: 'var range = document.selection.createRange();' },
  { id: 'WL-JS-012', file: 'r.js', code: 'window.clipboardData.setData("Text", "x");' },
  { id: 'WL-JS-013', file: 'r.js', code: 'var shell = new ActiveXObject("WScript.Shell");' },
  { id: 'WL-JS-014', file: 'r.js', code: 'window.execScript("var a = 1;");' },
  { id: 'WL-JS-015', file: 'r.js', code: '/*@cc_on var ieOnly = 1; @*/' },
  { id: 'WL-DOM-001', file: 'r.js', code: 'el.fireEvent("onclick");' },
  { id: 'WL-DOM-002', file: 'r.js', code: 'var w = el.currentStyle.width;' },
  { id: 'WL-JS-016', file: 'r.js', code: 'window.navigate("/next.jsp");' },
  { id: 'WL-DOM-003', file: 'r.js', code: 'var first = document.styleSheets[0].rules[0];' },
  { id: 'WL-DOM-004', file: 'r.js', code: 'document.execCommand("bold");' },
  { id: 'WL-BEH-002', file: 'r.js', code: 'var isIe = navigator.appName == "Microsoft Internet Explorer";' },
  { id: 'WL-BEH-001', file: 'r.js', code: 'var isIe = navigator.userAgent.indexOf("MSIE 8.0") >= 0;' },

  { id: 'WL-HTML-001', file: 'r.html', code: '<html><body><!--[if IE]><p>only ie</p><![endif]--></body></html>' },
  { id: 'WL-HTML-002', file: 'r.html', code: '<html><body><marquee>notice</marquee></body></html>' },
  { id: 'WL-HTML-003', file: 'r.html', code: '<html><head><script language="JavaScript">var a = 1;</script></head></html>' },
  {
    id: 'WL-HTML-004',
    file: 'r.html',
    code: '<html><body><script language="VBScript">\nSub Go()\nEnd Sub\n</script></body></html>',
  },
  { id: 'WL-HTML-005', file: 'r.html', code: '<html><body><object classid="clsid:22D6F312-B0F6-11D0-94AB-0080C74C7E95"></object></body></html>' },
  { id: 'WL-HTML-006', file: 'r.html', code: '<html><body><img src="poster.gif" dynsrc="clip.avi" /></body></html>' },
  { id: 'WL-HTML-007', file: 'r.html', code: '<html><body><xml id="data"><item code="A1" /></xml></body></html>' },
  {
    id: 'WL-HTML-008',
    file: 'r.html',
    code: '<html><head><meta http-equiv="X-UA-Compatible" content="IE=EmulateIE7" /></head></html>',
  },
  {
    id: 'WL-HTML-009',
    file: 'r.html',
    code: '<html><body><script for="window" event="onload">init();</script></body></html>',
  },

  { id: 'WL-CSS-001', file: 'r.css', code: '.a { width: expression(document.body.clientWidth - 10); }' },
  { id: 'WL-CSS-002', file: 'r.css', code: '.a { behavior: url(#default#time2); }' },
  { id: 'WL-CSS-003', file: 'r.css', code: '.a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr=#fff); }' },
  { id: 'WL-CSS-004', file: 'r.css', code: '.a { -ms-flex: 1; }' },
  { id: 'WL-CSS-005', file: 'r.css', code: '.a { *zoom: 1; }' },
  { id: 'WL-CSS-006', file: 'r.css', code: '.a { zoom: 1; }' },

  { id: 'WL-DYN-001', file: 'r.js', code: 'el.src = basePath + name + ".js";' },
  {
    id: 'WL-DYN-002',
    file: 'r.js',
    code: 'document.write("<script src=\\"" + moduleName + ".js\\"><\\/script>");',
  },
  { id: 'WL-DYN-003', file: 'r.js', code: 'eval("var a = " + value);' },

  {
    id: 'WL-JSP-001',
    file: 'r.jsp',
    code: '<html><body><script>\nvar total = <%= total %>;\n</script></body></html>',
  },
  {
    id: 'WL-JSP-002',
    file: 'r.jsp',
    code: '<html><head><script src="<%= request.getContextPath() %>/js/app.js"></script></head></html>',
  },
];

