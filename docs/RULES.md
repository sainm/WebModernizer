# Rule catalog

Generated from the running rule registry, so this file cannot drift from the code.
Total: **42 rules**, **13 recipes**.

## Distribution by category

| Category | Rules |
| --- | --- |
| JS_API | 4 |
| DOM_API | 11 |
| BROWSER_BEHAVIOR | 7 |
| ACTIVEX_VBSCRIPT | 4 |
| HTML_COMPAT | 5 |
| CSS_COMPAT | 6 |
| DYNAMIC_CODE | 5 |

## Automation levels

- **SAFE** — the recipe preconditions prove equivalence on the matched shape, and the test suite covers the transformation.
- **CONDITIONAL** — the rewrite is mechanically valid but changes semantics a human must confirm (event `this`, cancelability, listener life cycle).
- **MANUAL** — detected and located, but no safe automatic rewrite exists in phase one.
- **UNSUPPORTED** — the capability does not exist in Chrome at all (ActiveX, VBScript, `.htc` behaviors); a product decision is required.

A rule may only report SAFE or CONDITIONAL when a recipe is registered for it. The engine enforces this at analysis time, so the dashboard "auto convertible" count can never include a finding with nothing to execute.

## Rules

| Rule | Name | Language | Category | Severity | Automation | Recipe | Tags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WL-JS-001 | attachEvent binding | javascript | JS_API | HIGH | CONDITIONAL | RCP-ATTACHEVENT | event, ie-only-api |
| WL-JS-002 | detachEvent unbinding | javascript | JS_API | MEDIUM | CONDITIONAL | RCP-DETACHEVENT | event, ie-only-api |
| WL-JS-003 | window.event global | javascript | DOM_API | HIGH | MANUAL | — | event, ie-only-api |
| WL-JS-004 | document.all | javascript | DOM_API | MEDIUM | MANUAL | — | ie-only-api, feature-detection |
| WL-JS-005 | document.createEventObject | javascript | DOM_API | MEDIUM | MANUAL | — | event, removed-api |
| WL-JS-006 | event.srcElement | javascript | DOM_API | MEDIUM | SAFE | RCP-SRCELEMENT | event, ie-only-api |
| WL-JS-007 | event.returnValue assignment | javascript | DOM_API | MEDIUM | CONDITIONAL | RCP-RETURNVALUE | event, ie-only-api |
| WL-JS-008 | event.cancelBubble assignment | javascript | DOM_API | MEDIUM | SAFE | RCP-CANCELBUBBLE | event, ie-only-api |
| WL-JS-009 | showModalDialog | javascript | BROWSER_BEHAVIOR | HIGH | MANUAL | — | dialog, removed-api |
| WL-JS-010 | showModelessDialog | javascript | BROWSER_BEHAVIOR | MEDIUM | MANUAL | — | dialog, removed-api |
| WL-JS-011 | document.selection | javascript | DOM_API | HIGH | MANUAL | — | selection, ie-only-api |
| WL-JS-012 | window.clipboardData | javascript | JS_API | MEDIUM | UNSUPPORTED | — | clipboard, removed-api |
| WL-JS-013 | ActiveXObject | javascript | ACTIVEX_VBSCRIPT | HIGH | UNSUPPORTED | — | activex, blocker |
| WL-JS-014 | execScript | javascript | JS_API | MEDIUM | CONDITIONAL | RCP-EXECSCRIPT | eval, removed-api |
| WL-JS-015 | Conditional compilation (@cc_on) | javascript | ACTIVEX_VBSCRIPT | HIGH | UNSUPPORTED | — | jscript, blocker |
| WL-JS-016 | window.navigate | javascript | BROWSER_BEHAVIOR | MEDIUM | CONDITIONAL | RCP-NAVIGATE | navigation, removed-api |
| WL-DOM-002 | element.currentStyle | javascript | DOM_API | MEDIUM | MANUAL | — | computed-style, ie-only-api |
| WL-DOM-003 | styleSheet.rules | javascript | DOM_API | MEDIUM | CONDITIONAL | RCP-CSSRULES | stylesheet, ie-only-api |
| WL-DOM-004 | document.execCommand | javascript | DOM_API | LOW | MANUAL | — | deprecated, editing |
| WL-BEH-002 | navigator.appName IE check | javascript | BROWSER_BEHAVIOR | MEDIUM | MANUAL | — | ua-sniffing, behavior |
| WL-DOM-001 | element.fireEvent | javascript | DOM_API | HIGH | CONDITIONAL | RCP-FIREEVENT | event, ie-only-api |
| WL-BEH-001 | IE user-agent sniffing | javascript | BROWSER_BEHAVIOR | HIGH | MANUAL | — | ua-sniffing, behavior |
| WL-HTML-001 | IE conditional comment | html | HTML_COMPAT | MEDIUM | MANUAL | — | conditional-comment, ie-only |
| WL-HTML-002 | Legacy or IE-only element | html | HTML_COMPAT | MEDIUM | MANUAL | — | obsolete-element |
| WL-HTML-003 | Obsolete script language attribute | html | HTML_COMPAT | LOW | SAFE | RCP-SCRIPT-LANGUAGE | obsolete-attribute |
| WL-HTML-004 | VBScript script block | html | ACTIVEX_VBSCRIPT | HIGH | UNSUPPORTED | — | vbscript, blocker |
| WL-HTML-005 | ActiveX control embed | html | ACTIVEX_VBSCRIPT | HIGH | UNSUPPORTED | — | activex, blocker |
| WL-HTML-006 | IE-only attribute | html | HTML_COMPAT | MEDIUM | MANUAL | — | ie-only-attribute |
| WL-HTML-007 | XML data island | html | HTML_COMPAT | HIGH | MANUAL | — | data-binding, ie-only |
| WL-HTML-008 | X-UA-Compatible meta tag | html | BROWSER_BEHAVIOR | LOW | SAFE | RCP-DROP-UA-COMPATIBLE | document-mode |
| WL-HTML-009 | script for/event IE binding | html | BROWSER_BEHAVIOR | MEDIUM | UNSUPPORTED | — | event, ie-only |
| WL-CSS-001 | CSS expression() | css | CSS_COMPAT | HIGH | MANUAL | — | ie-only, dynamic-css |
| WL-CSS-002 | CSS behavior property | css | CSS_COMPAT | HIGH | UNSUPPORTED | — | htc, blocker |
| WL-CSS-003 | IE filter (progid / alpha) | css | CSS_COMPAT | MEDIUM | MANUAL | — | ie-only, filter |
| WL-CSS-004 | Vendor -ms- prefixed property | css | CSS_COMPAT | MEDIUM | CONDITIONAL | RCP-RENAME-MS-PROP | vendor-prefix |
| WL-CSS-005 | IE CSS hack syntax | css | CSS_COMPAT | MEDIUM | SAFE | RCP-DROP-CSS-HACK | css-hack |
| WL-CSS-006 | zoom property | css | CSS_COMPAT | LOW | MANUAL | — | layout |
| WL-JSP-001 | Dynamic JSP region inside analyzed block | jsp | DYNAMIC_CODE | MEDIUM | MANUAL | — | jsp, dynamic |
| WL-JSP-002 | Asset URL built by server-side code | jsp | DYNAMIC_CODE | MEDIUM | MANUAL | — | jsp, dynamic-reference |
| WL-DYN-001 | Script URL assembled at runtime | javascript | DYNAMIC_CODE | MEDIUM | MANUAL | — | dynamic-reference |
| WL-DYN-002 | document.write with generated markup | javascript | DYNAMIC_CODE | MEDIUM | MANUAL | — | dynamic-markup |
| WL-DYN-003 | eval / Function / string timer | javascript | DYNAMIC_CODE | MEDIUM | MANUAL | — | dynamic-code, csp |

## Recipes

| Recipe | Name | Level | Rules | Summary |
| --- | --- | --- | --- | --- |
| RCP-SRCELEMENT | event.srcElement -> event.target | SAFE | WL-JS-006 | Renames the property access on an event parameter from srcElement to target. |
| RCP-CANCELBUBBLE | event.cancelBubble = true -> event.stopPropagation() | SAFE | WL-JS-008 | Replaces the assignment with a stopPropagation() call on the same object. |
| RCP-RETURNVALUE | event.returnValue = false -> event.preventDefault() | CONDITIONAL | WL-JS-007 | Replaces the assignment with preventDefault() on the same event object. |
| RCP-ATTACHEVENT | attachEvent -> addEventListener | CONDITIONAL | WL-JS-001 | Renames the method and strips the "on" prefix from the event name. |
| RCP-DETACHEVENT | detachEvent -> removeEventListener | CONDITIONAL | WL-JS-002 | Renames the method and strips the "on" prefix from the event name. |
| RCP-FIREEVENT | fireEvent -> dispatchEvent | CONDITIONAL | WL-DOM-001 | Replaces the IE event dispatch with dispatchEvent(new Event(...)) on the same element. |
| RCP-EXECSCRIPT | execScript -> indirect eval | CONDITIONAL | WL-JS-014 | Replaces window.execScript(code) with (0, eval)(code), which also evaluates in global scope. |
| RCP-NAVIGATE | window.navigate -> location.assign | CONDITIONAL | WL-JS-016 | Replaces the IE navigation call with location.assign on the same argument. |
| RCP-CSSRULES | styleSheet.rules -> cssRules | CONDITIONAL | WL-DOM-003 | Renames the property access on a stylesheet object. |
| RCP-SCRIPT-LANGUAGE | Remove obsolete script language attribute | SAFE | WL-HTML-003 | Deletes language="JavaScript" from the <script> tag; Chrome infers the type anyway. |
| RCP-DROP-UA-COMPATIBLE | Remove X-UA-Compatible document mode | SAFE | WL-HTML-008 | Deletes the IE document-mode <meta> tag, which Chrome ignores. |
| RCP-DROP-CSS-HACK | Drop IE CSS hack declaration | SAFE | WL-CSS-005 | Deletes the star/underscore declaration or the \9 value hack. |
| RCP-RENAME-MS-PROP | Rename -ms- property to the standard one | CONDITIONAL | WL-CSS-004 | Renames the prefixed property in place; the value and formatting stay untouched. |

## Evidence discipline

Every finding carries `evidence.kind`, `evidence.matched`, and a structured `detail` map. Matching is AST-based for JavaScript and CSS declarations, so identical text inside comments or string literals never produces a finding. The regression test for exactly that case lives in `backend/test/rules.test.ts`.

