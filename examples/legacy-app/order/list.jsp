<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<title>受注一覧</title>
<script src="<%=request.getContextPath()%>/js/common.js"></script>
<script src="../js/legacy-events.js"></script>
<script src="../js/dynamic-loader.js"></script>
<link rel="stylesheet" href="../css/main.css" />
</head>
<body onload="bindRowHandlers()">

<h2 class="title">受注一覧</h2>

<table id="orderTable" class="grid">
  <thead>
    <tr><th>選択</th><th>受注番号</th><th>得意先</th><th>金額</th></tr>
  </thead>
  <tbody>
    <c:forEach var="order" items="${orderList}" varStatus="status">
      <tr onclick="selectRow(this)">
        <td><input type="checkbox" name="sel" value="${order.id}" /></td>
        <td>${order.orderNo}</td>
        <td><c:out value="${order.customerName}" /></td>
        <td style="text-align: right; width: expression(document.body.clientWidth / 4);">
          <fmt:formatNumber value="${order.amount}" pattern="#,##0" />
        </td>
      </tr>
    </c:forEach>
  </tbody>
</table>

<div class="toolbar">
  <input type="button" value="更新" onclick="onUpdateClick()" />
  <input type="button" value="CSV 出力" onclick="exportCsv()" />
</div>

<script type="text/javascript">
  function selectRow(row) {
    var box = row.cells[0].getElementsByTagName("input")[0];
    box.checked = !box.checked;
  }

  function onUpdateClick() {
    var rows = getSelectedRows("orderTable");
    if (rows.length == 0) {
      showMessage("行を選択してください");
      window.event.returnValue = false;
      return;
    }
    document.forms[0].submit();
  }

  function exportCsv() {
    loadModule("csv-export", function () {
      window.CsvExport.run("orderTable");
    });
  }
</script>

</body>
</html>
