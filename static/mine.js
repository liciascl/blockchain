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
    const data = await jget('/api/blocks?limit=40');
    const items = data.items || [];
    if (!items.length) { chainEl.textContent = 'Carregando...'; return; }

    chainEl.innerHTML = items.map(b => {
      const mined = !!b.mined_at;
      const classes = `block ${mined ? '' : 'open'}`;
      const miner = mined ? `${escapeHtml(b.miner_name || '—')} (${escapeHtml(b.miner_school || '')})` : '— ()';
      const when  = mined ? b.mined_at : b.created_at;
      const lines = [];

      if (mined) {
        lines.push(`<div class="row">⛏ ${miner}</div>`);
        lines.push(`<div class="row">✅ ${fmtDate(when)}</div>`);
        lines.push(`<div class="row mono">nonce: ${b.nonce ?? '—'}</div>`);
        lines.push(`<div class="row mono">hash: ${b.hash ?? '—'}</div>`);
        lines.push(`<div class="row">dificuldade: ${b.difficulty}</div>`);
      } else {
        lines.push(`<div class="row">⏳ aguardando minerador</div>`);
        lines.push(`<div class="row">🕒 ${fmtDate(when)}</div>`);
        lines.push(`<div class="row">dificuldade: ${b.difficulty}</div>`);
      }

      return `
        <div class="${classes}">
          <div class="title">Bloco #${b.id}</div>
          ${lines.join('')}
        </div>`;
    }).join('');
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
