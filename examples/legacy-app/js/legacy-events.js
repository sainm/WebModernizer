/*
 * Legacy event plumbing written for IE6/IE8.
 * Every function below is called from a JSP page through inline handlers.
 */

function bindRowHandlers() {
  var table = document.getElementById("orderTable");
  if (!table) return;

  for (var i = 1; i < table.rows.length; i++) {
    var row = table.rows[i];
    row.attachEvent("onmouseover", onRowOver);
    row.attachEvent("onmouseout", onRowOut);
    row.attachEvent("onclick", onRowClick);
  }
}

function unbindRowHandlers() {
  var table = document.getElementById("orderTable");
  if (!table) return;
  for (var i = 1; i < table.rows.length; i++) {
    table.rows[i].detachEvent("onmouseover", onRowOver);
    table.rows[i].detachEvent("onclick", onRowClick);
  }
}

function onRowOver() {
  var target = window.event.srcElement;
  while (target && target.tagName != "TR") {
    target = target.parentNode;
  }
  if (target) {
    target.style.backgroundColor = "#eef4ff";
  }
}

function onRowOut() {
  var target = window.event.srcElement;
  while (target && target.tagName != "TR") {
    target = target.parentNode;
  }
  if (target) {
    target.style.backgroundColor = "";
  }
}

function onRowClick() {
  var cell = window.event.srcElement;
  if (cell.tagName == "INPUT") {
    return;
  }
  window.event.cancelBubble = true;
  selectRow(cell.parentNode);
}

function blockEnterKey() {
  if (window.event.keyCode == 13) {
    window.event.returnValue = false;
    window.event.cancelBubble = true;
  }
}

function getEventTarget() {
  return window.event.srcElement;
}

function copyToClipboard(text) {
  window.clipboardData.setData("Text", text);
  return true;
}

function readClipboard() {
  return window.clipboardData.getData("Text");
}

function getSelectionText() {
  var range = document.selection.createRange();
  return range.text;
}

function fireLegacyEvent(element) {
  element.fireEvent("onchange");
}

function createLegacyEvent() {
  var evt = document.createEventObject();
  evt.type = "click";
  return evt;
}

function allElements() {
  return document.all;
}

function runGenerated(code) {
  window.execScript(code, "JavaScript");
}

/* Modern-style handler signature, still using IE event members.
   This pair is the SAFE automation case: the event object is a parameter,
   so srcElement -> target and cancelBubble -> stopPropagation are provable. */
function highlightCell(event) {
  var cell = event.srcElement;
  event.cancelBubble = true;
  if (cell && cell.parentNode) {
    cell.parentNode.style.backgroundColor = "#fff7d6";
  }
}
