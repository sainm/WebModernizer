# Legacy example application

A deliberately IE-era JSP application used as the scan target for WebLift. It is a
fixture, not a working web app: nothing here is meant to run on a server.

## What it exercises

| Area | Location |
| --- | --- |
| JSP directives, scriptlets, EL, taglibs | `index.jsp`, `order/list.jsp`, `order/detail.jsp` |
| Shared header fragment | `common/header.jspf` |
| Shared script referenced by several pages | `js/common.js` |
| IE event model (`attachEvent`, `window.event`, `srcElement`, `returnValue`, `cancelBubble`) | `js/legacy-events.js`, inline handlers in the JSP pages |
| Dynamic script loading, `document.write`, `eval` | `js/dynamic-loader.js` |
| ActiveX / VBScript / conditional compilation | `index.jsp`, `help.html` |
| IE-only markup (conditional comments, `marquee`, `font`, `center`, `xml` island, `dynsrc`) | `index.jsp`, `help.html` |
| IE CSS (`expression()`, `behavior`, `-ms-filter`, star/underscore hacks, `-ms-*` mix) | `css/main.css`, `css/ie-fixes.css` |
| Clean modern JavaScript (must produce zero findings) | `js/modern.js` |
| Non-UTF-8 source file | `js/shift-jis-helper.js` (Shift_JIS, CRLF) |

## Why some files must stay broken

`js/modern.js` exists so a rule that suddenly matches modern code fails the test
suite. Do not "modernise" the other files: they are the input of the regression
tests in `backend/test`.

`js/shift-jis-helper.js` is intentionally stored in Shift_JIS. It proves that the
decoder picks the right encoding before parsing, so reported line numbers stay
correct for Japanese legacy sources.

## Expected results

The integration test asserts the numbers below. If a rule changes, update the test
rather than trimming the fixture.

```bash
npm run build:api
node backend/dist/cli/scan.js --project examples/legacy-app
```
