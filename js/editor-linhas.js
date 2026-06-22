// =============================================================
//  Editor de Linhas — atribui grampos de grade a "linhas" e
//  exporta um CSV renomeado (A1, A2, B1, ...).
//  Vista 2D frontal: eixo horizontal = direção principal do talude,
//  eixo vertical = elevação.
// =============================================================

const params = new URLSearchParams(window.location.search);
const csvFileURL = params.get('csv');
const nomeTalude = params.get('nome') || 'Talude';

const canvas = document.getElementById('editor-canvas');
const ctx = canvas.getContext('2d');

// --- Estado dos dados ---
let originalRows = [];   // todas as linhas do CSV (arrays de células), preservadas para exportar
let delimiter = ',';
let points = [];         // só os grampos de grade: { rowIndex, id, h, elev, lineIndex, name }
let exagero = 1.0;

// --- Estado da vista (mundo -> tela) ---
const view = { scale: 1, ox: 0, oy: 0 };

// --- Estado das linhas ---
let lines = [];          // { letra, color, points: [refs de points] }
let currentLineIndex = -1;
const PALETTE = ['#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#bfef45', '#fa64b4', '#469990', '#9A6324',
    '#800000', '#808000', '#000075', '#ff8c00', '#1e90ff', '#228B22', '#8b008b'];

// --- Interação ---
const HIT_PX = 9;
const LABEL_SCALE_MIN = 6; // mostra nomes quando bem aproximado (relativo, ajustado após fit)
let labelThreshold = Infinity;
let pointer = { down: false, panning: false, dragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0, downPoint: null, box: null };
let spaceDown = false;

const STORAGE_KEY = 'editor-linhas:' + (csvFileURL || 'sem-csv');

// =============================================================
//  Carregamento
// =============================================================
if (!csvFileURL) {
    showError('Nenhum projeto especificado. Selecione um talude no menu.');
} else {
    fetch(csvFileURL)
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
        .then(txt => { iniciar(txt); })
        .catch(err => {
            console.error('Falha ao carregar CSV:', err);
            showError('Não foi possível carregar os pontos (CSV).', csvFileURL);
        });
}

function showError(msg, detalhe) {
    const ls = document.getElementById('loading-screen');
    ls.classList.remove('hidden');
    ls.style.display = 'flex';
    ls.innerHTML = `<div style="font-size:42px;margin-bottom:14px;">⚠️</div>
        <div id="loading-text">${msg}</div>
        ${detalhe ? `<div style="font-size:12px;color:#888;margin-top:6px;word-break:break-all;">${detalhe}</div>` : ''}
        <a class="error-button" href="index.html">Voltar ao menu</a>`;
}

// Mesma classificação do visualizador: "grade" = tudo que não é
// DHP / ARR / CRVG / GF* / CRISTA-CR / VIGA.
function isGrade(id) {
    const u = id.toUpperCase();
    if (u.includes('DHP')) return false;
    if (u.includes('ARR')) return false;
    if (u.includes('CRVG')) return false;
    if (u.startsWith('GF')) return false;
    if (u.includes('CRISTA') || u.startsWith('CR')) return false;
    if (u.includes('VIGA')) return false;
    return true;
}

// Extrai coords conforme o formato (igual ao visualizador):
//  - >=7 colunas (TAB): ID,E,N,Elev,E,N,Elev -> usa o 2º conjunto (5-7)
//  - 5 colunas (vírgula): ID,E,Elev,N
function extrairCoords(parts) {
    if (parts.length >= 7) {
        return { e: parseFloat(parts[4]), n: parseFloat(parts[5]), elev: parseFloat(parts[6]) };
    }
    return { e: parseFloat(parts[1]), elev: parseFloat(parts[2]), n: parseFloat(parts[3]) };
}

function iniciar(csvText) {
    const linhasTxt = csvText.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');
    if (linhasTxt.length === 0) { showError('CSV vazio ou inválido.'); return; }
    delimiter = linhasTxt[0].includes('\t') ? '\t' : ',';
    originalRows = linhasTxt.map(l => l.split(delimiter).map(c => c.trim()));

    // Coleta os grampos de grade com coordenadas válidas.
    const brutos = [];
    originalRows.forEach((parts, rowIndex) => {
        if (parts.length < 4) return;
        const id = parts[0];
        if (!isGrade(id)) return;
        const c = extrairCoords(parts);
        if (Number.isNaN(c.e) || Number.isNaN(c.n) || Number.isNaN(c.elev)) return;
        brutos.push({ rowIndex, id, e: c.e, n: c.n, elev: c.elev });
    });

    if (brutos.length === 0) { showError('Nenhum grampo de grade encontrado neste CSV.'); return; }

    // Direção horizontal principal (PCA sobre E,N) para a "vista frontal".
    let mE = 0, mN = 0;
    brutos.forEach(p => { mE += p.e; mN += p.n; });
    mE /= brutos.length; mN /= brutos.length;
    let sxx = 0, syy = 0, sxy = 0;
    brutos.forEach(p => {
        const de = p.e - mE, dn = p.n - mN;
        sxx += de * de; syy += dn * dn; sxy += de * dn;
    });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang);

    points = brutos.map(p => ({
        rowIndex: p.rowIndex,
        id: p.id,
        h: (p.e - mE) * ux + (p.n - mN) * uy, // posição ao longo do eixo principal
        elev: p.elev,
        lineIndex: null,
        name: null,
    }));

    restaurarAutosave();
    resizeCanvas();
    fitView();
    atualizarPainelLinhas();
    atualizarStatus();
    draw();

    const ls = document.getElementById('loading-screen');
    ls.classList.add('hidden');
    setTimeout(() => { ls.style.display = 'none'; }, 400);

    document.getElementById('titulo-talude').textContent = 'Editor — ' + nomeTalude;
    sugerirProximaLetra();
}

// =============================================================
//  Projeção mundo <-> tela
// =============================================================
function worldX(p) { return p.h; }
function worldY(p) { return -p.elev * exagero; }
function toScreen(p) { return { x: worldX(p) * view.scale + view.ox, y: worldY(p) * view.scale + view.oy }; }

function fitView() {
    if (points.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    points.forEach(p => {
        const wx = worldX(p), wy = worldY(p);
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    });
    const margin = 80;
    const w = canvas.width, h = canvas.height;
    const sx = (w - 2 * margin) / Math.max(maxX - minX, 1e-6);
    const sy = (h - 2 * margin) / Math.max(maxY - minY, 1e-6);
    view.scale = Math.min(sx, sy);
    view.ox = (w - (minX + maxX) * view.scale) / 2;
    view.oy = (h - (minY + maxY) * view.scale) / 2;
    labelThreshold = view.scale * 2.2; // a partir de ~2x do zoom de enquadramento, mostra nomes
}

// =============================================================
//  Desenho
// =============================================================
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Segmentos das linhas
    lines.forEach((line, li) => {
        if (line.points.length < 2) return;
        ctx.beginPath();
        line.points.forEach((p, i) => {
            const s = toScreen(p);
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.strokeStyle = line.color;
        ctx.lineWidth = (li === currentLineIndex) ? 3 : 2;
        ctx.stroke();
    });

    // Pontos
    points.forEach(p => {
        const s = toScreen(p);
        const assigned = p.lineIndex != null;
        ctx.beginPath();
        ctx.arc(s.x, s.y, assigned ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = assigned ? lines[p.lineIndex].color : '#8a8a8a';
        ctx.fill();
        if (p.lineIndex === currentLineIndex && assigned) {
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
        }
    });

    // Nomes (quando aproximado)
    if (view.scale >= labelThreshold) {
        ctx.fillStyle = '#111';
        ctx.font = '11px sans-serif';
        points.forEach(p => {
            if (p.name) { const s = toScreen(p); ctx.fillText(p.name, s.x + 7, s.y - 7); }
        });
    }

    // Caixa de seleção
    if (pointer.box) {
        const b = pointer.box;
        ctx.strokeStyle = '#0a7d4b';
        ctx.fillStyle = 'rgba(10, 125, 75, 0.10)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
        const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
    }
}

// =============================================================
//  Linhas e atribuição
// =============================================================
function novaLinha() {
    const input = document.getElementById('input-letra');
    let letra = (input.value || '').trim().toUpperCase();
    if (!letra) { letra = proximaLetra(); }
    const line = { letra, color: PALETTE[lines.length % PALETTE.length], points: [] };
    lines.push(line);
    currentLineIndex = lines.length - 1;
    input.value = '';
    sugerirProximaLetra();
    atualizarPainelLinhas();
    draw();
}

function proximaLetra() {
    // Sugere a próxima letra do alfabeto que ainda não foi usada.
    const usadas = new Set(lines.map(l => l.letra));
    for (let c = 65; c <= 90; c++) {
        const L = String.fromCharCode(c);
        if (!usadas.has(L)) return L;
    }
    return 'L' + (lines.length + 1);
}
function sugerirProximaLetra() {
    document.getElementById('input-letra').placeholder = proximaLetra();
}

function renumerar(line) {
    line.points.forEach((p, i) => { p.name = line.letra + (i + 1); });
}
function renumerarTudo() { lines.forEach(renumerar); }

function adicionarPonto(p) {
    if (currentLineIndex < 0) {
        alert('Crie ou selecione uma linha primeiro.');
        return;
    }
    if (p.lineIndex === currentLineIndex) return; // já está nesta linha
    if (p.lineIndex != null) removerDeLinha(p); // move de outra linha
    const line = lines[currentLineIndex];
    line.points.push(p);
    p.lineIndex = currentLineIndex;
    renumerar(line);
}

function removerDeLinha(p) {
    if (p.lineIndex == null) return;
    const line = lines[p.lineIndex];
    const idx = line.points.indexOf(p);
    if (idx >= 0) line.points.splice(idx, 1);
    p.lineIndex = null;
    p.name = null;
    renumerar(line);
}

function clicarPonto(p) {
    if (currentLineIndex >= 0 && p.lineIndex === currentLineIndex) {
        removerDeLinha(p); // clicar de novo na linha atual remove
    } else {
        adicionarPonto(p);
    }
    posMudanca();
}

function selecionarCaixa(box) {
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); return; }
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
    const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
    const dentro = points.filter(p => {
        if (p.lineIndex != null) return false; // não rouba de outra linha
        const s = toScreen(p);
        return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    });
    // Ordena ao longo do eixo principal (horizontal) para numerar em sequência.
    dentro.sort((a, b) => a.h - b.h);
    const line = lines[currentLineIndex];
    dentro.forEach(p => { line.points.push(p); p.lineIndex = currentLineIndex; });
    renumerar(line);
    posMudanca();
}

function posMudanca() {
    atualizarPainelLinhas();
    atualizarStatus();
    salvarAutosave();
    draw();
}

// =============================================================
//  Painéis
// =============================================================
function atualizarPainelLinhas() {
    const cont = document.getElementById('lista-linhas');
    if (lines.length === 0) { cont.innerHTML = '<small>Nenhuma linha ainda.</small>'; return; }
    cont.innerHTML = '';
    lines.forEach((line, li) => {
        const div = document.createElement('div');
        div.className = 'linha-item' + (li === currentLineIndex ? ' ativa' : '');
        const nomes = line.points.map(p => p.name).join(', ') || '—';
        div.innerHTML = `
            <div class="linha-item-cabecalho">
                <span class="linha-cor" style="background:${line.color}"></span>
                <span class="linha-titulo">Linha ${line.letra}</span>
                <span class="linha-contagem">${line.points.length} grampos</span>
            </div>
            <div class="linha-nomes">${nomes}</div>
            <div class="linha-acoes">
                <button class="btn-mini btn-sel">Selecionar</button>
                <button class="btn-mini btn-ren">Renomear</button>
                <button class="btn-mini btn-del">Excluir</button>
            </div>`;
        div.querySelector('.btn-sel').addEventListener('click', () => { currentLineIndex = li; atualizarPainelLinhas(); draw(); });
        div.querySelector('.btn-ren').addEventListener('click', () => renomearLinha(li));
        div.querySelector('.btn-del').addEventListener('click', () => excluirLinha(li));
        cont.appendChild(div);
    });
}

function renomearLinha(li) {
    const nova = prompt('Nova letra da linha:', lines[li].letra);
    if (nova == null) return;
    const letra = nova.trim().toUpperCase();
    if (!letra) return;
    lines[li].letra = letra;
    renumerar(lines[li]);
    posMudanca();
}

function excluirLinha(li) {
    if (!confirm(`Excluir a linha ${lines[li].letra}? Os grampos voltam a ficar sem linha.`)) return;
    lines[li].points.forEach(p => { p.lineIndex = null; p.name = null; });
    lines.splice(li, 1);
    // Reindexa lineIndex dos pontos das linhas restantes.
    lines.forEach((line, idx) => line.points.forEach(p => { p.lineIndex = idx; }));
    if (currentLineIndex === li) currentLineIndex = -1;
    else if (currentLineIndex > li) currentLineIndex--;
    posMudanca();
}

function atualizarStatus() {
    const atribuidos = points.filter(p => p.lineIndex != null).length;
    document.getElementById('status-barra').innerHTML =
        `Grampos de grade: <b>${points.length}</b><br>` +
        `Atribuídos: <b>${atribuidos}</b> · Restantes: <b>${points.length - atribuidos}</b><br>` +
        `Linhas: <b>${lines.length}</b>`;
}

// =============================================================
//  Exportação
// =============================================================
function exportar() {
    const novoNome = {};
    lines.forEach(line => line.points.forEach(p => { novoNome[p.rowIndex] = p.name; }));

    const linhasOut = originalRows.map((parts, idx) => {
        const copia = parts.slice();
        if (novoNome[idx] != null) copia[0] = novoNome[idx];
        return copia.join(delimiter);
    });
    const conteudo = linhasOut.join('\r\n');

    const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const baseNome = (csvFileURL.split('/').pop() || 'pontos.csv').replace(/\.csv$/i, '');
    a.download = baseNome + '_renomeado.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

// =============================================================
//  Autosave (localStorage) — evita perder trabalho ao recarregar
// =============================================================
function salvarAutosave() {
    try {
        const dados = {
            lines: lines.map(l => ({ letra: l.letra, color: l.color, rows: l.points.map(p => p.rowIndex) })),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dados));
    } catch (e) { /* ignora */ }
}

function restaurarAutosave() {
    let dados;
    try { dados = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return; }
    if (!dados || !dados.lines) return;
    const porRow = {};
    points.forEach(p => { porRow[p.rowIndex] = p; });
    lines = dados.lines.map((l, li) => {
        const pts = (l.rows || []).map(r => porRow[r]).filter(Boolean);
        pts.forEach(p => { p.lineIndex = li; });
        const line = { letra: l.letra, color: l.color || PALETTE[li % PALETTE.length], points: pts };
        renumerar(line);
        return line;
    });
    if (lines.length > 0) currentLineIndex = lines.length - 1;
}

function limparTudo() {
    if (!confirm('Limpar todas as linhas? Esta ação não pode ser desfeita.')) return;
    points.forEach(p => { p.lineIndex = null; p.name = null; });
    lines = [];
    currentLineIndex = -1;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignora */ }
    sugerirProximaLetra();
    posMudanca();
}

// =============================================================
//  Interação (mouse / teclado)
// =============================================================
function pontoEm(mx, my) {
    let melhor = null, melhorD = HIT_PX * HIT_PX;
    points.forEach(p => {
        const s = toScreen(p);
        const dx = s.x - mx, dy = s.y - my;
        const d = dx * dx + dy * dy;
        if (d <= melhorD) { melhorD = d; melhor = p; }
    });
    return melhor;
}

canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    pointer.down = true;
    pointer.dragging = false;
    pointer.startX = mx; pointer.startY = my;
    pointer.lastX = mx; pointer.lastY = my;

    if (e.button === 1 || spaceDown) {
        pointer.panning = true;
        e.preventDefault();
        return;
    }
    pointer.downPoint = pontoEm(mx, my);
    pointer.box = null;
});

canvas.addEventListener('mousemove', (e) => {
    if (!pointer.down) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    if (pointer.panning) {
        view.ox += mx - pointer.lastX;
        view.oy += my - pointer.lastY;
        pointer.lastX = mx; pointer.lastY = my;
        draw();
        return;
    }

    const movido = Math.abs(mx - pointer.startX) + Math.abs(my - pointer.startY);
    if (movido > 4) pointer.dragging = true;
    if (pointer.dragging) {
        pointer.box = { x0: pointer.startX, y0: pointer.startY, x1: mx, y1: my };
        draw();
    }
});

window.addEventListener('mouseup', (e) => {
    if (!pointer.down) return;
    pointer.down = false;

    if (pointer.panning) { pointer.panning = false; return; }

    if (pointer.dragging && pointer.box) {
        selecionarCaixa(pointer.box);
        pointer.box = null;
    } else if (pointer.downPoint) {
        clicarPonto(pointer.downPoint);
    }
    pointer.downPoint = null;
    pointer.dragging = false;
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const fator = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const wx = (mx - view.ox) / view.scale;
    const wy = (my - view.oy) / view.scale;
    view.scale *= fator;
    view.ox = mx - wx * view.scale;
    view.oy = my - wy * view.scale;
    draw();
}, { passive: false });

window.addEventListener('keydown', (e) => { if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = 'crosshair'; } });

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

// --- Botões / controles ---
document.getElementById('btn-nova-linha').addEventListener('click', novaLinha);
document.getElementById('input-letra').addEventListener('keydown', (e) => { if (e.key === 'Enter') novaLinha(); });
document.getElementById('btn-enquadrar').addEventListener('click', () => { fitView(); draw(); });
document.getElementById('btn-exportar').addEventListener('click', exportar);
document.getElementById('btn-limpar').addEventListener('click', limparTudo);
document.getElementById('slider-exagero').addEventListener('input', (e) => {
    exagero = parseFloat(e.target.value);
    document.getElementById('valor-exagero').textContent = exagero.toFixed(1) + '×';
    fitView();
    draw();
});
