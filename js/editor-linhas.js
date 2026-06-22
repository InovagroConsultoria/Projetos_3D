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
let originalRows = [];   // todas as linhas do CSV (preservadas para exportar)
let delimiter = ',';
let points = [];         // grampos de grade: { rowIndex, id, h, elev, lineIndex, name, customName }
let exagero = 1.0;

// --- Vista (mundo -> tela) ---
const view = { scale: 1, ox: 0, oy: 0 };

// --- Linhas ---
let lines = [];          // { letra, color, inverted, points: [refs] }
let currentLineIndex = -1;
const PALETTE = ['#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#bfef45', '#fa64b4', '#469990', '#9A6324',
    '#800000', '#808000', '#000075', '#ff8c00', '#1e90ff', '#228B22', '#8b008b'];

// --- Interação ---
const HIT_PX = 9;
let labelThreshold = Infinity;
let selMode = 'sel';     // 'sel' (clique/caixa) ou 'contorno' (polígono)
let hoveredPoint = null;
let polygon = [];        // vértices do contorno em coords de mundo {wx, wy}
let pointer = { down: false, panning: false, dragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0, downPoint: null, box: null };
let spaceDown = false;

// --- Desfazer ---
const undoStack = [];
const UNDO_MAX = 60;

const STORAGE_KEY = 'editor-linhas:' + (csvFileURL || 'sem-csv');

// =============================================================
//  Carregamento
// =============================================================
if (!csvFileURL) {
    showError('Nenhum projeto especificado. Selecione um talude no menu.');
} else {
    fetch(csvFileURL)
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
        .then(txt => iniciar(txt))
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

// "Grade" = tudo que não é DHP / ARR / CRVG / GF* / CRISTA-CR / VIGA.
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

    // Eixo horizontal principal (PCA sobre E,N) para a vista frontal.
    let mE = 0, mN = 0;
    brutos.forEach(p => { mE += p.e; mN += p.n; });
    mE /= brutos.length; mN /= brutos.length;
    let sxx = 0, syy = 0, sxy = 0;
    brutos.forEach(p => { const de = p.e - mE, dn = p.n - mN; sxx += de * de; syy += dn * dn; sxy += de * dn; });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang);

    points = brutos.map(p => ({
        rowIndex: p.rowIndex, id: p.id,
        h: (p.e - mE) * ux + (p.n - mN) * uy,
        elev: p.elev,
        lineIndex: null, name: null, customName: null,
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
function telaParaMundo(mx, my) { return { wx: (mx - view.ox) / view.scale, wy: (my - view.oy) / view.scale }; }

function fitView() {
    if (points.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    points.forEach(p => {
        const wx = worldX(p), wy = worldY(p);
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    });
    const margin = 80;
    const sx = (canvas.width - 2 * margin) / Math.max(maxX - minX, 1e-6);
    const sy = (canvas.height - 2 * margin) / Math.max(maxY - minY, 1e-6);
    view.scale = Math.min(sx, sy);
    view.ox = (canvas.width - (minX + maxX) * view.scale) / 2;
    view.oy = (canvas.height - (minY + maxY) * view.scale) / 2;
    labelThreshold = view.scale * 2.2;
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
        points.forEach(p => { if (p.name) { const s = toScreen(p); ctx.fillText(p.name, s.x + 7, s.y - 7); } });
    }

    // Contorno (polígono) em construção
    if (selMode === 'contorno' && polygon.length > 0) {
        ctx.beginPath();
        polygon.forEach((v, i) => {
            const x = v.wx * view.scale + view.ox, y = v.wy * view.scale + view.oy;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#0a7d4b';
        ctx.fillStyle = 'rgba(10, 125, 75, 0.10)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        polygon.forEach(v => {
            const x = v.wx * view.scale + view.ox, y = v.wy * view.scale + view.oy;
            ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = '#0a7d4b'; ctx.fill();
        });
    }

    // Caixa de seleção
    if (pointer.box) {
        const b = pointer.box;
        ctx.strokeStyle = '#0a7d4b'; ctx.fillStyle = 'rgba(10, 125, 75, 0.10)'; ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
        ctx.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
        ctx.strokeRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
        ctx.setLineDash([]);
    }

    // Ponto sob o mouse (hover)
    if (hoveredPoint) {
        const s = toScreen(hoveredPoint);
        ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
        const rotulo = hoveredPoint.name || hoveredPoint.id;
        ctx.font = 'bold 12px sans-serif';
        const w = ctx.measureText(rotulo).width;
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(s.x + 10, s.y - 22, w + 10, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(rotulo, s.x + 15, s.y - 10);
    }
}

// =============================================================
//  Desfazer (snapshot do estado)
// =============================================================
function snapshot() {
    return JSON.stringify({
        cur: currentLineIndex,
        lines: lines.map(l => ({
            letra: l.letra, color: l.color, inverted: !!l.inverted,
            pts: l.points.map(p => ({ r: p.rowIndex, c: p.customName || null })),
        })),
    });
}
function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
}
function desfazer() {
    if (undoStack.length === 0) return;
    const s = undoStack.pop();
    const d = JSON.parse(s);
    points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    const byRow = {}; points.forEach(p => { byRow[p.rowIndex] = p; });
    lines = d.lines.map((l, li) => {
        const pts = l.pts.map(o => { const p = byRow[o.r]; if (p) { p.lineIndex = li; p.customName = o.c; } return p; }).filter(Boolean);
        const line = { letra: l.letra, color: l.color, inverted: l.inverted, points: pts };
        renumerar(line); // mantém a ordem salva
        return line;
    });
    currentLineIndex = (d.cur != null && d.cur < lines.length) ? d.cur : -1;
    atualizarPainelLinhas(); atualizarStatus(); salvarAutosave(); draw();
}

// =============================================================
//  Linhas, ordenação e numeração
// =============================================================
function novaLinha() {
    const input = document.getElementById('input-letra');
    let letra = (input.value || '').trim().toUpperCase();
    if (!letra) letra = proximaLetra();
    pushUndo();
    lines.push({ letra, color: PALETTE[lines.length % PALETTE.length], inverted: false, points: [] });
    currentLineIndex = lines.length - 1;
    input.value = '';
    sugerirProximaLetra();
    atualizarPainelLinhas(); salvarAutosave(); draw();
}

function proximaLetra() {
    const usadas = new Set(lines.map(l => l.letra));
    for (let c = 65; c <= 90; c++) { const L = String.fromCharCode(c); if (!usadas.has(L)) return L; }
    return 'L' + (lines.length + 1);
}
function sugerirProximaLetra() { document.getElementById('input-letra').placeholder = proximaLetra(); }

// Ordena os pontos da linha por proximidade (vizinho mais próximo),
// começando pela direita (maior h). Invertido começa pela esquerda.
function ordenarLinha(line) {
    const pts = line.points;
    if (pts.length <= 2) { if (line.inverted) pts.reverse(); return; }
    const restante = pts.slice();
    let ini = 0;
    for (let i = 1; i < restante.length; i++) {
        const maisDir = restante[i].h > restante[ini].h;
        if (line.inverted ? !maisDir && restante[i].h < restante[ini].h : maisDir) ini = i;
    }
    const ordenado = [restante.splice(ini, 1)[0]];
    while (restante.length) {
        const ult = ordenado[ordenado.length - 1];
        let best = 0, bestD = Infinity;
        for (let i = 0; i < restante.length; i++) {
            const dx = restante[i].h - ult.h, dy = restante[i].elev - ult.elev;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
        }
        ordenado.push(restante.splice(best, 1)[0]);
    }
    line.points = ordenado;
}

// Atribui os nomes: pontos com nome custom mantêm o custom e NÃO consomem
// número; os demais são numerados em sequência (1, 2, 3, ...).
function renumerar(line) {
    let contador = 1;
    line.points.forEach(p => {
        if (p.customName) { p.name = p.customName; }
        else { p.name = line.letra + contador; contador++; }
    });
}
function reordenarENumerar(line) { ordenarLinha(line); renumerar(line); }

function adicionarPonto(p) {
    if (p.lineIndex === currentLineIndex) return;
    if (p.lineIndex != null) removerDeLinhaSilencioso(p);
    const line = lines[currentLineIndex];
    line.points.push(p);
    p.lineIndex = currentLineIndex;
}
function removerDeLinhaSilencioso(p) {
    const line = lines[p.lineIndex];
    const idx = line.points.indexOf(p);
    if (idx >= 0) line.points.splice(idx, 1);
    p.lineIndex = null; p.name = null; p.customName = null;
    reordenarENumerar(line);
}

function clicarPonto(p) {
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); return; }
    pushUndo();
    if (p.lineIndex === currentLineIndex) {
        removerDeLinhaSilencioso(p);
    } else {
        adicionarPonto(p);
        reordenarENumerar(lines[currentLineIndex]);
    }
    posMudanca();
}

function selecionarCaixa(box) {
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); return; }
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
    const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
    const dentro = points.filter(p => {
        if (p.lineIndex != null) return false;
        const s = toScreen(p);
        return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    });
    if (dentro.length === 0) return;
    pushUndo();
    const line = lines[currentLineIndex];
    dentro.forEach(p => { line.points.push(p); p.lineIndex = currentLineIndex; });
    reordenarENumerar(line);
    posMudanca();
}

function pontoEmPoligono(p, poly) {
    const x = worldX(p), y = worldY(p);
    let dentro = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].wx, yi = poly[i].wy, xj = poly[j].wx, yj = poly[j].wy;
        const cruza = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (cruza) dentro = !dentro;
    }
    return dentro;
}
function selecionarPoligono() {
    if (polygon.length < 3) { polygon = []; draw(); return; }
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); polygon = []; draw(); return; }
    const dentro = points.filter(p => p.lineIndex == null && pontoEmPoligono(p, polygon));
    polygon = [];
    if (dentro.length === 0) { draw(); return; }
    pushUndo();
    const line = lines[currentLineIndex];
    dentro.forEach(p => { line.points.push(p); p.lineIndex = currentLineIndex; });
    reordenarENumerar(line);
    posMudanca();
}

function editarPonto(p) {
    if (p.lineIndex == null) { alert('Esse ponto ainda não está em nenhuma linha.'); return; }
    const atual = p.customName || p.name || '';
    const novo = prompt('Nome do ponto (deixe vazio para voltar ao automático):', atual);
    if (novo == null) return;
    pushUndo();
    p.customName = novo.trim() || null;
    renumerar(lines[p.lineIndex]);
    posMudanca();
}

function posMudanca() { atualizarPainelLinhas(); atualizarStatus(); salvarAutosave(); draw(); }

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
                <button class="btn-mini btn-inv" title="Inverter o sentido da numeração">Inverter</button>
                <button class="btn-mini btn-ren">Renomear</button>
                <button class="btn-mini btn-del">Excluir</button>
            </div>`;
        div.querySelector('.btn-sel').addEventListener('click', () => { currentLineIndex = li; atualizarPainelLinhas(); draw(); });
        div.querySelector('.btn-inv').addEventListener('click', () => inverterLinha(li));
        div.querySelector('.btn-ren').addEventListener('click', () => renomearLinha(li));
        div.querySelector('.btn-del').addEventListener('click', () => excluirLinha(li));
        cont.appendChild(div);
    });
}

function inverterLinha(li) {
    pushUndo();
    lines[li].inverted = !lines[li].inverted;
    reordenarENumerar(lines[li]);
    posMudanca();
}
function renomearLinha(li) {
    const nova = prompt('Nova letra da linha:', lines[li].letra);
    if (nova == null) return;
    const letra = nova.trim().toUpperCase();
    if (!letra) return;
    pushUndo();
    lines[li].letra = letra;
    renumerar(lines[li]);
    posMudanca();
}
function excluirLinha(li) {
    if (!confirm(`Excluir a linha ${lines[li].letra}? Os grampos voltam a ficar sem linha.`)) return;
    pushUndo();
    lines[li].points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    lines.splice(li, 1);
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
    const blob = new Blob([linhasOut.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const baseNome = (csvFileURL.split('/').pop() || 'pontos.csv').replace(/\.csv$/i, '');
    a.download = baseNome + '_renomeado.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
}

// =============================================================
//  Autosave
// =============================================================
function salvarAutosave() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            lines: lines.map(l => ({
                letra: l.letra, color: l.color, inverted: !!l.inverted,
                pts: l.points.map(p => ({ r: p.rowIndex, c: p.customName || null })),
            })),
        }));
    } catch (e) { /* ignora */ }
}
function restaurarAutosave() {
    let dados;
    try { dados = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return; }
    if (!dados || !dados.lines) return;
    const byRow = {}; points.forEach(p => { byRow[p.rowIndex] = p; });
    lines = dados.lines.map((l, li) => {
        const pts = (l.pts || l.rows || []).map(o => {
            const r = (typeof o === 'object') ? o.r : o;
            const c = (typeof o === 'object') ? o.c : null;
            const p = byRow[r]; if (p) { p.lineIndex = li; p.customName = c; } return p;
        }).filter(Boolean);
        const line = { letra: l.letra, color: l.color || PALETTE[li % PALETTE.length], inverted: !!l.inverted, points: pts };
        renumerar(line);
        return line;
    });
    if (lines.length > 0) currentLineIndex = lines.length - 1;
}
function limparTudo() {
    if (!confirm('Limpar todas as linhas? Esta ação não pode ser desfeita.')) return;
    pushUndo();
    points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    lines = []; currentLineIndex = -1;
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
        const dx = s.x - mx, dy = s.y - my, d = dx * dx + dy * dy;
        if (d <= melhorD) { melhorD = d; melhor = p; }
    });
    return melhor;
}

canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    pointer.down = true; pointer.dragging = false;
    pointer.startX = mx; pointer.startY = my; pointer.lastX = mx; pointer.lastY = my;

    // Pan: botão do meio, Espaço ou Ctrl + arrastar
    if (e.button === 1 || spaceDown || e.ctrlKey) { pointer.panning = true; e.preventDefault(); return; }

    if (e.button === 0 && selMode === 'contorno') {
        const w = telaParaMundo(mx, my);
        polygon.push(w);
        draw();
        return;
    }
    pointer.downPoint = pontoEm(mx, my);
    pointer.box = null;
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    if (pointer.down && pointer.panning) {
        view.ox += mx - pointer.lastX; view.oy += my - pointer.lastY;
        pointer.lastX = mx; pointer.lastY = my; draw(); return;
    }
    if (pointer.down && selMode === 'sel') {
        const movido = Math.abs(mx - pointer.startX) + Math.abs(my - pointer.startY);
        if (movido > 4) pointer.dragging = true;
        if (pointer.dragging) { pointer.box = { x0: pointer.startX, y0: pointer.startY, x1: mx, y1: my }; draw(); return; }
    }
    // Hover (quando não está arrastando)
    if (!pointer.down) {
        const h = pontoEm(mx, my);
        if (h !== hoveredPoint) { hoveredPoint = h; canvas.style.cursor = h ? 'pointer' : (selMode === 'contorno' ? 'crosshair' : 'crosshair'); draw(); }
    }
});

window.addEventListener('mouseup', () => {
    if (!pointer.down) return;
    pointer.down = false;
    if (pointer.panning) { pointer.panning = false; return; }
    if (selMode === 'sel') {
        if (pointer.dragging && pointer.box) { selecionarCaixa(pointer.box); pointer.box = null; }
        else if (pointer.downPoint) { clicarPonto(pointer.downPoint); }
    }
    pointer.downPoint = null; pointer.dragging = false;
});

// Duplo clique fecha o contorno
canvas.addEventListener('dblclick', (e) => {
    if (selMode === 'contorno') { e.preventDefault(); selecionarPoligono(); }
});

// Clique direito edita o nome do ponto
canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const p = pontoEm(e.clientX - rect.left, e.clientY - rect.top);
    if (p) editarPonto(p);
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const fator = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const w = telaParaMundo(mx, my);
    view.scale *= fator;
    view.ox = mx - w.wx * view.scale; view.oy = my - w.wy * view.scale;
    draw();
}, { passive: false });

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); desfazer(); }
    if (e.key === 'Escape' && selMode === 'contorno') { polygon = []; draw(); }
    if (e.key === 'Enter' && selMode === 'contorno') { selecionarPoligono(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = 'crosshair'; } });

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

// =============================================================
//  Controles / botões
// =============================================================
function setModo(modo) {
    selMode = modo;
    polygon = [];
    document.getElementById('btn-modo-sel').classList.toggle('ativo', modo === 'sel');
    document.getElementById('btn-modo-contorno').classList.toggle('ativo', modo === 'contorno');
    draw();
}
document.getElementById('btn-modo-sel').addEventListener('click', () => setModo('sel'));
document.getElementById('btn-modo-contorno').addEventListener('click', () => setModo('contorno'));
document.getElementById('btn-desfazer').addEventListener('click', desfazer);
document.getElementById('btn-nova-linha').addEventListener('click', novaLinha);
document.getElementById('input-letra').addEventListener('keydown', (e) => { if (e.key === 'Enter') novaLinha(); });
document.getElementById('btn-enquadrar').addEventListener('click', () => { fitView(); draw(); });
document.getElementById('btn-exportar').addEventListener('click', exportar);
document.getElementById('btn-limpar').addEventListener('click', limparTudo);
document.getElementById('slider-exagero').addEventListener('input', (e) => {
    exagero = parseFloat(e.target.value);
    document.getElementById('valor-exagero').textContent = exagero.toFixed(1) + '×';
    fitView(); draw();
});
