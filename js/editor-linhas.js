// =============================================================
//  Editor de Linhas — atribui pontos a "linhas", renomeia e
//  exporta CSV renomeado + PDF (desenho, nomes e contagens).
//  Vista 2D frontal: eixo horizontal = direção principal do talude,
//  eixo vertical = elevação.
// =============================================================

const params = new URLSearchParams(window.location.search);
const csvFileURL = params.get('csv');
const nomeTalude = params.get('nome') || 'Talude';

const canvas = document.getElementById('editor-canvas');
const ctx = canvas.getContext('2d');

// Categorias (mesmas cores do visualizador 3D).
const CATS = [
    { key: 'dhp', label: 'DHP', color: '#0000ff' },
    { key: 'arr', label: 'Arrancamento (ARR)', color: '#ffff00' },
    { key: 'crista', label: 'CRISTA', color: '#800080' },
    { key: 'viga', label: 'Viga', color: '#808080' },
    { key: 'crvg', label: 'Grampos Crista de Viga', color: '#ff8c00' },
    { key: 'grampofech', label: 'Grampo de Fechamento', color: '#00ff00' },
    { key: 'outros', label: 'Grampos (grade)', color: '#9aa0a6' },
];
const CAT_COLOR = {}; const CAT_LABEL = {};
CATS.forEach(c => { CAT_COLOR[c.key] = c.color; CAT_LABEL[c.key] = c.label; });

// --- Dados ---
let originalRows = [];
let delimiter = ',';
let points = [];         // { rowIndex, id, cat, e, n, hPCA, h, elev, lineIndex, name, customName }
let mE = 0, mN = 0;      // centro (média) de E/N — usado nas projeções
let exagero = 1.0;
let showNames = false;
let rotularTodos = false; // ao gerar o PDF: rotula todos os grampos (nome ou id do CSV)
let nameAngle = 0;       // ângulo dos rótulos em graus (0 = horizontal) — evita sobreposição
let nameSize = 11;       // tamanho da fonte dos rótulos (px)
let flipH = false;       // espelha a vista na horizontal (talude visto de trás)
let enabledCats = new Set(['outros']); // por padrão só os grampos de grade

// --- Vista ---
const view = { scale: 1, ox: 0, oy: 0 };
let topView = false;     // vista de topo (plano E×N) — para desenhar o eixo-guia

// --- Eixo-guia (curva que "desenrola" taludes curvos por estaqueamento) ---
let guide = [];          // vértices em coordenadas reais {e, n}
let addingGuide = false; // modo de desenho do eixo-guia (na vista de topo)
let guiaPts = [];        // vértices do eixo-guia em construção {e, n}

// --- Linhas ---
let lines = [];
let currentLineIndex = -1;

// --- Divisórias (polilinhas pontilhadas que dividem o talude em seções) ---
// Guardadas em espaço de dados (h, elev) para serem estáveis a flip/exagero.
let dividers = [];          // { name, pts: [{h, elev}, ...] }
let addingDivider = false;  // modo de inserção ativo
let diviPts = [];           // vértices da divisória em construção {h, elev}
let diviMouse = null;       // posição do mouse em tela (preview)
let draggingVertex = null;  // arrastando vértice de divisória pronta {di, vi, moved}
const VERT_HIT_PX = 10;
const PALETTE = ['#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#bfef45', '#fa64b4', '#469990', '#9A6324',
    '#800000', '#808000', '#000075', '#ff8c00', '#1e90ff', '#228B22', '#8b008b'];

// --- Interação ---
const HIT_PX = 9;
let labelThreshold = Infinity;
let hoveredPoint = null;
let lasso = null;        // contorno livre (arrastando): array de {wx, wy}
let boxArmed = null;     // 1º canto da caixa em coords de mundo {wx, wy}
let boxPreview = null;   // {x0,y0,x1,y1} em tela, para desenhar
let pointer = { down: false, panning: false, dragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0, downPoint: null };
let spaceDown = false;

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
        .catch(err => { console.error('Falha ao carregar CSV:', err); showError('Não foi possível carregar os pontos (CSV).', csvFileURL); });
}

function showError(msg, detalhe) {
    const ls = document.getElementById('loading-screen');
    ls.classList.remove('hidden'); ls.style.display = 'flex';
    ls.innerHTML = `<div style="font-size:42px;margin-bottom:14px;">⚠️</div>
        <div id="loading-text">${msg}</div>
        ${detalhe ? `<div style="font-size:12px;color:#888;margin-top:6px;word-break:break-all;">${detalhe}</div>` : ''}
        <a class="error-button" href="index.html">Voltar ao menu</a>`;
}

function categoriaDe(id) {
    const u = id.toUpperCase();
    if (u.includes('DHP')) return 'dhp';
    if (u.includes('ARR')) return 'arr';
    if (u.includes('CRVG')) return 'crvg';
    if (u.startsWith('GF')) return 'grampofech';
    if (u.includes('CRISTA') || u.startsWith('CR')) return 'crista';
    if (u.includes('VIGA')) return 'viga';
    return 'outros';
}
// Categorias de grampos que pertencem a "linhas" (grade e fechamento).
const CATS_LINHA = new Set(['outros', 'grampofech']);
// Deriva a letra/chave da linha a partir do nome do grampo no CSV.
//  - Fechamento (GF*): a 3ª letra é a linha → "GFA-01" → "GFA".
//  - Grade: prefixo de letras antes do número → "A1", "A-12", "AB 3" → "A"/"AB".
//  - Sem padrão reconhecível (ex.: nome só numérico) → null.
function chaveLinha(p) {
    if (!CATS_LINHA.has(p.cat)) return null;
    const u = (p.id || '').toUpperCase().trim();
    if (p.cat === 'grampofech') {
        return (u.length >= 3 && /[A-Z]/.test(u[2])) ? 'GF' + u[2] : null;
    }
    // Grade: prefixo curto (1–2 letras) seguido de número. Nomes longos
    // como "POINT 1" não são linhas → ficam como "sem nome".
    const m = u.match(/^([A-Z]{1,2})\s*-?\s*\d/);
    return m ? m[1] : null;
}
function extrairCoords(parts) {
    if (parts.length >= 7) return { e: parseFloat(parts[4]), n: parseFloat(parts[5]), elev: parseFloat(parts[6]) };
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
        const c = extrairCoords(parts);
        if (Number.isNaN(c.e) || Number.isNaN(c.n) || Number.isNaN(c.elev)) return;
        brutos.push({ rowIndex, id, cat: categoriaDe(id), e: c.e, n: c.n, elev: c.elev });
    });
    if (brutos.length === 0) { showError('Nenhum ponto válido neste CSV.'); return; }

    // Eixo horizontal principal (PCA sobre E,N).
    mE = 0; mN = 0; brutos.forEach(p => { mE += p.e; mN += p.n; }); mE /= brutos.length; mN /= brutos.length;
    let sxx = 0, syy = 0, sxy = 0;
    brutos.forEach(p => { const de = p.e - mE, dn = p.n - mN; sxx += de * de; syy += dn * dn; sxy += de * dn; });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang), uy = Math.sin(ang);

    points = brutos.map(p => {
        const hPCA = (p.e - mE) * ux + (p.n - mN) * uy;
        return {
            rowIndex: p.rowIndex, id: p.id, cat: p.cat, e: p.e, n: p.n,
            hPCA, h: hPCA, elev: p.elev,
            lineIndex: null, name: null, customName: null,
        };
    });

    montarFiltroCategorias();
    atualizarAvisoSemNome();
    restaurarAutosave();
    aplicarGuia(); // se houver eixo-guia salvo, reprojeta por estaqueamento
    resizeCanvas();
    fitView();
    atualizarPainelLinhas(); atualizarPainelDivisorias(); atualizarPainelGuia(); atualizarStatus(); draw();

    const ls = document.getElementById('loading-screen');
    ls.classList.add('hidden'); setTimeout(() => { ls.style.display = 'none'; }, 400);
    document.getElementById('titulo-talude').textContent = 'Editor — ' + nomeTalude;
    sugerirProximaLetra();
}

// =============================================================
//  Projeção
// =============================================================
function worldX(p) { return topView ? (p.e - mE) : (flipH ? -p.h : p.h); }
function worldY(p) { return topView ? -(p.n - mN) : -p.elev * exagero; }
function toScreen(p) { return { x: worldX(p) * view.scale + view.ox, y: worldY(p) * view.scale + view.oy }; }
function telaParaMundo(mx, my) { return { wx: (mx - view.ox) / view.scale, wy: (my - view.oy) / view.scale }; }
function catVisivel(p) { return enabledCats.has(p.cat); }

// --- Vista de topo / eixo-guia ---
// (E, N) reais -> tela (na vista de topo).
function enParaTela(e, n) { return { x: (e - mE) * view.scale + view.ox, y: -(n - mN) * view.scale + view.oy }; }
// Mouse (tela) -> (E, N) reais (na vista de topo).
function telaParaEN(mx, my) { const w = telaParaMundo(mx, my); return { e: w.wx + mE, n: mN - w.wy }; }
// Estaqueamento: distância ao longo do eixo-guia até a projeção do ponto.
function chainage(e, n) {
    if (guide.length < 2) return 0;
    let bestD = Infinity, bestS = 0, acc = 0;
    for (let i = 0; i < guide.length - 1; i++) {
        const a = guide[i], b = guide[i + 1];
        const abe = b.e - a.e, abn = b.n - a.n, len2 = abe * abe + abn * abn, len = Math.sqrt(len2);
        let t = len2 > 0 ? ((e - a.e) * abe + (n - a.n) * abn) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = a.e + t * abe, pn = a.n + t * abn, dx = e - px, dn = n - pn, d = dx * dx + dn * dn;
        if (d < bestD) { bestD = d; bestS = acc + len * t; }
        acc += len;
    }
    return bestS;
}
// Recalcula a coordenada horizontal (h) de cada ponto: estaqueamento se houver
// eixo-guia, senão o PCA original. Reordena/renumera as linhas.
function aplicarGuia() {
    const usar = guide.length >= 2;
    points.forEach(p => { p.h = usar ? chainage(p.e, p.n) : p.hPCA; });
    lines.forEach(reordenarENumerar);
}

// Divisórias: (h, elev) -> tela (respeita flip e exagero, igual aos pontos).
function divParaTela(h, elev) {
    const wx = flipH ? -h : h, wy = -elev * exagero;
    return { x: wx * view.scale + view.ox, y: wy * view.scale + view.oy };
}
// Mouse (tela) -> dados (h, elev), desfazendo flip e exagero.
function telaParaDados(mx, my) {
    const w = telaParaMundo(mx, my);
    return { h: flipH ? -w.wx : w.wx, elev: -w.wy / exagero };
}
// Os segmentos AB e CD se cruzam? (em qualquer espaço afim — usamos (h, elev)).
function segmentosCruzam(a, b, c, d) {
    const ccw = (p, q, r) => (r.y - p.y) * (q.x - p.x) > (q.y - p.y) * (r.x - p.x);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}
// O trecho entre dois pontos da linha cruza alguma divisória (qualquer segmento dela)?
function cruzaDivisoria(p1, p2) {
    const A = { x: p1.h, y: p1.elev }, B = { x: p2.h, y: p2.elev };
    for (const d of dividers) {
        const v = d.pts;
        for (let i = 0; i < v.length - 1; i++) {
            if (segmentosCruzam(A, B, { x: v[i].h, y: v[i].elev }, { x: v[i + 1].h, y: v[i + 1].elev })) return true;
        }
    }
    return false;
}
// Normaliza divisórias vindas do storage/undo (compatível com o formato antigo de segmento).
function normalizarDivisorias(arr) {
    return (arr || []).map(d => {
        if (Array.isArray(d.pts)) return { name: d.name, pts: d.pts.map(p => ({ h: p.h, elev: p.elev })) };
        return { name: d.name, pts: [{ h: d.h1, elev: d.elev1 }, { h: d.h2, elev: d.elev2 }] };
    });
}
// Vértice de divisória pronta sob o cursor (tela) -> {di, vi} ou null.
function verticeEm(mx, my) {
    let melhor = null, melhorD = VERT_HIT_PX * VERT_HIT_PX;
    dividers.forEach((d, di) => d.pts.forEach((p, vi) => {
        const s = divParaTela(p.h, p.elev); const dx = s.x - mx, dy = s.y - my, dist = dx * dx + dy * dy;
        if (dist <= melhorD) { melhorD = dist; melhor = { di, vi }; }
    }));
    return melhor;
}

function fitView() {
    if (points.length === 0) return;
    const vis = points.filter(catVisivel);
    const alvo = vis.length ? vis : points;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    alvo.forEach(p => { const wx = worldX(p), wy = worldY(p); if (wx < minX) minX = wx; if (wx > maxX) maxX = wx; if (wy < minY) minY = wy; if (wy > maxY) maxY = wy; });
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

    // Polilinhas das linhas (sempre)
    lines.forEach((line, li) => {
        if (line.points.length < 2) return;
        ctx.beginPath();
        line.points.forEach((p, i) => { const s = toScreen(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
        ctx.strokeStyle = line.color; ctx.lineWidth = (li === currentLineIndex) ? 3 : 2; ctx.stroke();
    });

    // Pontos (dot só se a categoria estiver visível)
    points.forEach(p => {
        if (!catVisivel(p)) return;
        const s = toScreen(p);
        const assigned = p.lineIndex != null;
        ctx.beginPath();
        ctx.arc(s.x, s.y, assigned ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = assigned ? lines[p.lineIndex].color : CAT_COLOR[p.cat];
        ctx.fill();
        if (p.lineIndex === currentLineIndex && assigned) { ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke(); }
    });

    // Nomes — no PDF (rotularTodos) mostra todos: nome renomeado/linha ou, na falta, o nome original do CSV.
    const mostrar = showNames || rotularTodos || view.scale >= labelThreshold;
    if (mostrar) {
        ctx.fillStyle = '#111'; ctx.font = nameSize + 'px sans-serif';
        const rad = nameAngle * Math.PI / 180;
        points.forEach(p => {
            if (!catVisivel(p)) return;
            const rotulo = p.name || (rotularTodos ? p.id : null);
            if (!rotulo) return;
            const s = toScreen(p);
            if (rad === 0) { ctx.fillText(rotulo, s.x + 7, s.y - 7); }
            else { ctx.save(); ctx.translate(s.x + 5, s.y - 5); ctx.rotate(-rad); ctx.fillText(rotulo, 0, 0); ctx.restore(); }
        });
    }

    // Contorno livre (lasso)
    if (lasso && lasso.length > 1) {
        ctx.beginPath();
        lasso.forEach((v, i) => { const x = v.wx * view.scale + view.ox, y = v.wy * view.scale + view.oy; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.closePath();
        ctx.strokeStyle = '#0a7d4b'; ctx.fillStyle = 'rgba(10,125,75,0.10)'; ctx.lineWidth = 1.5;
        ctx.fill(); ctx.stroke();
    }
    // Caixa (2 cliques)
    if (boxPreview) {
        const b = boxPreview;
        ctx.strokeStyle = '#0a7d4b'; ctx.fillStyle = 'rgba(10,125,75,0.10)'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
        const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
        ctx.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
        ctx.strokeRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
        ctx.setLineDash([]);
    }
    // Divisórias só na vista frontal (são definidas no espaço h×elev).
    if (!topView) {
        dividers.forEach(d => {
            const tela = d.pts.map(p => divParaTela(p.h, p.elev));
            if (tela.length < 2) return;
            ctx.setLineDash([9, 6]); ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
            ctx.beginPath(); tela.forEach((s, i) => i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)); ctx.stroke();
            ctx.setLineDash([]);
            tela.forEach(s => { ctx.beginPath(); ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5; ctx.stroke(); });
            if (d.name) {
                const pe = tela.reduce((a, b) => b.y > a.y ? b : a); // pé = vértice mais baixo na tela
                ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
                const w = ctx.measureText(d.name).width;
                ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(pe.x - w / 2 - 4, pe.y + 6, w + 8, 18);
                ctx.fillStyle = '#222'; ctx.fillText(d.name, pe.x, pe.y + 19);
                ctx.textAlign = 'left';
            }
        });
        if (addingDivider && diviPts.length) {
            const tela = diviPts.map(p => divParaTela(p.h, p.elev));
            ctx.setLineDash([9, 6]); ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2;
            ctx.beginPath(); tela.forEach((s, i) => i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y));
            if (diviMouse) ctx.lineTo(diviMouse.x, diviMouse.y);
            ctx.stroke(); ctx.setLineDash([]);
            tela.forEach(s => { ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#c0392b'; ctx.fill(); });
        }
    }

    // Eixo-guia só na vista de topo.
    if (topView) {
        if (guide.length >= 2) {
            const tela = guide.map(g => enParaTela(g.e, g.n));
            ctx.strokeStyle = '#0a7d4b'; ctx.lineWidth = 3;
            ctx.beginPath(); tela.forEach((s, i) => i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)); ctx.stroke();
            tela.forEach((s, i) => { ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fillStyle = i === 0 ? '#0a7d4b' : '#fff'; ctx.fill(); ctx.strokeStyle = '#0a7d4b'; ctx.lineWidth = 2; ctx.stroke(); });
            // marca o início (estaca 0)
            ctx.fillStyle = '#0a7d4b'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('início', tela[0].x + 8, tela[0].y - 8);
        }
        if (addingGuide && guiaPts.length) {
            const tela = guiaPts.map(g => enParaTela(g.e, g.n));
            ctx.strokeStyle = '#0a7d4b'; ctx.lineWidth = 3;
            ctx.beginPath(); tela.forEach((s, i) => i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y));
            if (diviMouse) ctx.lineTo(diviMouse.x, diviMouse.y);
            ctx.stroke();
            tela.forEach(s => { ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#0a7d4b'; ctx.fill(); });
        }
    }

    // Hover
    if (hoveredPoint && catVisivel(hoveredPoint)) {
        const s = toScreen(hoveredPoint);
        ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
        const rotulo = hoveredPoint.name || hoveredPoint.id;
        ctx.font = 'bold 12px sans-serif';
        const w = ctx.measureText(rotulo).width;
        ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(s.x + 10, s.y - 22, w + 10, 16);
        ctx.fillStyle = '#fff'; ctx.fillText(rotulo, s.x + 15, s.y - 10);
    }
}

// =============================================================
//  Desfazer
// =============================================================
function snapshot() {
    return JSON.stringify({ cur: currentLineIndex, dividers, guide, lines: lines.map(l => ({ letra: l.letra, color: l.color, inverted: !!l.inverted, pts: l.points.map(p => ({ r: p.rowIndex, c: p.customName || null })) })) });
}
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > UNDO_MAX) undoStack.shift(); }
function desfazer() {
    if (undoStack.length === 0) return;
    const d = JSON.parse(undoStack.pop());
    points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    dividers = normalizarDivisorias(d.dividers);
    guide = Array.isArray(d.guide) ? d.guide : [];
    points.forEach(p => { p.h = guide.length >= 2 ? chainage(p.e, p.n) : p.hPCA; });
    const byRow = {}; points.forEach(p => { byRow[p.rowIndex] = p; });
    lines = d.lines.map((l, li) => {
        const pts = l.pts.map(o => { const p = byRow[o.r]; if (p) { p.lineIndex = li; p.customName = o.c; } return p; }).filter(Boolean);
        const line = { letra: l.letra, color: l.color, inverted: l.inverted, points: pts }; renumerar(line); return line;
    });
    currentLineIndex = (d.cur != null && d.cur < lines.length) ? d.cur : -1;
    atualizarPainelLinhas(); atualizarPainelDivisorias(); atualizarPainelGuia(); atualizarStatus(); salvarAutosave(); draw();
}

// =============================================================
//  Linhas, ordenação, numeração
// =============================================================
function novaLinha() {
    const input = document.getElementById('input-letra');
    let letra = (input.value || '').trim().toUpperCase(); if (!letra) letra = proximaLetra();
    pushUndo();
    lines.push({ letra, color: PALETTE[lines.length % PALETTE.length], inverted: false, points: [] });
    currentLineIndex = lines.length - 1; input.value = ''; sugerirProximaLetra();
    atualizarPainelLinhas(); salvarAutosave(); draw();
}
// Quantos grampos (grade/fechamento) estão sem nome de linha no CSV.
function gramposSemNome() {
    return points.filter(p => CATS_LINHA.has(p.cat) && !chaveLinha(p));
}
// Mostra/esconde o aviso de grampos sem nomenclatura.
function atualizarAvisoSemNome() {
    const box = document.getElementById('aviso-sem-nome');
    const alvo = points.filter(p => CATS_LINHA.has(p.cat));
    const sem = gramposSemNome();
    if (alvo.length > 0 && sem.length === alvo.length) {
        box.textContent = '⚠️ Os grampos deste CSV estão sem nome de linha. Não há como detectar linhas automaticamente — crie-as manualmente.';
        box.classList.remove('hidden');
    } else if (sem.length > 0) {
        box.textContent = `⚠️ ${sem.length} grampo(s) sem nome de linha — não entram na detecção automática.`;
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
    }
}

// Agrupa os grampos em linhas a partir dos nomes do CSV original.
function detectarLinhas() {
    const alvo = points.filter(p => CATS_LINHA.has(p.cat));
    if (alvo.length === 0) { alert('Não há grampos de grade ou de fechamento neste CSV.'); return; }
    const comNome = alvo.filter(p => chaveLinha(p));
    const semNome = alvo.length - comNome.length;
    if (comNome.length === 0) {
        alert('Os grampos deste CSV estão sem nomenclatura de linha (ex.: nomes só numéricos).\n\nNão é possível detectar linhas automaticamente — crie as linhas manualmente.');
        return;
    }
    let msg = 'Detectar linhas pelos nomes do CSV?\n\nIsto substituirá todas as linhas atuais.';
    if (semNome > 0) msg += `\n\n⚠️ ${semNome} grampo(s) sem nome ficarão de fora.`;
    if (!confirm(msg)) return;

    pushUndo();
    points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    lines = [];
    const grupos = {};
    comNome.forEach(p => { const k = chaveLinha(p); (grupos[k] = grupos[k] || []).push(p); });
    Object.keys(grupos).sort().forEach(k => {
        const li = lines.length;
        const line = { letra: k, color: PALETTE[li % PALETTE.length], inverted: false, points: grupos[k] };
        grupos[k].forEach(p => { p.lineIndex = li; enabledCats.add(p.cat); });
        lines.push(line); reordenarENumerar(line);
    });
    currentLineIndex = lines.length ? 0 : -1;
    montarFiltroCategorias(); sugerirProximaLetra(); posMudanca();
    alert(`${lines.length} linha(s) detectada(s) a partir do CSV.` + (semNome > 0 ? `\n${semNome} grampo(s) sem nome ficaram de fora.` : ''));
}

function proximaLetra() {
    const usadas = new Set(lines.map(l => l.letra));
    for (let c = 65; c <= 90; c++) { const L = String.fromCharCode(c); if (!usadas.has(L)) return L; }
    return 'L' + (lines.length + 1);
}
function sugerirProximaLetra() { document.getElementById('input-letra').placeholder = proximaLetra(); }

function ordenarLinha(line) {
    const pts = line.points;
    if (pts.length <= 2) { if (line.inverted) pts.reverse(); return; }
    const restante = pts.slice();
    let ini = 0;
    for (let i = 1; i < restante.length; i++) {
        if (line.inverted ? worldX(restante[i]) < worldX(restante[ini]) : worldX(restante[i]) > worldX(restante[ini])) ini = i;
    }
    const ordenado = [restante.splice(ini, 1)[0]];
    while (restante.length) {
        const ult = ordenado[ordenado.length - 1]; let best = 0, bestD = Infinity;
        for (let i = 0; i < restante.length; i++) { const dx = restante[i].h - ult.h, dy = restante[i].elev - ult.elev, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = i; } }
        ordenado.push(restante.splice(best, 1)[0]);
    }
    line.points = ordenado;
}
function renumerar(line) {
    let contador = 1, prev = null;
    line.points.forEach(p => {
        if (prev && cruzaDivisoria(prev, p)) contador = 1; // recomeça após cruzar a divisa
        if (p.customName) { p.name = p.customName; } else { p.name = line.letra + contador; contador++; }
        prev = p;
    });
}
function reordenarENumerar(line) { ordenarLinha(line); renumerar(line); }

function removerDeLinhaSilencioso(p) {
    const line = lines[p.lineIndex]; const idx = line.points.indexOf(p); if (idx >= 0) line.points.splice(idx, 1);
    p.lineIndex = null; p.name = null; p.customName = null; reordenarENumerar(line);
}
function clicarPonto(p) {
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); return; }
    pushUndo();
    if (p.lineIndex === currentLineIndex) { removerDeLinhaSilencioso(p); }
    else { if (p.lineIndex != null) removerDeLinhaSilencioso(p); lines[currentLineIndex].points.push(p); p.lineIndex = currentLineIndex; reordenarENumerar(lines[currentLineIndex]); }
    posMudanca();
}
function adicionarVarios(lista) {
    if (lista.length === 0) return;
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); return; }
    pushUndo();
    const line = lines[currentLineIndex];
    lista.forEach(p => { line.points.push(p); p.lineIndex = currentLineIndex; });
    reordenarENumerar(line); posMudanca();
}
function selecionarCaixaMundo(wx0, wy0, wx1, wy1) {
    const x0 = Math.min(wx0, wx1), x1 = Math.max(wx0, wx1), y0 = Math.min(wy0, wy1), y1 = Math.max(wy0, wy1);
    adicionarVarios(points.filter(p => p.lineIndex == null && catVisivel(p) && worldX(p) >= x0 && worldX(p) <= x1 && worldY(p) >= y0 && worldY(p) <= y1));
}
function pontoEmPoligono(p, poly) {
    const x = worldX(p), y = worldY(p); let dentro = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].wx, yi = poly[i].wy, xj = poly[j].wx, yj = poly[j].wy;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
}
function selecionarLasso(poly) {
    if (poly.length < 3) return;
    adicionarVarios(points.filter(p => p.lineIndex == null && catVisivel(p) && pontoEmPoligono(p, poly)));
}
// --- Mini-card (substitui prompt do navegador) ---
let miniCardCb = null;
function abrirMiniCard(screenX, screenY, label, valor, cb) {
    const card = document.getElementById('mini-card');
    const input = document.getElementById('mini-card-input');
    document.getElementById('mini-card-label').textContent = label || '';
    input.value = valor || '';
    miniCardCb = cb;
    card.classList.remove('hidden');
    // posiciona dentro da tela
    const w = card.offsetWidth, h = card.offsetHeight;
    let x = Math.min(screenX, window.innerWidth - w - 8);
    let y = Math.min(screenY, window.innerHeight - h - 8);
    card.style.left = Math.max(8, x) + 'px';
    card.style.top = Math.max(8, y) + 'px';
    input.focus(); input.select();
}
function fecharMiniCard() { document.getElementById('mini-card').classList.add('hidden'); miniCardCb = null; }
function confirmarMiniCard() { const v = document.getElementById('mini-card-input').value; const cb = miniCardCb; fecharMiniCard(); if (cb) cb(v); }

function editarPonto(p) {
    if (p.lineIndex == null) { alert('Esse ponto ainda não está em nenhuma linha.'); return; }
    const s = toScreen(p);
    abrirMiniCard(s.x + 14, s.y - 10, 'Nome do ponto (vazio = automático)', p.customName || p.name || '', (novo) => {
        pushUndo(); p.customName = (novo || '').trim() || null; renumerar(lines[p.lineIndex]); posMudanca();
    });
}
function posMudanca() { atualizarPainelLinhas(); atualizarPainelDivisorias(); atualizarPainelGuia(); atualizarStatus(); salvarAutosave(); draw(); }

// --- Vista de topo / eixo-guia ---
function alternarVistaTopo() {
    topView = !topView;
    if (!topView && addingGuide) { addingGuide = false; guiaPts = []; document.getElementById('btn-guia').classList.remove('ativo'); }
    document.getElementById('btn-topo').classList.toggle('ativo', topView);
    document.getElementById('btn-guia').style.display = topView ? '' : 'none';
    hoveredPoint = null; fitView(); atualizarStatus(); draw();
}
function alternarModoGuia() {
    if (!topView) alternarVistaTopo(); // o eixo-guia é desenhado na vista de topo
    addingGuide = !addingGuide; guiaPts = []; diviMouse = null;
    document.getElementById('btn-guia').classList.toggle('ativo', addingGuide);
    canvas.style.cursor = 'crosshair';
    atualizarStatus(); draw();
}
function finalizarGuia() {
    if (guiaPts.length < 2) { addingGuide = false; guiaPts = []; document.getElementById('btn-guia').classList.remove('ativo'); atualizarStatus(); draw(); return; }
    pushUndo();
    guide = guiaPts.map(g => ({ e: g.e, n: g.n }));
    addingGuide = false; guiaPts = []; diviMouse = null;
    document.getElementById('btn-guia').classList.remove('ativo');
    aplicarGuia();
    // volta para a vista frontal já "desenrolada"
    topView = false; document.getElementById('btn-topo').classList.remove('ativo');
    document.getElementById('btn-guia').style.display = 'none';
    fitView(); posMudanca();
}
function removerGuia() {
    if (!guide.length) return;
    if (!confirm('Remover o eixo-guia? A vista volta ao eixo reto (PCA).')) return;
    pushUndo(); guide = []; aplicarGuia(); fitView(); posMudanca();
}
function atualizarPainelGuia() {
    const box = document.getElementById('guia-status'); if (!box) return;
    if (guide.length >= 2) {
        box.innerHTML = `<span class="guia-ok">✓ Eixo-guia ativo (${guide.length} vértices)</span> <button id="btn-remover-guia" class="btn-mini" title="Remover">✕</button>`;
        const b = document.getElementById('btn-remover-guia'); if (b) b.addEventListener('click', removerGuia);
    } else {
        box.innerHTML = '<small>Sem eixo-guia (eixo reto). Use em taludes em curva.</small>';
    }
}

// --- Divisórias ---
function alternarModoDivisoria() {
    addingDivider = !addingDivider; diviPts = []; diviMouse = null;
    document.getElementById('btn-divisoria').classList.toggle('ativo', addingDivider);
    canvas.style.cursor = 'crosshair';
    atualizarStatus(); draw();
}
function finalizarDivisoria(screenX, screenY) {
    if (diviPts.length < 2) { addingDivider = false; diviPts = []; document.getElementById('btn-divisoria').classList.remove('ativo'); atualizarStatus(); draw(); return; }
    const pts = diviPts.map(p => ({ h: p.h, elev: p.elev }));
    addingDivider = false; diviPts = []; diviMouse = null;
    document.getElementById('btn-divisoria').classList.remove('ativo');
    pushUndo();
    const d = { name: 'Divisa ' + (dividers.length + 1), pts };
    dividers.push(d);
    lines.forEach(renumerar); posMudanca();
    // abre o mini-card para nomear (cancelar mantém o nome padrão)
    abrirMiniCard((screenX || window.innerWidth / 2) + 8, screenY || 120, 'Nome da divisória (no pé)', d.name, (nome) => {
        pushUndo(); d.name = (nome || '').trim() || d.name; posMudanca();
    });
}
function excluirDivisoria(di) {
    pushUndo(); dividers.splice(di, 1); lines.forEach(renumerar); posMudanca();
}
function renomearDivisoria(di, ev) {
    const x = ev ? ev.clientX + 6 : window.innerWidth / 2, y = ev ? ev.clientY : 120;
    abrirMiniCard(x, y, 'Nome da divisória', dividers[di].name, (nome) => {
        const n = (nome || '').trim(); if (!n) return;
        pushUndo(); dividers[di].name = n; posMudanca();
    });
}
function atualizarPainelDivisorias() {
    const cont = document.getElementById('lista-divisorias'); if (!cont) return;
    cont.innerHTML = '';
    dividers.forEach((d, di) => {
        const row = document.createElement('div'); row.className = 'divi-item';
        row.innerHTML = `<span class="divi-nome" title="Renomear">⋮ ${escapeHtml(d.name)}</span><button title="Excluir">✕</button>`;
        row.querySelector('.divi-nome').addEventListener('click', (e) => renomearDivisoria(di, e));
        row.querySelector('button').addEventListener('click', () => excluirDivisoria(di));
        cont.appendChild(row);
    });
}

// =============================================================
//  Painéis e filtros
// =============================================================
function montarFiltroCategorias() {
    const cont = document.getElementById('filtro-categorias'); cont.innerHTML = '';
    CATS.forEach(c => {
        const n = points.filter(p => p.cat === c.key).length;
        if (n === 0) return;
        const id = 'chk-cat-' + c.key;
        const div = document.createElement('label'); div.className = 'check cat-check';
        div.innerHTML = `<input type="checkbox" id="${id}" ${enabledCats.has(c.key) ? 'checked' : ''}>
            <span class="cat-bola" style="background:${c.color}"></span> ${c.label} (${n})`;
        div.querySelector('input').addEventListener('change', (e) => {
            if (e.target.checked) enabledCats.add(c.key); else enabledCats.delete(c.key);
            hoveredPoint = null; draw();
        });
        cont.appendChild(div);
    });
}
function atualizarPainelLinhas() {
    const cont = document.getElementById('lista-linhas');
    if (lines.length === 0) { cont.innerHTML = '<small>Nenhuma linha ainda.</small>'; return; }
    cont.innerHTML = '';
    lines.forEach((line, li) => {
        const div = document.createElement('div');
        div.className = 'linha-item' + (li === currentLineIndex ? ' ativa' : '');
        div.title = 'Clique para selecionar esta linha';
        const nomes = line.points.map(p => p.name).join(', ') || '—';
        div.innerHTML = `<div class="linha-item-cabecalho">
                <span class="linha-cor" style="background:${line.color}"></span>
                <span class="linha-titulo">Linha ${line.letra}</span>
                <span class="linha-contagem">${line.points.length} grampos</span></div>
            <div class="linha-nomes">${nomes}</div>
            <div class="linha-acoes">
                <button class="btn-mini btn-inv">Inverter</button>
                <button class="btn-mini btn-ren">Renomear</button>
                <button class="btn-mini btn-del">Excluir</button></div>`;
        div.addEventListener('click', () => { currentLineIndex = li; atualizarPainelLinhas(); draw(); });
        div.querySelector('.btn-inv').addEventListener('click', (e) => { e.stopPropagation(); inverterLinha(li); });
        div.querySelector('.btn-ren').addEventListener('click', (e) => { e.stopPropagation(); renomearLinha(li, e); });
        div.querySelector('.btn-del').addEventListener('click', (e) => { e.stopPropagation(); excluirLinha(li); });
        cont.appendChild(div);
    });
}
function inverterLinha(li) { pushUndo(); lines[li].inverted = !lines[li].inverted; reordenarENumerar(lines[li]); posMudanca(); }
function renomearLinha(li, ev) {
    const x = ev ? ev.clientX + 6 : window.innerWidth / 2, y = ev ? ev.clientY : 120;
    abrirMiniCard(x, y, 'Nova letra da linha', lines[li].letra, (nova) => {
        const letra = (nova || '').trim().toUpperCase(); if (!letra) return;
        pushUndo(); lines[li].letra = letra; renumerar(lines[li]); posMudanca();
    });
}
function excluirLinha(li) {
    if (!confirm(`Excluir a linha ${lines[li].letra}?`)) return;
    pushUndo();
    lines[li].points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    lines.splice(li, 1); lines.forEach((line, idx) => line.points.forEach(p => { p.lineIndex = idx; }));
    if (currentLineIndex === li) currentLineIndex = -1; else if (currentLineIndex > li) currentLineIndex--;
    posMudanca();
}
function atualizarStatus() {
    const atribuidos = points.filter(p => p.lineIndex != null).length;
    let html = `Pontos no arquivo: <b>${points.length}</b><br>Atribuídos a linhas: <b>${atribuidos}</b><br>Linhas: <b>${lines.length}</b> &middot; Divisórias: <b>${dividers.length}</b>`;
    if (addingDivider) html = `<b style="color:#c0392b">Divisória:</b> clique para adicionar vértices; <b>duplo-clique</b> ou <b>Enter</b> conclui. (Esc cancela)<br>` + html;
    else if (addingGuide) html = `<b style="color:#0a7d4b">Eixo-guia:</b> clique seguindo a curva do talude (de uma ponta à outra); <b>duplo-clique</b> ou <b>Enter</b> conclui. (Esc cancela)<br>` + html;
    else if (topView) html = `<b style="color:#0a7d4b">Vista de topo</b> — desenhe o eixo-guia ou volte à vista frontal.<br>` + html;
    document.getElementById('status-barra').innerHTML = html;
}

// =============================================================
//  Exportação CSV
// =============================================================
function exportar() {
    const novoNome = {};
    lines.forEach(line => line.points.forEach(p => { novoNome[p.rowIndex] = p.name; }));
    const out = originalRows.map((parts, idx) => { const c = parts.slice(); if (novoNome[idx] != null) c[0] = novoNome[idx]; return c.join(delimiter); });
    baixar(new Blob([out.join('\r\n')], { type: 'text/csv;charset=utf-8' }), baseNome() + '_renomeado.csv');
}
function baseNome() { return (csvFileURL.split('/').pop() || 'pontos.csv').replace(/\.csv$/i, ''); }
function baixar(blob, nome) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

// =============================================================
//  Montagem da prancha (modal) e exportação do PDF
// =============================================================
const PAGE_MM = { A0: [841, 1189], A1: [594, 841], A3: [297, 420], A4: [210, 297] };
const pdfState = { desenhoImg: null, desenhoAspect: 1, bgImg: null, k: 1, layout: null, drag: null, fs: { info: 1, counts: 1, legend: 1 } };
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function escapeHtml(s) { return (s || '').replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
function el(id) { return document.getElementById(id); }
function pageMm() {
    const base = PAGE_MM[el('pdf-size').value] || PAGE_MM.A0;
    const retrato = el('pdf-orient').value === 'retrato';
    return { w: retrato ? base[0] : base[1], h: retrato ? base[1] : base[0] };
}
function contagemCategorias() {
    const arr = []; CATS.forEach(c => { const n = points.filter(p => p.cat === c.key).length; if (n > 0) arr.push({ label: c.label, n, color: c.color }); });
    return arr;
}

function gerarImagemDesenho() {
    const prevNomes = showNames, prevTodos = rotularTodos;
    showNames = true; rotularTodos = true; fitView(); draw();
    // canvas é transparente (sem fundo branco) — deixa a prancha A0 aparecer por baixo
    pdfState.desenhoImg = canvas.toDataURL('image/png'); pdfState.desenhoAspect = canvas.width / canvas.height;
    showNames = prevNomes; rotularTodos = prevTodos; draw();
}

function abrirPdfModal() {
    if (!window.jspdf || !window.jspdf.jsPDF) { alert('A biblioteca de PDF não carregou (verifique a conexão).'); return; }
    gerarImagemDesenho();
    el('pdf-desenho-img').src = pdfState.desenhoImg;
    if (!el('pdf-titulo').value) el('pdf-titulo').value = nomeTalude;
    const pg = pageMm();
    pdfState.layout = {
        desenho: { x: pg.w * 0.04, y: pg.h * 0.06, w: pg.w * 0.6 },
        info: { x: pg.w * 0.67, y: pg.h * 0.06 },
        counts: { x: pg.w * 0.67, y: pg.h * 0.30 },
        legend: { x: pg.w * 0.67, y: pg.h * 0.70 },
    };
    el('pdf-modal').classList.remove('hidden');
    construirConteudo(); layoutPagina();
}
function fecharPdfModal() { el('pdf-modal').classList.add('hidden'); }

function construirConteudo() {
    const t = el('pdf-titulo').value, pr = el('pdf-projeto').value, da = el('pdf-data').value, ob = el('pdf-obs').value;
    let info = '';
    if (t) info += `<b>${escapeHtml(t)}</b>\n`;
    if (pr) info += `Projeto: ${escapeHtml(pr)}\n`;
    if (da) info += `Data: ${escapeHtml(da)}\n`;
    if (ob) info += `Obs.: ${escapeHtml(ob)}`;
    el('pdf-el-info').innerHTML = info || '(textos)';

    const cats = contagemCategorias();
    let c = '<b>Contagem por categoria</b>\n';
    cats.forEach(x => { c += `${x.label}: ${x.n}\n`; });
    c += `Total: ${points.length}\n\n<b>Por linha</b>\n`;
    c += lines.length ? lines.map(l => `Linha ${l.letra}: ${l.points.length}`).join('\n') : 'Nenhuma linha.';
    el('pdf-el-counts').innerHTML = c;

    let lg = '<b>Legenda</b>';
    cats.forEach(x => { lg += `<div class="pdf-legenda-linha"><span class="pdf-legenda-bola" style="background:${x.color}"></span>${x.label}</div>`; });
    lines.forEach(l => { lg += `<div class="pdf-legenda-linha"><span class="pdf-legenda-bola" style="background:${l.color}"></span>Linha ${l.letra}</div>`; });
    el('pdf-el-legend').innerHTML = lg;

    el('pdf-el-info').classList.toggle('oculto', !el('pdf-show-info').checked);
    el('pdf-el-counts').classList.toggle('oculto', !el('pdf-show-counts').checked);
    el('pdf-el-legend').classList.toggle('oculto', !el('pdf-show-legend').checked);
}

function layoutPagina() {
    const pg = pageMm();
    const stage = document.querySelector('.pdf-stage');
    pdfState.k = Math.min((stage.clientWidth - 40) / pg.w, (stage.clientHeight - 40) / pg.h);
    const page = el('pdf-page');
    page.style.width = pg.w * pdfState.k + 'px';
    page.style.height = pg.h * pdfState.k + 'px';
    const bg = el('pdf-bg-img');
    if (pdfState.bgImg) { bg.src = pdfState.bgImg; bg.style.display = 'block'; } else { bg.style.display = 'none'; }
    posicionar();
}
function posicionar() {
    const k = pdfState.k, L = pdfState.layout;
    const d = el('pdf-el-desenho'), dh = L.desenho.w / pdfState.desenhoAspect;
    d.style.left = L.desenho.x * k + 'px'; d.style.top = L.desenho.y * k + 'px';
    d.style.width = L.desenho.w * k + 'px'; d.style.height = dh * k + 'px';
    [['info', 3.2], ['counts', 3.0], ['legend', 3.0]].forEach(([key, mm]) => {
        const e2 = el('pdf-el-' + key);
        e2.style.left = L[key].x * k + 'px'; e2.style.top = L[key].y * k + 'px'; e2.style.fontSize = (mm * pdfState.fs[key] * k) + 'px';
    });
}

function gerarPDF() {
    const { jsPDF } = window.jspdf;
    const pg = pageMm();
    const pdf = new jsPDF({ orientation: pg.w >= pg.h ? 'landscape' : 'portrait', unit: 'mm', format: [pg.w, pg.h] });
    const L = pdfState.layout, pt = mm => mm / 0.352777;
    if (pdfState.bgImg) pdf.addImage(pdfState.bgImg, 'PNG', 0, 0, pg.w, pg.h);
    pdf.addImage(pdfState.desenhoImg, 'PNG', L.desenho.x, L.desenho.y, L.desenho.w, L.desenho.w / pdfState.desenhoAspect);

    pdf.setTextColor(0, 0, 0);
    if (el('pdf-show-info').checked) {
        const s = pdfState.fs.info;
        let y = L.info.y + 4 * s;
        if (el('pdf-titulo').value) { pdf.setFont('helvetica', 'bold'); pdf.setFontSize(pt(5 * s)); pdf.text(el('pdf-titulo').value, L.info.x, y); y += 6 * s; pdf.setFont('helvetica', 'normal'); }
        pdf.setFontSize(pt(3.2 * s));
        [['Projeto', el('pdf-projeto').value], ['Data', el('pdf-data').value], ['Obs.', el('pdf-obs').value]].forEach(([k, v]) => { if (v) { pdf.text(`${k}: ${v}`, L.info.x, y); y += 4.5 * s; } });
    }
    if (el('pdf-show-counts').checked) {
        const s = pdfState.fs.counts;
        let y = L.counts.y + 4 * s;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(pt(3.6 * s)); pdf.text('Contagem por categoria', L.counts.x, y); y += 5 * s;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(pt(3.0 * s));
        contagemCategorias().forEach(x => { pdf.text(`${x.label}: ${x.n}`, L.counts.x, y); y += 4 * s; });
        pdf.text(`Total: ${points.length}`, L.counts.x, y); y += 6 * s;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(pt(3.6 * s)); pdf.text('Por linha', L.counts.x, y); y += 5 * s;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(pt(3.0 * s));
        if (!lines.length) pdf.text('Nenhuma linha.', L.counts.x, y);
        else lines.forEach(l => { pdf.text(`Linha ${l.letra}: ${l.points.length}`, L.counts.x, y); y += 4 * s; });
    }
    if (el('pdf-show-legend').checked) {
        const s = pdfState.fs.legend;
        let y = L.legend.y + 4 * s;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(pt(3.6 * s)); pdf.text('Legenda', L.legend.x, y); y += 5 * s;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(pt(3.0 * s));
        const itens = contagemCategorias().map(x => ({ color: x.color, label: x.label })).concat(lines.map(l => ({ color: l.color, label: 'Linha ' + l.letra })));
        itens.forEach(it => { const rgb = hexRgb(it.color); pdf.setFillColor(rgb[0], rgb[1], rgb[2]); pdf.circle(L.legend.x + 1.3 * s, y - 1.1 * s, 1.2 * s, 'F'); pdf.text(it.label, L.legend.x + 4 * s, y); y += 4.2 * s; });
    }
    pdf.save((nomeTalude || 'talude').replace(/\s+/g, '_') + '_prancha.pdf');
}

async function carregarFundoPDF(file) {
    const status = el('pdf-bg-status');
    if (!window.pdfjsLib) { status.textContent = 'Biblioteca pdf.js não carregou.'; return; }
    status.textContent = 'Carregando...';
    try {
        const buf = await file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: buf }).promise;
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 2 });
        const cnv = document.createElement('canvas'); cnv.width = vp.width; cnv.height = vp.height;
        await page.render({ canvasContext: cnv.getContext('2d'), viewport: vp }).promise;
        pdfState.bgImg = cnv.toDataURL('image/png');
        // ajusta a orientação automaticamente pela proporção da prancha
        el('pdf-orient').value = vp.width >= vp.height ? 'paisagem' : 'retrato';
        status.textContent = 'Fundo carregado.';
        layoutPagina();
    } catch (err) { console.error(err); status.textContent = 'Falha ao ler o PDF.'; }
}

function ligarArrastePrancha() {
    const page = el('pdf-page');
    page.addEventListener('mousedown', (e) => {
        const handle = e.target.classList.contains('pdf-resize');
        const elDiv = e.target.closest('.pdf-el');
        if (!handle && !elDiv) return;
        const r = page.getBoundingClientRect(), k = pdfState.k;
        const mmx = (e.clientX - r.left) / k, mmy = (e.clientY - r.top) / k;
        if (handle) pdfState.drag = { mode: 'resize' };
        else pdfState.drag = { mode: 'move', key: elDiv.dataset.el, offx: mmx - pdfState.layout[elDiv.dataset.el].x, offy: mmy - pdfState.layout[elDiv.dataset.el].y };
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!pdfState.drag) return;
        const r = page.getBoundingClientRect(), k = pdfState.k;
        const mmx = (e.clientX - r.left) / k, mmy = (e.clientY - r.top) / k;
        if (pdfState.drag.mode === 'resize') pdfState.layout.desenho.w = Math.max(20, mmx - pdfState.layout.desenho.x);
        else { const L = pdfState.layout[pdfState.drag.key]; L.x = mmx - pdfState.drag.offx; L.y = mmy - pdfState.drag.offy; }
        posicionar();
    });
    window.addEventListener('mouseup', () => { pdfState.drag = null; });
}

// =============================================================
//  Autosave
// =============================================================
function salvarAutosave() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ flipH, nameAngle, nameSize, dividers, guide, lines: lines.map(l => ({ letra: l.letra, color: l.color, inverted: !!l.inverted, pts: l.points.map(p => ({ r: p.rowIndex, c: p.customName || null })) })) })); } catch (e) {}
}
function restaurarAutosave() {
    let dados; try { dados = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return; }
    if (!dados || !dados.lines) return;
    if (dados.flipH) { flipH = true; const chk = document.getElementById('chk-flip'); if (chk) chk.checked = true; }
    if (typeof dados.nameAngle === 'number') {
        nameAngle = dados.nameAngle;
        const sl = document.getElementById('slider-angulo'); if (sl) sl.value = nameAngle;
        const v = document.getElementById('valor-angulo'); if (v) v.textContent = nameAngle + '°';
    }
    if (typeof dados.nameSize === 'number') {
        nameSize = dados.nameSize;
        const sl = document.getElementById('slider-tam-nome'); if (sl) sl.value = nameSize;
        const v = document.getElementById('valor-tam-nome'); if (v) v.textContent = nameSize + 'px';
    }
    if (Array.isArray(dados.dividers)) dividers = normalizarDivisorias(dados.dividers);
    if (Array.isArray(dados.guide)) guide = dados.guide.map(g => ({ e: g.e, n: g.n }));
    const byRow = {}; points.forEach(p => { byRow[p.rowIndex] = p; });
    lines = dados.lines.map((l, li) => {
        const pts = (l.pts || []).map(o => { const p = byRow[o.r]; if (p) { p.lineIndex = li; p.customName = o.c; } return p; }).filter(Boolean);
        const line = { letra: l.letra, color: l.color || PALETTE[li % PALETTE.length], inverted: !!l.inverted, points: pts }; renumerar(line); return line;
    });
    if (lines.length > 0) currentLineIndex = lines.length - 1;
}
function limparTudo() {
    if (!confirm('Excluir todas as linhas e divisórias?')) return;
    pushUndo(); points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; });
    lines = []; dividers = []; currentLineIndex = -1;
    sugerirProximaLetra(); posMudanca();
}

// =============================================================
//  Interação
// =============================================================
function pontoEm(mx, my) {
    let melhor = null, melhorD = HIT_PX * HIT_PX;
    points.forEach(p => { if (!catVisivel(p)) return; const s = toScreen(p); const dx = s.x - mx, dy = s.y - my, d = dx * dx + dy * dy; if (d <= melhorD) { melhorD = d; melhor = p; } });
    return melhor;
}
function cancelarSelecao() {
    boxArmed = null; boxPreview = null; lasso = null;
    if (addingDivider) { addingDivider = false; document.getElementById('btn-divisoria').classList.remove('ativo'); }
    if (addingGuide) { addingGuide = false; document.getElementById('btn-guia').classList.remove('ativo'); }
    diviPts = []; guiaPts = []; diviMouse = null; atualizarStatus();
}

canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (e.button === 1 || spaceDown || e.ctrlKey) { pointer.down = true; pointer.panning = true; pointer.lastX = mx; pointer.lastY = my; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (addingDivider || addingGuide) { pointer.down = true; pointer.dragging = false; pointer.startX = mx; pointer.startY = my; e.preventDefault(); return; }
    // Na vista de topo (sem desenhar guia) o botão esquerdo só faz pan; sem atribuição de pontos.
    if (topView) { pointer.down = true; pointer.panning = true; pointer.lastX = mx; pointer.lastY = my; e.preventDefault(); return; }
    const vh = verticeEm(mx, my); // arrastar vértice de divisória pronta
    if (vh) { draggingVertex = { di: vh.di, vi: vh.vi, moved: false }; pointer.down = true; e.preventDefault(); return; }
    pointer.down = true; pointer.dragging = false; pointer.startX = mx; pointer.startY = my; pointer.lastX = mx; pointer.lastY = my;
    pointer.downPoint = pontoEm(mx, my);
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (addingDivider || addingGuide) { diviMouse = { x: mx, y: my }; draw(); return; }
    if (draggingVertex) {
        if (!draggingVertex.moved) { pushUndo(); draggingVertex.moved = true; }
        dividers[draggingVertex.di].pts[draggingVertex.vi] = telaParaDados(mx, my);
        lines.forEach(renumerar); atualizarPainelLinhas(); atualizarStatus(); draw();
        return;
    }
    if (pointer.down && pointer.panning) { view.ox += mx - pointer.lastX; view.oy += my - pointer.lastY; pointer.lastX = mx; pointer.lastY = my; draw(); return; }
    if (pointer.down) {
        const movido = Math.abs(mx - pointer.startX) + Math.abs(my - pointer.startY);
        if (movido > 5) pointer.dragging = true;
        if (pointer.dragging) { // contorno livre
            boxArmed = null; boxPreview = null;
            if (!lasso) lasso = [];
            lasso.push(telaParaMundo(mx, my)); draw(); return;
        }
    }
    if (!pointer.down && boxArmed) { // caixa aguardando 2º clique
        const s0 = { x: boxArmed.wx * view.scale + view.ox, y: boxArmed.wy * view.scale + view.oy };
        boxPreview = { x0: s0.x, y0: s0.y, x1: mx, y1: my }; draw(); return;
    }
    if (!pointer.down) {
        if (verticeEm(mx, my)) { canvas.style.cursor = 'grab'; if (hoveredPoint) { hoveredPoint = null; draw(); } return; }
        const h = pontoEm(mx, my); if (h !== hoveredPoint) { hoveredPoint = h; canvas.style.cursor = h ? 'pointer' : 'crosshair'; draw(); }
    }
});

window.addEventListener('mouseup', (e) => {
    if (!pointer.down) return;
    pointer.down = false;
    if (pointer.panning) { pointer.panning = false; return; }

    // Fim do arraste de um vértice de divisória
    if (draggingVertex) { const moved = draggingVertex.moved; draggingVertex = null; if (moved) salvarAutosave(); return; }

    // Inserção de divisória: cada clique adiciona um vértice
    if (addingDivider) {
        const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        diviPts.push(telaParaDados(mx, my)); draw();
        return;
    }
    // Desenho do eixo-guia (vista de topo): cada clique adiciona um vértice
    if (addingGuide) {
        const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        guiaPts.push(telaParaEN(mx, my)); draw();
        return;
    }

    if (pointer.dragging && lasso) { const poly = lasso; lasso = null; selecionarLasso(poly); pointer.downPoint = null; pointer.dragging = false; return; }

    // Clique (sem arrastar)
    const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (boxArmed) { // 2º clique fecha a caixa
        const w = telaParaMundo(mx, my); selecionarCaixaMundo(boxArmed.wx, boxArmed.wy, w.wx, w.wy);
        boxArmed = null; boxPreview = null;
    } else if (pointer.downPoint) { clicarPonto(pointer.downPoint); }
    else { const w = telaParaMundo(mx, my); boxArmed = { wx: w.wx, wy: w.wy }; boxPreview = { x0: mx, y0: my, x1: mx, y1: my }; draw(); }
    pointer.downPoint = null; pointer.dragging = false;
});

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault(); const rect = canvas.getBoundingClientRect();
    const p = pontoEm(e.clientX - rect.left, e.clientY - rect.top); if (p) editarPonto(p);
});

// Duplo-clique conclui a divisória ou o eixo-guia em construção
canvas.addEventListener('dblclick', (e) => {
    if (addingDivider) {
        e.preventDefault();
        // o duplo-clique adicionou 2 vértices quase iguais no fim: remove o duplicado
        if (diviPts.length >= 2) {
            const a = divParaTela(diviPts[diviPts.length - 1].h, diviPts[diviPts.length - 1].elev);
            const b = divParaTela(diviPts[diviPts.length - 2].h, diviPts[diviPts.length - 2].elev);
            if (Math.hypot(a.x - b.x, a.y - b.y) < 6) diviPts.pop();
        }
        finalizarDivisoria(e.clientX, e.clientY);
        return;
    }
    if (addingGuide) {
        e.preventDefault();
        if (guiaPts.length >= 2) {
            const a = enParaTela(guiaPts[guiaPts.length - 1].e, guiaPts[guiaPts.length - 1].n);
            const b = enParaTela(guiaPts[guiaPts.length - 2].e, guiaPts[guiaPts.length - 2].n);
            if (Math.hypot(a.x - b.x, a.y - b.y) < 6) guiaPts.pop();
        }
        finalizarGuia();
        return;
    }
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const fator = e.deltaY < 0 ? 1.12 : 1 / 1.12; const w = telaParaMundo(mx, my);
    view.scale *= fator; view.ox = mx - w.wx * view.scale; view.oy = my - w.wy * view.scale; draw();
}, { passive: false });

window.addEventListener('keydown', (e) => {
    // Não interfere quando o modal de montagem do PDF está aberto.
    if (!document.getElementById('pdf-modal').classList.contains('hidden')) {
        if (e.key === 'Escape') fecharPdfModal();
        return;
    }
    const ajudaModal = document.getElementById('ajuda-modal');
    if (e.key === 'Escape' && !ajudaModal.classList.contains('hidden')) { ajudaModal.classList.add('hidden'); return; }
    // Mini-card aberto: Enter confirma, Esc cancela (e não dispara atalhos do editor).
    if (!document.getElementById('mini-card').classList.contains('hidden')) {
        if (e.key === 'Enter') { e.preventDefault(); confirmarMiniCard(); }
        else if (e.key === 'Escape') { e.preventDefault(); fecharMiniCard(); }
        return;
    }
    // Concluir a divisória / o eixo-guia em construção com Enter.
    if (addingDivider && e.key === 'Enter') { e.preventDefault(); finalizarDivisoria(); return; }
    if (addingGuide && e.key === 'Enter') { e.preventDefault(); finalizarGuia(); return; }
    if (e.code === 'Space') { spaceDown = true; canvas.style.cursor = 'grab'; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); desfazer(); }
    if (e.key === 'Escape') { cancelarSelecao(); draw(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; canvas.style.cursor = 'crosshair'; } });

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

// --- Controles ---
document.getElementById('btn-desfazer').addEventListener('click', desfazer);
document.getElementById('btn-detectar').addEventListener('click', detectarLinhas);
document.getElementById('btn-divisoria').addEventListener('click', alternarModoDivisoria);
document.getElementById('btn-topo').addEventListener('click', alternarVistaTopo);
document.getElementById('btn-guia').addEventListener('click', alternarModoGuia);

// Mini-card de renomear
document.getElementById('mini-card-ok').addEventListener('click', confirmarMiniCard);
document.getElementById('mini-card-cancel').addEventListener('click', fecharMiniCard);

// Modal "Como usar"
const ajudaModal = document.getElementById('ajuda-modal');
document.getElementById('btn-ajuda').addEventListener('click', () => ajudaModal.classList.remove('hidden'));
document.getElementById('ajuda-fechar').addEventListener('click', () => ajudaModal.classList.add('hidden'));
ajudaModal.addEventListener('click', (e) => { if (e.target === ajudaModal) ajudaModal.classList.add('hidden'); });
document.getElementById('btn-nova-linha').addEventListener('click', novaLinha);
document.getElementById('input-letra').addEventListener('keydown', (e) => { if (e.key === 'Enter') novaLinha(); });
document.getElementById('btn-enquadrar').addEventListener('click', () => { fitView(); draw(); });
document.getElementById('btn-exportar').addEventListener('click', exportar);
document.getElementById('btn-pdf').addEventListener('click', abrirPdfModal);
document.getElementById('btn-limpar').addEventListener('click', limparTudo);

// --- Modal de montagem do PDF ---
ligarArrastePrancha();
el('pdf-fechar').addEventListener('click', fecharPdfModal);
el('pdf-gerar').addEventListener('click', gerarPDF);
el('pdf-bg').addEventListener('change', (e) => { if (e.target.files[0]) carregarFundoPDF(e.target.files[0]); });
el('pdf-size').addEventListener('change', layoutPagina);
el('pdf-orient').addEventListener('change', layoutPagina);
['pdf-titulo', 'pdf-projeto', 'pdf-data', 'pdf-obs', 'pdf-show-info', 'pdf-show-counts', 'pdf-show-legend'].forEach(id => {
    el(id).addEventListener('input', () => { construirConteudo(); posicionar(); });
    el(id).addEventListener('change', () => { construirConteudo(); posicionar(); });
});
// Tamanho (escala) de cada bloco de texto no PDF
[['pdf-fs-info', 'info'], ['pdf-fs-counts', 'counts'], ['pdf-fs-legend', 'legend']].forEach(([id, key]) => {
    el(id).addEventListener('input', () => { pdfState.fs[key] = parseFloat(el(id).value); posicionar(); });
});
window.addEventListener('resize', () => { if (!el('pdf-modal').classList.contains('hidden')) layoutPagina(); });
document.getElementById('chk-mostrar-nomes').addEventListener('change', (e) => { showNames = e.target.checked; draw(); });
document.getElementById('slider-angulo').addEventListener('input', (e) => {
    nameAngle = parseInt(e.target.value, 10); document.getElementById('valor-angulo').textContent = nameAngle + '°'; salvarAutosave(); draw();
});
document.getElementById('slider-tam-nome').addEventListener('input', (e) => {
    nameSize = parseInt(e.target.value, 10); document.getElementById('valor-tam-nome').textContent = nameSize + 'px'; salvarAutosave(); draw();
});
document.getElementById('chk-flip').addEventListener('change', (e) => {
    flipH = e.target.checked;
    lines.forEach(reordenarENumerar); // "direita" mudou: renumera por proximidade
    fitView(); posMudanca();
});
document.getElementById('slider-exagero').addEventListener('input', (e) => {
    exagero = parseFloat(e.target.value); document.getElementById('valor-exagero').textContent = exagero.toFixed(1) + '×'; fitView(); draw();
});
