async function loadPool() {
const target = document.getElementById('pool-table');
if (!target) return;


try {
// Resolve URL correta para GitHub Pages ou local
const base = document.querySelector('base')?.href || '';
const url = new URL('data/pool.json', base || window.location.href).href;
const res = await fetch(url, { cache: 'no-store' });
if (!res.ok) throw new Error('Falha ao carregar pool.json');
const data = await res.json();


if (!Array.isArray(data.participants)) {
target.textContent = 'Nenhum participante ainda.';
return;
}


if (data.participants.length === 0) {
target.textContent = 'Nenhum participante ainda.';
return;
}


// Renderiza uma tabela simples
const tbl = document.createElement('table');
tbl.className = 'pool-table';
const thead = document.createElement('thead');
thead.innerHTML = `<tr><th>#</th><th>Nome/Nickname</th><th>GitHub</th><th>Inscrito em</th></tr>`;
tbl.appendChild(thead);


const tbody = document.createElement('tbody');
data.participants
.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at))
.forEach((p, idx) => {
const tr = document.createElement('tr');
const gh = p.github ? `<a href="https://github.com/${p.github}" target="_blank" rel="noopener">@${p.github}</a>` : '';
tr.innerHTML = `<td>${idx + 1}</td><td>${p.name || ''}</td><td>${gh}</td><td>${new Date(p.joined_at).toLocaleString()}</td>`;
tbody.appendChild(tr);
});
tbl.appendChild(tbody);


target.innerHTML = '';
target.appendChild(tbl);
} catch (e) {
console.error(e);
target.textContent = 'Erro ao carregar a lista de participantes.';
}
}


document.addEventListener('DOMContentLoaded', loadPool);