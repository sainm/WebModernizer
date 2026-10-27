/* 受注画面の補助処理。このファイルは Shift_JIS で保存されている。 */

function bindLegacySearch() {
  var btn = document.getElementById("searchBtn");
  // 旧 IE では attachEvent を使う（コメント内なので検出対象外）
  if (btn) {
    btn.attachEvent("onclick", doSearch);
  }
  var label = "検索ボタン";
  showMessage(label);
}

function doSearch() {
  var code = document.getElementById("customerCode").value;
  showMessage("検索中: " + code);
}
