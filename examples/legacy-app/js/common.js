/* Common helpers shared by every page. Loaded through <script src="js/common.js">. */

var LegacyApp = {};

function showMessage(text) {
  alert(text);
}

function formatDate(d) {
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "/" + (m < 10 ? "0" + m : m) + "/" + (day < 10 ? "0" + day : day);
}

function loadItemDetail(code) {
  var url = "order/detail.jsp?code=" + encodeURIComponent(code);
  window.location.href = url;
}

function getSelectedRows(gridId) {
  var rows = [];
  var grid = document.getElementById(gridId);
  if (!grid) return rows;
  for (var i = 0; i < grid.rows.length; i++) {
    var cell = grid.rows[i].cells[0];
    var box = cell.getElementsByTagName("input")[0];
    if (box && box.checked) rows.push(grid.rows[i]);
  }
  return rows;
}

function trimText(value) {
  return value.replace(/^\s+|\s+$/g, "");
}

function isIE() {
  return /MSIE (\d+\.\d+);/.test(navigator.userAgent);
}
