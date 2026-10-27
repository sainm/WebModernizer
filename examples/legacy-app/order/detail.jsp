<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<title>受注詳細</title>
<script type="text/javascript" src="<%=request.getContextPath()%>/js/common.js"></script>
<link rel="stylesheet" href="../css/main.css" />
<link rel="stylesheet" href="../css/ie-fixes.css" />
</head>
<body>

<div class="detail">
  <h2>受注番号: <%= request.getParameter("no") %></h2>

  <table class="grid">
    <tr><th>得意先</th><td><%= request.getAttribute("customerName") %></td></tr>
    <tr><th>金額</th><td class="amount">${order.amount}</td></tr>
    <tr>
      <th>明細</th>
      <td>
        <div id="lines" style="height: expression(document.body.clientHeight - 200);">
          <c:forEach var="line" items="${order.lines}">
            <div class="line"><span>${line.itemName}</span> <span>${line.qty}</span></div>
          </c:forEach>
        </div>
      </td>
    </tr>
  </table>

  <input type="button" value="印刷" onclick="printDetail()" />
  <input type="button" value="戻る" onclick="history.back()" />
</div>

<script type="text/javascript">
  function printDetail() {
    try {
      printCtl.Print();
    } catch (e) {
      showMessage("印刷コントロールを初期化できません");
    }
  }

  function attachDetailHandlers() {
    var lines = document.getElementById("lines");
    lines.attachEvent("onmouseover", function () {
      window.event.srcElement.style.background = "#ffffcc";
    });
    lines.detachEvent("onmouseout", function () {});
  }

  attachDetailHandlers();
</script>

</body>
</html>
