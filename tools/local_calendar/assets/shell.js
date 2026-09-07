fetch('/__local-test__/metadata')
  .then(response => {
    if (!response.ok) throw new Error('metadata');
    return response.json();
  })
  .then(data => {
    document.getElementById('data-state').textContent = `${data.data_label} · Code ${data.code_revision}`;
  })
  .catch(() => {
    document.getElementById('data-state').textContent = 'Datenstand unbekannt · keine Live-Verbindung';
  });
