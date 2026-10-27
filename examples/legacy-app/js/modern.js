/* Modern code that must produce zero findings. Used as a regression guard: if a rule
   starts matching here, the rule is too broad. */

(function () {
  'use strict';

  function bindToolbar() {
    var toolbar = document.querySelector('.toolbar');
    if (!toolbar) return;

    toolbar.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      event.preventDefault();
      handle(button.dataset.action);
    });
  }

  function handle(action) {
    switch (action) {
      case 'refresh':
        refresh();
        break;
      case 'export':
        exportCsv();
        break;
      default:
        break;
    }
  }

  function refresh() {
    fetch('/api/orders?page=1', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.json();
      })
      .then(function (payload) {
        render(payload.items);
      })
      .catch(function (error) {
        console.error('refresh failed', error);
      });
  }

  function render(items) {
    var tbody = document.querySelector('#orderTable tbody');
    if (!tbody) return;
    tbody.replaceChildren();
    for (var i = 0; i < items.length; i += 1) {
      var row = document.createElement('tr');
      var cell = document.createElement('td');
      cell.textContent = items[i].orderNo;
      row.appendChild(cell);
      tbody.appendChild(row);
    }
  }

  function exportCsv() {
    var blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'orders.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  document.addEventListener('DOMContentLoaded', bindToolbar);
})();
