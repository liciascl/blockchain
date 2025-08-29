// static/mine.js
(() => {
  const $ = (sel) => document.querySelector(sel);

  const poolList   = $('#pool-list');
  const lbTable    = $('#lb-table');
  const chainEl    = $('#chain');
  const boardEl    = $('#board');
  const puzzleType = $('#puzzle-type');
  const puzzleHint = $('#puzzle-hint');
  const btnSubmit  = $('#btn-submit');
  const statusEl   = $('#status');

  let schulte = { size: 0, grid: [], picks: [], next: 1, total: 0 };
  let currentOpenBlockId = null;
  // --- estado da lista de blocos (compacta por padrão)
  let chainShowAll = false;
  const MAX_VISIBLE_BLOCKS = 6; // mude aqui se quiser mostrar mais/menos

  async function jget(u) {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error(`${u} -> ${r.status}`);
    return r.json();
  }
  async function jpost(u, data) {
    const r = await fetch(u, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'include',
      body: JSON.stringify(data || {})
    });
    // Mesmo em erro 4xx/5xx, tento ler JSON p/ mostrar msg útil
    let payload = null;
    try { payload = await r.json(); } catch {}
    if (!r.ok) {
      const reason = payload?.error || `HTTP ${r.status}`;
      throw new Error(reason);
    }
    return payload || {};
  }

  async function refreshParticipants() {
    const data = await jget('/api/participants?limit=500');
    if (!data.items?.length) { poolList.innerHTML = '<li>Carregando...</li>'; return; }
    poolList.innerHTML = data.items.map(p => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.school)}</li>`).join('');
  }

  async function refreshLeaderboard() {
    const data = await jget('/api/leaderboard');
    if (!data.items?.length) {
      lbTable.innerHTML = '<tbody><tr><td>Ninguém minerou ainda.</td></tr></tbody>';
      return;
    }
    lbTable.innerHTML = '<tbody>' + data.items.map((r,i)=>`
      <tr>
        <td style="width:2ch">${i+1}º</td>
        <td>${escapeHtml(r.name)} — ${escapeHtml(r.school)}</td>
        <td style="text-align:right">${r.wins} bloco(s)</td>
      </tr>`).join('') + '</tbody>';
  }

  async function refreshChain() {
  const data = await jget('/api/blocks?limit=200');   // pega bastante e decide no front
  const all = data.items || [];
  const hidden = (!chainShowAll && all.length > MAX_VISIBLE_BLOCKS)
    ? all.length - MAX_VISIBLE_BLOCKS : 0;

  // só os últimos N quando compacto
  const items = hidden ? all.slice(-MAX_VISIBLE_BLOCKS) : all;

  // controle (mostrar todos/menos)
  const controlsHtml =
    (all.length > MAX_VISIBLE_BLOCKS)
      ? `<div class="controls">
           <button id="toggle-chain" class="btn link">
             ${chainShowAll ? `Mostrar só os últimos ${MAX_VISIBLE_BLOCKS}` : `Mostrar todos (${all.length})`}
           </button>
         </div>`
      : '';

  if (!items.length) { chainEl.textContent = 'Carregando...'; return; }

  // helper p/ abreviar hash
  const short = (h) => h ? `${h.slice(0,12)}…${h.slice(-8)}` : '—';

  chainEl.innerHTML = controlsHtml + items.map(b => {
    const mined = !!b.mined_at;
    const miner = mined
      ? `${escapeHtml(b.miner_name || '—')} (${escapeHtml(b.miner_school || '')})`
      : '— ()';
    const when  = mined ? b.mined_at : b.created_at;

    // resumo sempre visível
    const summary = [
      `<div class="title">Bloco #${b.id}</div>`,
      mined
        ? `<div class="row">⛏ ${miner}</div>
           <div class="row">✅ ${fmtDate(when)}</div>`
        : `<div class="row">⏳ aguardando minerador</div>
           <div class="row">🕒 ${fmtDate(when)}</div>`,
      `<div class="row">dificuldade: ${b.difficulty}</div>`
    ].join('');

    // detalhes que abrem no clique
    const details = [
      mined ? `<div class="row mono">nonce: ${b.nonce ?? '—'}</div>` : '',
      mined ? `<div class="row mono">hash: ${b.hash ?? '—'}</div>` : '',
      // “transação” ilustrativa
      mined
        ? `<div class="row">💸 tx: ${escapeHtml((b.miner_name||'Aluno'))} → Prog de Bolsas Insper (R$ ${(10 + (b.id%9))*3},00) • prev ${short(b.prev_hash)} • hash ${short(b.hash)}</div>`
        : '' 
    ].join('');

    return `
      <div class="block ${mined ? '' : 'open'}" data-id="${b.id}">
        ${summary}
        <div class="details">${details}</div>
        <div class="expand-hint">Clique para ${mined ? 'ver/fechar detalhes' : 'ver detalhes'}</div>
      </div>`;
  }).join('');

  // botão: mostrar todos/menos
  document.getElementById('toggle-chain')?.addEventListener('click', (e) => {
    e.stopPropagation();
    chainShowAll = !chainShowAll;
    refreshChain();
  });

  // accordion: abre/fecha detalhes por card
  chainEl.querySelectorAll('.block').forEach(card => {
    card.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });
  });
}

  async function loadCurrentOnce() {
    const data = await jget('/api/block/current');
    if (!data || data.type !== 'schulte') {
      puzzleType.textContent = '';
      puzzleHint.textContent = 'Erro ao carregar puzzle.';
      boardEl.innerHTML = '';
      if (btnSubmit) btnSubmit.disabled = true;
      return;
    }
    currentOpenBlockId = data.id;
    puzzleType.textContent = ` (schulte ${data.task.size}×${data.task.size})`;
    renderSchulte(data.task);
  }

  async function pollCurrentChanged() {
    try {
      const data = await jget('/api/block/current');
      if (!data || data.type !== 'schulte') return;
      if (currentOpenBlockId === null || data.id !== currentOpenBlockId) {
        currentOpenBlockId = data.id;
        puzzleType.textContent = ` (schulte ${data.task.size}×${data.task.size})`;
        renderSchulte(data.task);
      }
    } catch (e) {
      console.warn('poll puzzle failed', e);
    }
  }

  function renderSchulte(task) {
    const size = task.size;
    const grid = task.grid;

    schulte = { size, grid, picks: [], next: 1, total: size * size };

    boardEl.className = 'board schulte';
    boardEl.style.gridTemplateColumns = `repeat(${size}, minmax(58px, 72px))`;
    boardEl.innerHTML = '';

    if (btnSubmit) btnSubmit.disabled = true;
    statusEl.textContent = '';
    puzzleHint.textContent =
      `Clique os números em ordem: 1, 2, 3… (próximo: 1 • faltam ${schulte.total})`;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const btn = document.createElement('button');
        btn.className = 'cell';
        const val = Number(grid[r][c]);
        btn.textContent = val;
        btn.dataset.v = String(val);

        btn.addEventListener('click', () => {
          if (btn.disabled) return;

          const want = schulte.next;
          const got  = Number(btn.dataset.v);

          if (got !== want) {
            btn.classList.add('wrong');
            statusEl.textContent = `✖ Você clicou ${got}, mas o próximo é ${want}.`;
            setTimeout(() => btn.classList.remove('wrong'), 500);
            return;
          }

          schulte.picks.push({ r, c });
          schulte.next++;
          btn.textContent = '';
          btn.classList.remove('wrong');
          btn.classList.add('cleared');
          btn.disabled = true;

          const feitos = schulte.next - 1;
          const faltam = schulte.total - feitos;

          if (feitos === schulte.total) {
            puzzleHint.textContent = `Pronto! Clique em “Validar transação”.`;
            statusEl.textContent = '✔ Sequência completa. Pronto para validar.';
            if (btnSubmit) btnSubmit.disabled = false;
          } else {
            puzzleHint.textContent =
              `Clique os números em ordem: 1, 2, 3… (próximo: ${schulte.next} • faltam ${faltam})`;
          }
        });

        boardEl.appendChild(btn);
      }
    }
  }

  // ---- submissão (DEBOUNCE + mensagens do backend)
  let submitting = false;
  btnSubmit?.addEventListener('click', async () => {
    try {
      if (!schulte.size) return;

      const feitos = schulte.next - 1;
      if (feitos !== schulte.total) {
        statusEl.textContent = `✖ Ainda faltam ${schulte.total - feitos} números.`;
        return;
      }

      if (submitting) return; // debounce
      submitting = true;
      btnSubmit.disabled = true;
      statusEl.textContent = '⛏ validando…';

      const positions = schulte.picks.map(p => [p.r, p.c]);
      const res = await jpost('/api/block/submit', { positions });

      // o backend SEMPRE devolve {ok: bool, ...}
      if (!res.ok) {
        statusEl.textContent = res.reason
          ? `✖ ${res.reason}`
          : '✖ sequência incorreta';
        btnSubmit.disabled = false; // deixa tentar de novo
        submitting = false;
        return;
      }

      statusEl.textContent =
        `✔ Bloco minerado! nonce=${res.pow?.nonce} hash=${(res.pow?.hash || '').slice(0, 24)}…`;

      await Promise.all([
        refreshChain(),
        refreshLeaderboard()
      ]);
      await loadCurrentOnce();   // novo bloco/puzzle

      submitting = false;
    } catch (e) {
      console.error(e);
      statusEl.textContent = `✖ erro ao validar transação: ${e.message || e}`;
      btnSubmit.disabled = false;
      submitting = false;
    }
  });

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString(); }
    catch { return iso; }
  }
  function escapeHtml(s='') {
    return String(s)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  async function boot() {
    await Promise.all([
      refreshParticipants(),
      refreshLeaderboard(),
      refreshChain()
    ]);
    await loadCurrentOnce();

    setInterval(refreshParticipants, 5000);
    setInterval(refreshLeaderboard, 5000);
    setInterval(refreshChain, 5000);
    setInterval(pollCurrentChanged, 4000);
  }

  boot();
})();
