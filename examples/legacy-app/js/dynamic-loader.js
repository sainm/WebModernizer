/* Lazy loading helpers. The target script is assembled at runtime. */

var scriptBase = "/legacy-app/js/modules/";

function loadModule(name, callback) {
  var el = document.createElement("script");
  el.src = scriptBase + name + ".js";
  el.onload = callback;
  document.getElementsByTagName("head")[0].appendChild(el);
}

function loadModuleLegacy(name) {
  document.write('<script src="' + scriptBase + name + '.js"><\/script>');
}

function evalRule(ruleText) {
  eval(ruleText);
}

function buildHandler(handlerName) {
  return new Function("event", handlerName + "(event);");
}

function delayedRefresh() {
  setTimeout("refreshGrid()", 5000);
}

function refreshGrid() {
  var grid = document.getElementById("orderTable");
  if (grid) grid.style.display = "";
}

function isIeBrowser() {
  return navigator.userAgent.indexOf("MSIE 8.0") >= 0;
}

function getTridentVersion() {
  return navigator.userAgent.indexOf("Trident/5.0") >= 0;
}
