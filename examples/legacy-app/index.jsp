<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>受注入力 - レガシー業務システム</title>
<link rel="stylesheet" href="css/main.css" />
<link rel="stylesheet" href="css/ie-fixes.css" />
<script src="js/common.js"></script>
<script src="js/legacy-events.js"></script>
<!--[if lt IE 9]>
<script src="js/ie8-polyfill.js"></script>
<link rel="stylesheet" href="css/ie8-only.css" />
<![endif]-->
</head>
<body onload="initPage()">
<%@ include file="common/header.jspf" %>

<div class="page">
  <h1><font color="#003366" size="4">受注入力</font></h1>

  <center>
    <marquee behavior="scroll" scrollamount="3">【重要】月末締め処理は 17:00 までに完了してください</marquee>
  </center>

  <form name="orderForm" action="order/submit.jsp" method="post" onsubmit="return validateForm()">
    <table class="grid" width="100%">
      <tr>
        <th>得意先コード</th>
        <td><input type="text" name="customerCode" id="customerCode" value="<%= request.getParameter("code") %>" /></td>
      </tr>
      <tr>
        <th>商品</th>
        <td>
          <select name="itemCode" id="itemCode" onchange="onItemChange()">
            <c:forEach var="item" items="${itemList}">
              <option value="${item.code}">${item.name}</option>
            </c:forEach>
          </select>
        </td>
      </tr>
    </table>

    <input type="button" value="得意先検索" onclick="openCustomerSearch()" />
    <input type="submit" value="登録" />
  </form>

  <object classid="clsid:8AD9C840-044E-11D1-B3E9-00805F499D93" width="0" height="0" id="printCtl"></object>

  <xml id="itemMaster">
    <items>
      <item code="A001" name="ボルト" />
    </items>
  </xml>
</div>

<script type="text/javascript">
  // 初期化：IE のイベントモデルで登録している
  function initPage() {
    var form = document.forms["orderForm"];
    if (form) {
      form.attachEvent("onsubmit", onFormSubmit);
    }
    window.onbeforeunload = confirmLeave;
  }

  function onFormSubmit() {
    var msg = window.event ? "saved" : "unknown";
    // element.attachEvent("onclick", handler);  ← コメントなので検出してはいけない
    var sample = "attachEvent is deprecated";
    return confirm("登録しますか？ (" + msg + ")");
  }

  function onItemChange() {
    var sel = window.event.srcElement;
    if (sel.value == "") {
      window.event.returnValue = false;
      window.event.cancelBubble = true;
      return;
    }
    loadItemDetail(sel.value);
  }

  function openCustomerSearch() {
    var result = window.showModalDialog("customer/search.jsp", null, "dialogWidth:800px;dialogHeight:600px");
    if (result) {
      document.getElementById("customerCode").value = result.code;
    }
  }

  function confirmLeave() {
    window.event.returnValue = "変更が保存されていません";
  }

  // @cc_on により IE でのみ有効
  /*@cc_on
  var ieVersion = @_jscript_version;
  @*/
</script>

<script language="VBScript">
  Sub PrintForm()
    MsgBox "印刷を開始します"
  End Sub
</script>

</body>
</html>
