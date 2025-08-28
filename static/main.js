
async function loadParticipants() {
  const el = document.getElementById('pool-table');
  if (!el) return;
  try {
    const res = await fetch('/api/participants', { cache: 'no-store' });
    if (!res.ok) throw new Error('Falha ao carregar');
    const data = await res.json();
    const list = data.participants || [];
    if (list.length === 0) { el.textContent = 'Nenhum participante ainda.'; return; }

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>#</th><th>Nome</th><th>Escola</th><th>Inscrito em</th></tr></thead>';
    const tbody = document.createElement('tbody');
    list.forEach((p, i) => {
      const tr = document.createElement('tr');
      const dt = p.joined_at ? new Date(p.joined_at).toLocaleString() : '';
      tr.innerHTML = `<td>${i+1}</td><td>${p.name||''}</td><td>${p.school||''}</td><td>${dt}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.innerHTML = '';
    el.appendChild(table);
  } catch (e) {
    el.textContent = 'Erro ao carregar a lista de participantes.';
  }
}

async function submitJoin(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    name: f.name.value.trim(),
    school: f.school.value.trim(),
    group: f.group.value.trim()
  };
  if (!payload.name || !payload.school) return;
  const res = await fetch('/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    f.reset();
    loadParticipants();
  } else {
    alert('Falha ao enviar.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('join-form')?.addEventListener('submit', submitJoin);
  loadParticipants();
});
