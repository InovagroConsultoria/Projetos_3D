// =============================================================
//  Editor de Linhas — atribui pontos a "linhas", renomeia e
//  exporta CSV renomeado + PDF (desenho, nomes e contagens).
//  Vista 2D frontal: eixo horizontal = direção principal do talude,
//  eixo vertical = elevação.
// =============================================================

import { TALUDES, OBRAS } from './config.js';

const params = new URLSearchParams(window.location.search);
const csvFileURL = params.get('csv');
const areasFileURL = params.get('areas');
let nomeTalude = params.get('nome') || 'Talude';

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
let projUX = 1, projUY = 0; // eixo principal (PCA) — reutilizado para projetar as áreas

// --- Áreas (telas de proteção): polígonos transparentes sobre o talude ---
let areas = [];          // { nome, cor, areaFile, pts: [{e, n, elev, h}] }
let showAreas = true;
let exagero = 1.0;
let showNames = false;
let rotularTodos = false; // ao gerar o PDF: rotula todos os grampos (nome ou id do CSV)
let nameAngle = 0;       // ângulo dos rótulos em graus (0 = horizontal) — evita sobreposição
let nameSize = 11;       // tamanho da fonte dos rótulos (px)
let flipH = false;       // espelha a vista na horizontal (talude visto de trás)
let numInvertido = false; // inverte o sentido da numeração (talude nomeado esquerda→direita)
let enabledCats = new Set(['outros']); // por padrão só os grampos de grade
let modoExcluir = false; // modo de exclusão de pontos (clique/caixa/contorno excluem)
let modoEdicao = false;  // false = Visualizador de Linhas (padrão); true = edição local

// --- Medição de distância entre pontos conhecidos ---
let medindo = false;
let medA = null, medB = null;

function setModo(edicao) {
    modoEdicao = edicao;
    document.body.classList.toggle('modo-visualizacao', !edicao);
    document.getElementById('titulo-talude').textContent = (edicao ? 'Editor — ' : 'Visualização 2D — ') + nomeTalude;
    if (!edicao) { cancelarSelecao(); fecharMiniCard(); }
    fecharCards();
    montarFiltroCategorias(); atualizarPainelLinhas(); atualizarStatus(); draw();
}

// --- Cards de interação (abertos pelos ícones da toolbar) ---
function fecharCards() {
    document.querySelectorAll('.tool-card').forEach(c => c.classList.add('hidden'));
    document.querySelectorAll('#toolbar .tool-btn[data-card]').forEach(b => b.classList.remove('ativo'));
}
// Foco automático: seleciona a linha, abre o card dela e rola o painel até ele.
function focarLinha(li) {
    currentLineIndex = li;
    atualizarPainelLinhas();
    const elCard = document.querySelectorAll('#lista-linhas .linha-item')[li];
    if (elCard) elCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    draw();
}

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
let STORAGE_KEY = 'editor-linhas:' + (csvFileURL || 'sem-csv');

// =============================================================
//  Carregamento
// =============================================================
if (!csvFileURL) {
    mostrarTelaAbrirLocal();
} else {
    fetch(csvFileURL)
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
        .then(txt => iniciar(txt))
        .catch(err => { console.error('Falha ao carregar CSV:', err); showError('Não foi possível carregar os pontos (CSV).', csvFileURL); });
}

// Sem projeto na URL: oferece abrir um CSV do computador (edição local).
function mostrarTelaAbrirLocal() {
    const ls = document.getElementById('loading-screen');
    ls.classList.remove('hidden'); ls.style.display = 'flex';
    ls.innerHTML = `<div style="font-size:42px;margin-bottom:14px;">📂</div>
        <div id="loading-text">Nenhum projeto especificado.<br><small style="color:#777">Selecione um talude no menu ou abra um CSV do seu computador.</small></div>
        <button class="error-button" id="btn-abrir-local" style="border:none;cursor:pointer;font-family:inherit;">📂 Carregar CSV do computador</button>
        <a class="error-button" style="background:#6c757d" href="index.html">Voltar ao menu</a>`;
    document.getElementById('btn-abrir-local').addEventListener('click', () => document.getElementById('csv-local').click());
}

// Reinicia todo o estado para carregar um novo conjunto de pontos.
function resetarEstado() {
    points = []; lines = []; dividers = []; guide = []; areas = [];
    undoStack.length = 0;
    currentLineIndex = -1; autoDetectou = false;
    flipH = false; topView = false; modoExcluir = false;
    medindo = false; medA = null; medB = null;
    enabledCats = new Set(['outros']);
    const chk = document.getElementById('chk-flip'); if (chk) chk.checked = false;
    document.getElementById('btn-medir').classList.remove('ativo');
    document.getElementById('btn-excluir-pontos').classList.remove('ativo');
    document.getElementById('btn-topo').classList.remove('ativo');
    fecharCards(); fecharInfoPonto();
}

// Abre um CSV do computador (sem passar pelo GitHub) — edição local.
function carregarCsvLocal(file) {
    const reader = new FileReader();
    reader.onload = () => {
        resetarEstado();
        nomeTalude = file.name.replace(/\.(csv|txt)$/i, '') + ' (local)';
        STORAGE_KEY = 'editor-linhas:local:' + file.name;
        PDF_KEY = STORAGE_KEY + ':pdf';
        const ls = document.getElementById('loading-screen');
        ls.style.display = 'flex'; ls.classList.remove('hidden');
        try { iniciar(String(reader.result)); }
        catch (e) { console.error(e); showError('Não foi possível ler este CSV.', file.name); }
    };
    reader.onerror = () => showError('Não foi possível ler o arquivo.', file.name);
    reader.readAsText(file);
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

// =============================================================
//  Vista predefinida (config) — abre no jeito certo na 1ª visita
// =============================================================
// Procura no config.js a "vista" definida para o CSV atual.
function presetVistaDoConfig() {
    if (!csvFileURL) return null;
    const t = TALUDES.find(x => x.csv === csvFileURL);
    if (t && t.vista) return t.vista;
    for (const o of OBRAS) for (const a of (o.acoes || [])) {
        if (a.editor && a.editor.csv === csvFileURL && a.editor.vista) return a.editor.vista;
        if (a.viz && a.viz.csv === csvFileURL && a.viz.vista) return a.viz.vista;
    }
    return null;
}
function aplicarPresetVista(v) {
    if (!v) return;
    if (v.flipH) { flipH = true; const chk = document.getElementById('chk-flip'); if (chk) chk.checked = true; }
    if (typeof v.nameAngle === 'number') {
        nameAngle = v.nameAngle;
        const sl = document.getElementById('slider-angulo'); if (sl) sl.value = nameAngle;
        const el2 = document.getElementById('valor-angulo'); if (el2) el2.textContent = nameAngle + '°';
    }
    if (Array.isArray(v.guide) && v.guide.length >= 2) guide = v.guide.map(g => ({ e: g.e, n: g.n }));
}
// Gera o trecho pronto para colar no config.js (espelho + ângulo + eixo-guia).
function exportarVista() {
    const campos = [`flipH: ${!!flipH}`];
    if (nameAngle) campos.push(`nameAngle: ${nameAngle}`);
    if (guide.length >= 2) {
        const g = guide.map(v => `{ e: ${(+v.e).toFixed(3)}, n: ${(+v.n).toFixed(3)} }`).join(', ');
        campos.push(`guide: [${g}]`);
    }
    const snippet = `vista: { ${campos.join(', ')} },`;
    const base = (nomeTalude || 'talude').replace(/[^\w-]+/g, '_');
    baixar(new Blob([snippet], { type: 'text/plain;charset=utf-8' }), 'vista_' + base + '.txt');
    if (navigator.clipboard) navigator.clipboard.writeText(snippet).catch(() => {});
    alert('Vista exportada!\n\nO trecho foi copiado e baixado (vista_' + base + '.txt).\nEnvie ao administrador para colar no config.js:\n\n' + snippet);
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
    projUX = ux; projUY = uy;

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
    const preset = presetVistaDoConfig();
    numInvertido = !!(preset && preset.numLeftToRight); // sentido da numeração é fixo do talude (todo carregamento)
    const tinhaSalvo = restaurarAutosave();
    if (!tinhaSalvo) aplicarPresetVista(preset); // 1ª visita: vista correta do config
    if (lines.length === 0) detectarLinhasAuto(); // visualizador: linhas pré-definidas carregadas automaticamente
    aplicarGuia(); // se houver eixo-guia salvo, reprojeta por estaqueamento
    if (autoDetectou) inferirDivisorias(); // divisórias visíveis já no 1º carregamento (numeração do CSV)
    resizeCanvas();
    fitView();
    atualizarPainelLinhas(); atualizarPainelDivisorias(); atualizarPainelGuia(); atualizarExcluidos(); atualizarStatus(); draw();

    const ls = document.getElementById('loading-screen');
    ls.classList.add('hidden'); setTimeout(() => { ls.style.display = 'none'; }, 400);
    setModo(false); // abre no modo Visualizador de Linhas
    sugerirProximaLetra();
    carregarAreas(); // telas de proteção (arquivo opcional ?areas=)
}

// =============================================================
//  Projeção
// =============================================================
function worldX(p) { return topView ? (p.e - mE) : (flipH ? -p.h : p.h); }
function worldY(p) { return topView ? -(p.n - mN) : -p.elev * exagero; }
function toScreen(p) { return { x: worldX(p) * view.scale + view.ox, y: worldY(p) * view.scale + view.oy }; }
function telaParaMundo(mx, my) { return { wx: (mx - view.ox) / view.scale, wy: (my - view.oy) / view.scale }; }
function catVisivel(p) { return !p.deleted && enabledCats.has(p.cat); }
function ativos() { return points.filter(p => !p.deleted); }

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
    projetarAreas();
    lines.forEach(reordenarENumerar);
}

// =============================================================
//  Áreas (telas de proteção)
// =============================================================
function carregarAreas() {
    if (!areasFileURL) return;
    fetch(areasFileURL, { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
        .then(txt => { areas = parseAreas(txt); projetarAreas(); montarFiltroCategorias(); draw(); })
        .catch(err => console.warn('Áreas não carregadas:', err));
}
// Formato: [NOME; cor=#rrggbb; area=123.4] seguido de linhas "E; N; Elev".
function parseAreas(txt) {
    const out = [];
    let atual = null;
    const CORES_AREA = ['#00c8ff', '#ff8c00', '#e6194B', '#3cb44b', '#911eb4', '#f032e6'];
    txt.split(/\r?\n/).forEach(linha => {
        const l = linha.trim();
        if (!l || l.startsWith('#')) return;
        const cab = l.match(/^\[([^\]]+)\]/); // tolera comentários após o "]"
        if (cab) {
            const partes = cab[1].split(';').map(s => s.trim());
            const nome = partes[0] || ('Área ' + (out.length + 1));
            let cor = null, areaFile = null;
            partes.slice(1).forEach(p => {
                const m = p.match(/^(cor|area)\s*=\s*(.*)$/i);
                if (!m) return;
                if (m[1].toLowerCase() === 'cor' && m[2]) cor = m[2].trim();
                if (m[1].toLowerCase() === 'area') { const v = parseFloat(m[2].replace(',', '.')); if (!Number.isNaN(v)) areaFile = v; }
            });
            atual = { nome, cor: cor || CORES_AREA[out.length % CORES_AREA.length], areaFile, pts: [] };
            out.push(atual);
            return;
        }
        if (!atual) return;
        const c = l.split(/[;,\t]/).map(s => parseFloat(s.trim().replace(',', '.')));
        if (c.length >= 3 && c.every(v => !Number.isNaN(v))) atual.pts.push({ e: c[0], n: c[1], elev: c[2], h: 0 });
    });
    return out.filter(a => a.pts.length >= 3);
}
function projetarAreas() {
    const usarGuia = guide.length >= 2;
    areas.forEach(a => a.pts.forEach(v => {
        v.h = usarGuia ? chainage(v.e, v.n) : ((v.e - mE) * projUX + (v.n - mN) * projUY);
    }));
}
// Área EM PLANTA (projeção horizontal E×N) — mesma convenção do levantamento;
// é o valor usado quando o arquivo não traz a área.
function areaPlanta(pts) {
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        nz += (a.e - b.e) * (a.n + b.n);
    }
    return Math.abs(nz) / 2;
}
function areaValor(a) {
    if (a.areaFile != null) return { v: a.areaFile, fonte: 'arquivo' };
    return { v: areaPlanta(a.pts), fonte: 'em planta' };
}
// Clique dentro de alguma área (coordenadas de mundo wx, wy)?
function areaEm(wx, wy) {
    if (!showAreas) return null;
    for (const a of areas) {
        let dentro = false;
        const vs = a.pts;
        for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
            const xi = (flipH ? -vs[i].h : vs[i].h), yi = -vs[i].elev * exagero;
            const xj = (flipH ? -vs[j].h : vs[j].h), yj = -vs[j].elev * exagero;
            if (((yi > wy) !== (yj > wy)) && (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi)) dentro = !dentro;
        }
        if (dentro) return a;
    }
    return null;
}
function mostrarInfoArea(a) {
    const { v, fonte } = areaValor(a);
    document.getElementById('ponto-info-titulo').textContent = 'Tela selecionada';
    document.getElementById('ponto-info-corpo').innerHTML =
        `<b>${escapeHtml(a.nome)}</b><br>` +
        `Área: <b>${v.toFixed(1)} m²</b> <small>(${fonte})</small><br>` +
        `Vértices: ${a.pts.length}`;
    document.getElementById('ponto-info').classList.remove('hidden');
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
function corRgba(hex, alpha) { const r = hexRgb(hex); return `rgba(${r[0]},${r[1]},${r[2]},${alpha})`; }

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Áreas (telas de proteção) — desenhadas atrás de tudo, transparentes
    if (showAreas && areas.length) {
        areas.forEach(a => {
            const tela = a.pts.map(v => topView
                ? enParaTela(v.e, v.n)
                : divParaTela(v.h, v.elev));
            ctx.beginPath();
            tela.forEach((s, i) => i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y));
            ctx.closePath();
            ctx.fillStyle = corRgba(a.cor, 0.22); ctx.fill();
            ctx.strokeStyle = a.cor; ctx.lineWidth = 2; ctx.stroke();
            // nome + área no centro
            let cx = 0, cy = 0; tela.forEach(s => { cx += s.x; cy += s.y; }); cx /= tela.length; cy /= tela.length;
            const { v } = areaValor(a);
            ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            const t1 = a.nome, t2 = v.toFixed(1) + ' m²';
            const w = Math.max(ctx.measureText(t1).width, ctx.measureText(t2).width);
            ctx.fillRect(cx - w / 2 - 5, cy - 15, w + 10, 30);
            ctx.fillStyle = '#222'; ctx.fillText(t1, cx, cy - 3); ctx.fillText(t2, cx, cy + 11);
            ctx.textAlign = 'left';
        });
    }

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

    // Medição de distância (anéis nos pontos + linha com o valor)
    if (medindo && medA) {
        const s1 = toScreen(medA);
        ctx.beginPath(); ctx.arc(s1.x, s1.y, 9, 0, Math.PI * 2); ctx.strokeStyle = '#0a7d4b'; ctx.lineWidth = 3; ctx.stroke();
        if (medB) {
            const s2 = toScreen(medB);
            ctx.beginPath(); ctx.arc(s2.x, s2.y, 9, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
            const d3 = Math.hypot(Math.hypot(medB.e - medA.e, medB.n - medA.n), medB.elev - medA.elev);
            const mx2 = (s1.x + s2.x) / 2, my2 = (s1.y + s2.y) / 2, rot = d3.toFixed(2) + ' m';
            ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
            const w = ctx.measureText(rot).width;
            ctx.fillStyle = '#0a7d4b'; ctx.fillRect(mx2 - w / 2 - 5, my2 - 20, w + 10, 17);
            ctx.fillStyle = '#fff'; ctx.fillText(rot, mx2, my2 - 8);
            ctx.textAlign = 'left';
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
    return JSON.stringify({ cur: currentLineIndex, dividers, guide, del: points.filter(p => p.deleted).map(p => p.rowIndex), lines: lines.map(l => ({ letra: l.letra, color: l.color, inverted: !!l.inverted, pts: l.points.map(p => ({ r: p.rowIndex, c: p.customName || null })) })) });
}
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > UNDO_MAX) undoStack.shift(); }
function desfazer() {
    if (undoStack.length === 0) return;
    const d = JSON.parse(undoStack.pop());
    const delSet = new Set(d.del || []);
    points.forEach(p => { p.lineIndex = null; p.name = null; p.customName = null; p.deleted = delSet.has(p.rowIndex); });
    dividers = normalizarDivisorias(d.dividers);
    guide = Array.isArray(d.guide) ? d.guide : [];
    points.forEach(p => { p.h = guide.length >= 2 ? chainage(p.e, p.n) : p.hPCA; });
    const byRow = {}; points.forEach(p => { byRow[p.rowIndex] = p; });
    lines = d.lines.map((l, li) => {
        const pts = l.pts.map(o => { const p = byRow[o.r]; if (p) { p.lineIndex = li; p.customName = o.c; } return p; }).filter(Boolean);
        const line = { letra: l.letra, color: l.color, inverted: l.inverted, points: pts }; renumerar(line); return line;
    });
    currentLineIndex = (d.cur != null && d.cur < lines.length) ? d.cur : -1;
    atualizarPainelLinhas(); atualizarPainelDivisorias(); atualizarPainelGuia(); atualizarExcluidos(); atualizarStatus(); salvarAutosave(); draw();
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
    return points.filter(p => !p.deleted && CATS_LINHA.has(p.cat) && !chaveLinha(p));
}
// Mostra/esconde o aviso de grampos sem nomenclatura.
function atualizarAvisoSemNome() {
    const box = document.getElementById('aviso-sem-nome');
    const alvo = points.filter(p => !p.deleted && CATS_LINHA.has(p.cat));
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

// Núcleo da detecção: agrupa os grampos com nome de linha e monta as linhas.
function montarLinhasDetectadas(comNome) {
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
}
// Carregamento automático (visualizador): sem confirmações nem avisos.
let autoDetectou = false;
function detectarLinhasAuto() {
    const comNome = points.filter(p => !p.deleted && CATS_LINHA.has(p.cat) && chaveLinha(p));
    if (!comNome.length) return;
    montarLinhasDetectadas(comNome);
    autoDetectou = true;
    salvarAutosave();
}
// Infere divisórias pela numeração original do CSV: quando a sequência de uma
// linha "reinicia" (ex.: ...A32, A1, A2...), há uma partição do talude ali.
function inferirDivisorias() {
    if (dividers.length || !lines.length) return;
    const cortes = []; // posições (h) dos reinícios detectados
    lines.forEach(line => {
        const re = new RegExp('^' + line.letra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-?\\s*(\\d+)$', 'i');
        let prevNum = null, prevP = null;
        line.points.forEach(p => {
            const m = (p.id || '').trim().match(re);
            if (!m) return;
            const num = parseInt(m[1], 10);
            // salto grande na numeração = fronteira entre seções
            if (prevNum != null && Math.abs(num - prevNum) >= 5) cortes.push((prevP.h + p.h) / 2);
            prevNum = num; prevP = p;
        });
    });
    if (!cortes.length) return;
    cortes.sort((a, b) => a - b);
    // agrupa cortes próximos (a mesma divisa é vista por várias linhas)
    const grupos = [];
    cortes.forEach(h => {
        const g = grupos[grupos.length - 1];
        if (g && h - g[g.length - 1] < 8) g.push(h); else grupos.push([h]);
    });
    // só vira divisa o grupo com apoio de várias linhas (descarta saltos isolados
    // de numeração/ordenação que não são partição do talude)
    const apoioMin = Math.max(2, Math.ceil(cortes.length / 4));
    const validos = grupos.filter(g => g.length >= apoioMin);
    if (!validos.length) return;
    let minElev = Infinity, maxElev = -Infinity;
    points.forEach(p => { if (!p.deleted) { if (p.elev < minElev) minElev = p.elev; if (p.elev > maxElev) maxElev = p.elev; } });
    validos.forEach((g, i) => {
        const h = g.reduce((s, v) => s + v, 0) / g.length;
        dividers.push({ name: 'Divisa ' + (i + 1), pts: [{ h, elev: maxElev + 2 }, { h, elev: minElev - 2 }] });
    });
    lines.forEach(renumerar);
    salvarAutosave();
}
// Agrupa os grampos em linhas a partir dos nomes do CSV original (botão).
function detectarLinhas() {
    const alvo = points.filter(p => !p.deleted && CATS_LINHA.has(p.cat));
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
    montarLinhasDetectadas(comNome);
    inferirDivisorias(); // não sobrescreve divisórias já existentes
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
    // sentido efetivo = "Inverter" da linha XOR numeração invertida do talude
    const inv = line.inverted !== numInvertido;
    if (pts.length <= 2) { if (inv) pts.reverse(); return; }
    const restante = pts.slice();
    let ini = 0;
    for (let i = 1; i < restante.length; i++) {
        if (inv ? worldX(restante[i]) < worldX(restante[ini]) : worldX(restante[i]) > worldX(restante[ini])) ini = i;
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
    // Se o nome editado terminar em "letra + número" (ex.: "A5"), a sequência continua dele (A6, A7...).
    const re = new RegExp('^' + line.letra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*-?\\s*(\\d+)$', 'i');
    line.points.forEach(p => {
        if (prev && cruzaDivisoria(prev, p)) contador = 1; // recomeça após cruzar a divisa
        if (p.customName) {
            p.name = p.customName;
            const m = p.customName.trim().match(re);
            if (m) contador = parseInt(m[1], 10) + 1;
        } else { p.name = line.letra + contador; contador++; }
        prev = p;
    });
}
function reordenarENumerar(line) { ordenarLinha(line); renumerar(line); }

function removerDeLinhaSilencioso(p) {
    const line = lines[p.lineIndex]; const idx = line.points.indexOf(p); if (idx >= 0) line.points.splice(idx, 1);
    p.lineIndex = null; p.name = null; p.customName = null; reordenarENumerar(line);
}
function clicarPonto(p) {
    // Clicar num ponto de outra linha entra automaticamente na edição dela (com foco no card).
    if (p.lineIndex != null && p.lineIndex !== currentLineIndex) {
        focarLinha(p.lineIndex); return;
    }
    if (currentLineIndex < 0) { alert('Crie ou selecione uma linha primeiro.'); return; }
    pushUndo();
    if (p.lineIndex === currentLineIndex) { removerDeLinhaSilencioso(p); }
    else { lines[currentLineIndex].points.push(p); p.lineIndex = currentLineIndex; reordenarENumerar(lines[currentLineIndex]); }
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
// Caixa/contorno: pontos livres entram na linha atual; se a seleção só tem
// pontos da linha atual, eles são removidos dela.
function aplicarSelecao(lista) {
    if (modoExcluir) { excluirVarios(lista); return; }
    if (lista.length === 0) return;
    const novos = lista.filter(p => p.lineIndex == null);
    if (novos.length) { adicionarVarios(novos); return; }
    if (currentLineIndex < 0) return;
    const daLinha = lista.filter(p => p.lineIndex === currentLineIndex);
    if (!daLinha.length) return;
    pushUndo();
    const line = lines[currentLineIndex];
    daLinha.forEach(p => { const i = line.points.indexOf(p); if (i >= 0) line.points.splice(i, 1); p.lineIndex = null; p.name = null; p.customName = null; });
    reordenarENumerar(line); posMudanca();
}
function selecionarCaixaMundo(wx0, wy0, wx1, wy1) {
    const x0 = Math.min(wx0, wx1), x1 = Math.max(wx0, wx1), y0 = Math.min(wy0, wy1), y1 = Math.max(wy0, wy1);
    aplicarSelecao(points.filter(p => catVisivel(p) && worldX(p) >= x0 && worldX(p) <= x1 && worldY(p) >= y0 && worldY(p) <= y1));
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
    aplicarSelecao(points.filter(p => catVisivel(p) && pontoEmPoligono(p, poly)));
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

// Modo visualização: clique num ponto mostra nome e coordenadas.
// --- Medição de distância (2D e edição) ---
function alternarMedir() {
    medindo = !medindo; medA = null; medB = null;
    document.getElementById('btn-medir').classList.toggle('ativo', medindo);
    if (medindo && modoExcluir) alternarModoExcluir();
    atualizarStatus(); draw();
}
function registrarMedicao(p) {
    if (!medA || medB) { medA = p; medB = null; fecharInfoPonto(); }
    else if (p !== medA) { medB = p; mostrarInfoMedicao(); }
    draw();
}
function mostrarInfoMedicao() {
    const dE = medB.e - medA.e, dN = medB.n - medA.n, dZ = medB.elev - medA.elev;
    const dH = Math.hypot(dE, dN), d3 = Math.hypot(dH, dZ);
    document.getElementById('ponto-info-titulo').textContent = 'Distância';
    document.getElementById('ponto-info-corpo').innerHTML =
        `<b>${escapeHtml(medA.name || medA.id)}</b> → <b>${escapeHtml(medB.name || medB.id)}</b><br>` +
        `Distância 3D: <b>${d3.toFixed(2)} m</b><br>` +
        `Horizontal: ${dH.toFixed(2)} m<br>` +
        `Desnível: ${dZ >= 0 ? '+' : ''}${dZ.toFixed(2)} m`;
    document.getElementById('ponto-info').classList.remove('hidden');
}

function mostrarInfoPonto(p) {
    document.getElementById('ponto-info-titulo').textContent = 'Ponto selecionado';
    const corpo = document.getElementById('ponto-info-corpo');
    let html = `<b>${escapeHtml(p.name || p.id)}</b><br>`;
    if (p.name && p.name !== p.id) html += `<small>Nome original: ${escapeHtml(p.id)}</small><br>`;
    if (p.lineIndex != null) html += `Linha: <b>${escapeHtml(lines[p.lineIndex].letra)}</b><br>`;
    html += `Categoria: ${CAT_LABEL[p.cat]}<br>`;
    html += `E: ${p.e.toFixed(3)}<br>N: ${p.n.toFixed(3)}<br>Cota: ${p.elev.toFixed(3)}`;
    corpo.innerHTML = html;
    document.getElementById('ponto-info').classList.remove('hidden');
}
function fecharInfoPonto() { document.getElementById('ponto-info').classList.add('hidden'); }

function editarPonto(p) {
    if (p.lineIndex == null) { alert('Esse ponto ainda não está em nenhuma linha.'); return; }
    const s = toScreen(p);
    abrirMiniCard(s.x + 14, s.y - 10, 'Nome do ponto (vazio = automático)', p.customName || p.name || '', (novo) => {
        pushUndo(); p.customName = (novo || '').trim() || null; renumerar(lines[p.lineIndex]); posMudanca();
    });
}
function posMudanca() { atualizarPainelLinhas(); atualizarPainelDivisorias(); atualizarPainelGuia(); atualizarExcluidos(); atualizarStatus(); salvarAutosave(); draw(); }

// --- Exclusão de pontos ---
function alternarModoExcluir() {
    modoExcluir = !modoExcluir;
    document.getElementById('btn-excluir-pontos').classList.toggle('ativo', modoExcluir);
    atualizarStatus();
}
function excluirVarios(lista) {
    if (!lista.length) return;
    pushUndo();
    lista.forEach(p => {
        if (p.lineIndex != null) { const line = lines[p.lineIndex]; const i = line.points.indexOf(p); if (i >= 0) line.points.splice(i, 1); }
        p.lineIndex = null; p.name = null; p.customName = null; p.deleted = true;
    });
    lines.forEach(reordenarENumerar);
    posMudanca();
}
function restaurarExcluidos() {
    const n = points.filter(p => p.deleted).length;
    if (!n || !confirm(`Restaurar ${n} ponto(s) excluído(s)?`)) return;
    pushUndo(); points.forEach(p => { p.deleted = false; }); posMudanca();
}
function atualizarExcluidos() {
    const box = document.getElementById('excluidos-status'); if (!box) return;
    const n = points.filter(p => p.deleted).length;
    box.innerHTML = n ? `<span>${n} ponto(s) excluído(s)</span> <button id="btn-restaurar" class="btn-mini">Restaurar</button>` : '';
    const b = document.getElementById('btn-restaurar'); if (b) b.addEventListener('click', restaurarExcluidos);
}

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
    // Edição: checkboxes no card 🏷️. Visualização: legenda fixa no canto.
    const cardCont = document.getElementById('filtro-categorias');
    const fixo = document.getElementById('legenda-fixa');
    const fixoCont = document.getElementById('legenda-fixa-itens');
    cardCont.innerHTML = ''; fixoCont.innerHTML = '';
    const cont = modoEdicao ? cardCont : fixoCont;
    CATS.forEach(c => {
        const n = points.filter(p => !p.deleted && p.cat === c.key).length;
        if (n === 0) return;
        if (modoEdicao) {
            const id = 'chk-cat-' + c.key;
            const div = document.createElement('label'); div.className = 'check cat-check';
            div.innerHTML = `<input type="checkbox" id="${id}" ${enabledCats.has(c.key) ? 'checked' : ''}>
                <span class="cat-bola" style="background:${c.color}"></span> ${c.label} (${n})`;
            div.querySelector('input').addEventListener('change', (e) => {
                if (e.target.checked) enabledCats.add(c.key); else enabledCats.delete(c.key);
                hoveredPoint = null; draw();
            });
            cont.appendChild(div);
        } else {
            // Legenda (visualizador): item clicável mostra/oculta a categoria.
            const item = document.createElement('div');
            item.className = 'legenda-item' + (enabledCats.has(c.key) ? '' : ' off');
            item.title = 'Clique para mostrar/ocultar';
            item.innerHTML = `<span class="cat-bola" style="background:${c.color}"></span><span class="leg-rotulo">${c.label}</span><b>${n}</b>`;
            item.addEventListener('click', () => {
                if (enabledCats.has(c.key)) enabledCats.delete(c.key); else enabledCats.add(c.key);
                hoveredPoint = null; montarFiltroCategorias(); draw();
            });
            cont.appendChild(item);
        }
    });
    // Telas de proteção (áreas) — item único de liga/desliga
    if (areas.length) {
        if (modoEdicao) {
            const div = document.createElement('label'); div.className = 'check cat-check';
            div.innerHTML = `<input type="checkbox" ${showAreas ? 'checked' : ''}>
                <span class="cat-bola" style="background:${areas[0].cor}"></span> Telas de proteção (${areas.length})`;
            div.querySelector('input').addEventListener('change', (e) => { showAreas = e.target.checked; draw(); });
            cont.appendChild(div);
        } else {
            const item = document.createElement('div');
            item.className = 'legenda-item' + (showAreas ? '' : ' off');
            item.title = 'Clique para mostrar/ocultar';
            item.innerHTML = `<span class="cat-bola" style="background:${areas[0].cor}"></span><span class="leg-rotulo">Telas de proteção</span><b>${areas.length}</b>`;
            item.addEventListener('click', () => { showAreas = !showAreas; montarFiltroCategorias(); draw(); });
            cont.appendChild(item);
        }
    }
    // Legenda fixa só aparece no modo visualização e quando há itens.
    fixo.classList.toggle('hidden', modoEdicao || fixoCont.childElementCount === 0);
}
function atualizarPainelLinhas() {
    const cont = document.getElementById('lista-linhas');
    if (lines.length === 0) { cont.innerHTML = '<small>Nenhuma linha ainda.</small>'; return; }
    cont.innerHTML = '';
    lines.forEach((line, li) => {
        const div = document.createElement('div');
        const aberta = li === currentLineIndex;
        div.className = 'linha-item' + (aberta ? ' ativa aberta' : '');
        div.title = aberta ? '' : 'Clique para selecionar e abrir esta linha';
        const nomes = line.points.map(p => p.name).join(', ') || '—';
        div.innerHTML = `<div class="linha-item-cabecalho">
                <span class="linha-cor" style="background:${line.color}" title="Clique para trocar a cor"><input type="color" value="${line.color}"></span>
                <span class="linha-titulo">Linha ${line.letra}</span>
                <span class="linha-contagem">${line.points.length} grampos</span></div>
            <div class="linha-nomes">${nomes}</div>
            <div class="linha-acoes">
                <button class="btn-mini btn-inv">Inverter</button>
                <button class="btn-mini btn-ren">Renomear</button>
                <button class="btn-mini btn-del">Excluir</button></div>`;
        div.addEventListener('click', () => { if (currentLineIndex !== li) focarLinha(li); });
        div.querySelector('.btn-inv').addEventListener('click', (e) => { e.stopPropagation(); inverterLinha(li); });
        div.querySelector('.btn-ren').addEventListener('click', (e) => { e.stopPropagation(); renomearLinha(li, e); });
        div.querySelector('.btn-del').addEventListener('click', (e) => { e.stopPropagation(); excluirLinha(li); });
        // Troca de cor: clique na bolinha abre o seletor RGB do navegador.
        const corInput = div.querySelector('.linha-cor input');
        let corDirty = false;
        corInput.addEventListener('click', (e) => e.stopPropagation());
        corInput.addEventListener('input', (e) => {
            if (!corDirty) { pushUndo(); corDirty = true; }
            line.color = e.target.value;
            div.querySelector('.linha-cor').style.background = line.color;
            salvarAutosave(); draw();
        });
        corInput.addEventListener('change', () => { corDirty = false; atualizarPainelLinhas(); });
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
    let html = `Pontos ativos: <b>${ativos().length}</b><br>Atribuídos a linhas: <b>${atribuidos}</b><br>Linhas: <b>${lines.length}</b> &middot; Divisórias: <b>${dividers.length}</b>`;
    if (medindo) html = `<b style="color:#0a7d4b">Medir:</b> clique no 1º ponto e depois no 2º. (Esc sai)<br>` + html;
    else if (modoExcluir) html = `<b style="color:#c0392b">Excluir pontos:</b> clique, caixa ou contorno excluem. (Esc sai)<br>` + html;
    else if (addingDivider) html = `<b style="color:#c0392b">Divisória:</b> clique para adicionar vértices; <b>duplo-clique</b> ou <b>Enter</b> conclui. (Esc cancela)<br>` + html;
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
    const del = new Set(points.filter(p => p.deleted).map(p => p.rowIndex));
    const out = originalRows
        .map((parts, idx) => del.has(idx) ? null : (() => { const c = parts.slice(); if (novoNome[idx] != null) c[0] = novoNome[idx]; return c.join(delimiter); })())
        .filter(l => l !== null);
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
const pdfState = { desenhoImg: null, desenhoAspect: 1, bgImg: null, k: 1, fitK: 1, zoom: 1, layout: null, drag: null, sel: null, fs: { info: 1, counts: 1, legend: 1 } };
let PDF_KEY = STORAGE_KEY + ':pdf';

// Layout/campos do montador salvos por talude.
function salvarLayoutPdf() {
    if (!pdfState.layout) return;
    try {
        localStorage.setItem(PDF_KEY, JSON.stringify({
            layout: pdfState.layout, fs: pdfState.fs,
            size: el('pdf-size').value, orient: el('pdf-orient').value,
            campos: { titulo: el('pdf-titulo').value, projeto: el('pdf-projeto').value, data: el('pdf-data').value, obs: el('pdf-obs').value },
            shows: { info: el('pdf-show-info').checked, counts: el('pdf-show-counts').checked, legend: el('pdf-show-legend').checked },
        }));
    } catch (e) {}
}
function restaurarLayoutPdf() {
    let d; try { d = JSON.parse(localStorage.getItem(PDF_KEY)); } catch (e) { return false; }
    if (!d || !d.layout) return false;
    pdfState.layout = d.layout;
    if (d.fs) { pdfState.fs = d.fs; [['info'], ['counts'], ['legend']].forEach(([k]) => { const s = el('pdf-fs-' + k); if (s) s.value = pdfState.fs[k]; }); }
    if (d.size) el('pdf-size').value = d.size;
    if (d.orient) el('pdf-orient').value = d.orient;
    if (d.campos) { el('pdf-titulo').value = d.campos.titulo || ''; el('pdf-projeto').value = d.campos.projeto || ''; el('pdf-data').value = d.campos.data || ''; el('pdf-obs').value = d.campos.obs || ''; }
    if (d.shows) { el('pdf-show-info').checked = !!d.shows.info; el('pdf-show-counts').checked = !!d.shows.counts; el('pdf-show-legend').checked = !!d.shows.legend; }
    return true;
}
function layoutPadrao() {
    const pg = pageMm();
    return {
        desenho: { x: pg.w * 0.04, y: pg.h * 0.06, w: pg.w * 0.6 },
        info: { x: pg.w * 0.67, y: pg.h * 0.06 },
        counts: { x: pg.w * 0.67, y: pg.h * 0.30 },
        legend: { x: pg.w * 0.67, y: pg.h * 0.70 },
    };
}
function selecionarBloco(key) {
    pdfState.sel = key;
    ['desenho', 'info', 'counts', 'legend'].forEach(k => el('pdf-el-' + k).classList.toggle('sel', k === key));
}
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
    const arr = []; CATS.forEach(c => { const n = points.filter(p => !p.deleted && p.cat === c.key).length; if (n > 0) arr.push({ label: c.label, n, color: c.color }); });
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
    if (!restaurarLayoutPdf()) pdfState.layout = layoutPadrao();
    if (!el('pdf-titulo').value) el('pdf-titulo').value = nomeTalude;
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

    // Alça de tamanho na própria caixa (arrasta para cima/baixo = menor/maior).
    ['info', 'counts', 'legend'].forEach(k => {
        const d = el('pdf-el-' + k);
        if (!d.querySelector('.pdf-fs-handle')) {
            const h = document.createElement('span');
            h.className = 'pdf-fs-handle';
            h.title = 'Arraste para ajustar o tamanho do texto';
            d.appendChild(h);
        }
    });
}

function layoutPagina() {
    const pg = pageMm();
    const stage = document.querySelector('.pdf-stage');
    pdfState.fitK = Math.min((stage.clientWidth - 40) / pg.w, (stage.clientHeight - 40) / pg.h);
    pdfState.k = pdfState.fitK * pdfState.zoom;
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

// Desenha o talude em VETOR dentro do retângulo (mm) — sem pixelização.
function desenharVetorPDF(pdf, rect, pt) {
    const vis = points.filter(catVisivel);
    if (!vis.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    vis.forEach(p => { const x = worldX(p), y = worldY(p); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; });
    const mg = 5; // margem interna (mm)
    const s = Math.min((rect.w - 2 * mg) / Math.max(maxX - minX, 1e-6), (rect.h - 2 * mg) / Math.max(maxY - minY, 1e-6));
    const ox = rect.x + (rect.w - (minX + maxX) * s) / 2;
    const oy = rect.y + (rect.h - (minY + maxY) * s) / 2;
    const X = p => ox + worldX(p) * s, Y = p => oy + worldY(p) * s;

    // Polilinhas das linhas
    pdf.setLineWidth(0.25);
    lines.forEach(line => {
        if (line.points.length < 2) return;
        const rgb = hexRgb(line.color); pdf.setDrawColor(rgb[0], rgb[1], rgb[2]);
        for (let i = 0; i < line.points.length - 1; i++) pdf.line(X(line.points[i]), Y(line.points[i]), X(line.points[i + 1]), Y(line.points[i + 1]));
    });
    // Divisórias (tracejadas, nome no pé)
    if (dividers.length) {
        pdf.setDrawColor(51, 51, 51); pdf.setLineWidth(0.3); pdf.setLineDashPattern([2, 1.5], 0);
        dividers.forEach(d => {
            const t = d.pts.map(v => ({ x: ox + (flipH ? -v.h : v.h) * s, y: oy + (-v.elev * exagero) * s }));
            for (let i = 0; i < t.length - 1; i++) pdf.line(t[i].x, t[i].y, t[i + 1].x, t[i + 1].y);
            if (d.name) {
                const pe = t.reduce((a, b) => b.y > a.y ? b : a);
                pdf.setFont('helvetica', 'bold'); pdf.setFontSize(pt(2.6)); pdf.setTextColor(34, 34, 34);
                pdf.text(d.name, pe.x, pe.y + 3.4, { align: 'center' });
                pdf.setFont('helvetica', 'normal');
            }
        });
        pdf.setLineDashPattern([], 0);
    }
    // Pontos
    vis.forEach(p => {
        const rgb = hexRgb(p.lineIndex != null ? lines[p.lineIndex].color : CAT_COLOR[p.cat]);
        pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
        pdf.circle(X(p), Y(p), 0.65, 'F');
    });
    // Nomes (prioriza o renomeado; senão o do CSV) com o ângulo configurado
    pdf.setTextColor(17, 17, 17); pdf.setFontSize(pt(2.2 * (nameSize / 11)));
    vis.forEach(p => {
        const rot = p.name || p.id; if (!rot) return;
        pdf.text(rot, X(p) + 0.9, Y(p) - 0.9, { angle: nameAngle });
    });
    pdf.setTextColor(0, 0, 0);
}

function gerarPDF() {
    const { jsPDF } = window.jspdf;
    const pg = pageMm();
    const pdf = new jsPDF({ orientation: pg.w >= pg.h ? 'landscape' : 'portrait', unit: 'mm', format: [pg.w, pg.h] });
    const L = pdfState.layout, pt = mm => mm / 0.352777;
    if (pdfState.bgImg) pdf.addImage(pdfState.bgImg, 'PNG', 0, 0, pg.w, pg.h);
    desenharVetorPDF(pdf, { x: L.desenho.x, y: L.desenho.y, w: L.desenho.w, h: L.desenho.w / pdfState.desenhoAspect }, pt);

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
        pdf.text(`Total: ${ativos().length}`, L.counts.x, y); y += 6 * s;
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

function mostrarGuias(vx, hy) {
    const gv = el('pdf-guia-v'), gh = el('pdf-guia-h'), k = pdfState.k;
    gv.style.display = vx == null ? 'none' : 'block';
    gh.style.display = hy == null ? 'none' : 'block';
    if (vx != null) gv.style.left = vx * k + 'px';
    if (hy != null) gh.style.top = hy * k + 'px';
}
function ligarArrastePrancha() {
    const page = el('pdf-page');
    page.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('pdf-fs-handle')) {
            const key = e.target.parentElement.dataset.el;
            selecionarBloco(key);
            pdfState.drag = { mode: 'fs', key, startY: e.clientY, startFs: pdfState.fs[key] };
            e.preventDefault(); return;
        }
        const handle = e.target.classList.contains('pdf-resize');
        const elDiv = e.target.closest('.pdf-el');
        if (!handle && !elDiv) { selecionarBloco(null); return; }
        const r = page.getBoundingClientRect(), k = pdfState.k;
        const mmx = (e.clientX - r.left) / k, mmy = (e.clientY - r.top) / k;
        if (handle) pdfState.drag = { mode: 'resize' };
        else {
            const key = elDiv.dataset.el;
            selecionarBloco(key);
            pdfState.drag = { mode: 'move', key, offx: mmx - pdfState.layout[key].x, offy: mmy - pdfState.layout[key].y };
        }
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!pdfState.drag) return;
        if (pdfState.drag.mode === 'fs') {
            const fator = 1 + (e.clientY - pdfState.drag.startY) / 120;
            pdfState.fs[pdfState.drag.key] = Math.min(4, Math.max(0.4, pdfState.drag.startFs * fator));
            posicionar(); return;
        }
        const r = page.getBoundingClientRect(), k = pdfState.k;
        const mmx = (e.clientX - r.left) / k, mmy = (e.clientY - r.top) / k;
        if (pdfState.drag.mode === 'resize') { pdfState.layout.desenho.w = Math.max(20, mmx - pdfState.layout.desenho.x); posicionar(); return; }
        const key = pdfState.drag.key, L = pdfState.layout[key];
        L.x = mmx - pdfState.drag.offx; L.y = mmy - pdfState.drag.offy;
        // snap ao centro da folha (blocos): centro do bloco a até 3 mm do centro da página
        const pg = pageMm(), elDiv = el('pdf-el-' + key);
        const wMm = elDiv.offsetWidth / k, hMm = elDiv.offsetHeight / k;
        let gx = null, gy = null;
        if (Math.abs(L.x + wMm / 2 - pg.w / 2) < 3) { L.x = pg.w / 2 - wMm / 2; gx = pg.w / 2; }
        if (Math.abs(L.y + hMm / 2 - pg.h / 2) < 3) { L.y = pg.h / 2 - hMm / 2; gy = pg.h / 2; }
        mostrarGuias(gx, gy);
        posicionar();
    });
    window.addEventListener('mouseup', () => {
        if (pdfState.drag) { pdfState.drag = null; mostrarGuias(null, null); salvarLayoutPdf(); }
    });
}

// =============================================================
//  Autosave
// =============================================================
function salvarAutosave() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ flipH, nameAngle, nameSize, dividers, guide, del: points.filter(p => p.deleted).map(p => p.rowIndex), lines: lines.map(l => ({ letra: l.letra, color: l.color, inverted: !!l.inverted, pts: l.points.map(p => ({ r: p.rowIndex, c: p.customName || null })) })) })); } catch (e) {}
}
function restaurarAutosave() {
    let dados; try { dados = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { return false; }
    if (!dados || !dados.lines) return false;
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
    if (Array.isArray(dados.del)) { const ds = new Set(dados.del); points.forEach(p => { if (ds.has(p.rowIndex)) p.deleted = true; }); }
    const byRow = {}; points.forEach(p => { byRow[p.rowIndex] = p; });
    lines = dados.lines.map((l, li) => {
        const pts = (l.pts || []).map(o => { const p = byRow[o.r]; if (p) { p.lineIndex = li; p.customName = o.c; } return p; }).filter(Boolean);
        const line = { letra: l.letra, color: l.color || PALETTE[li % PALETTE.length], inverted: !!l.inverted, points: pts }; renumerar(line); return line;
    });
    if (lines.length > 0) currentLineIndex = lines.length - 1;
    return true;
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
    if (modoExcluir) { modoExcluir = false; document.getElementById('btn-excluir-pontos').classList.remove('ativo'); }
    if (medindo) { medindo = false; medA = null; medB = null; document.getElementById('btn-medir').classList.remove('ativo'); }
    diviPts = []; guiaPts = []; diviMouse = null; atualizarStatus();
}

canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (e.button === 1 || spaceDown || e.ctrlKey) { pointer.down = true; pointer.panning = true; pointer.lastX = mx; pointer.lastY = my; e.preventDefault(); return; }
    if (e.button !== 0) return;
    // Modo visualização (ou medição): arrastar = mover a tela; clique num ponto = informações/medida.
    if (!modoEdicao || medindo) {
        pointer.down = true; pointer.panning = true;
        pointer.startX = mx; pointer.startY = my; pointer.lastX = mx; pointer.lastY = my;
        pointer.downPoint = pontoEm(mx, my);
        e.preventDefault(); return;
    }
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
    if (pointer.panning) {
        pointer.panning = false;
        // Visualizador/medição: clique parado sobre um ponto (ou área) abre informações/medida.
        if (!modoEdicao || medindo) {
            const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            if (Math.abs(mx - pointer.startX) + Math.abs(my - pointer.startY) < 5) {
                if (medindo) { if (pointer.downPoint) registrarMedicao(pointer.downPoint); }
                else if (pointer.downPoint) mostrarInfoPonto(pointer.downPoint);
                else if (!topView) { const w = telaParaMundo(mx, my); const a = areaEm(w.wx, w.wy); if (a) mostrarInfoArea(a); }
            }
        }
        pointer.downPoint = null;
        return;
    }

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
    } else if (pointer.downPoint) { if (modoExcluir) excluirVarios([pointer.downPoint]); else clicarPonto(pointer.downPoint); }
    else { const w = telaParaMundo(mx, my); boxArmed = { wx: w.wx, wy: w.wy }; boxPreview = { x0: mx, y0: my, x1: mx, y1: my }; draw(); }
    pointer.downPoint = null; pointer.dragging = false;
});

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault(); const rect = canvas.getBoundingClientRect();
    const p = pontoEm(e.clientX - rect.left, e.clientY - rect.top);
    if (!p) return;
    if (modoEdicao) editarPonto(p); else mostrarInfoPonto(p);
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
    // Modal do PDF aberto: Esc fecha; setas movem o bloco selecionado (1 mm; Shift = 5 mm).
    if (!document.getElementById('pdf-modal').classList.contains('hidden')) {
        if (e.key === 'Escape') { fecharPdfModal(); return; }
        if (pdfState.sel && e.key.startsWith('Arrow') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
            e.preventDefault();
            const passo = e.shiftKey ? 5 : 1, L = pdfState.layout[pdfState.sel];
            if (e.key === 'ArrowLeft') L.x -= passo; if (e.key === 'ArrowRight') L.x += passo;
            if (e.key === 'ArrowUp') L.y -= passo; if (e.key === 'ArrowDown') L.y += passo;
            posicionar(); salvarLayoutPdf();
        }
        return;
    }
    const ajudaModal = document.getElementById('ajuda-modal');
    if (e.key === 'Escape' && !ajudaModal.classList.contains('hidden')) { ajudaModal.classList.add('hidden'); return; }
    const edModal = document.getElementById('editar-modal');
    if (e.key === 'Escape' && !edModal.classList.contains('hidden')) { edModal.classList.add('hidden'); return; }
    if (e.key === 'Escape' && !document.getElementById('ponto-info').classList.contains('hidden')) { fecharInfoPonto(); return; }
    if (e.key === 'Escape' && document.querySelector('.tool-card:not(.hidden)')) { fecharCards(); return; }
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
document.getElementById('btn-excluir-pontos').addEventListener('click', alternarModoExcluir);
document.getElementById('btn-medir').addEventListener('click', alternarMedir);
document.getElementById('btn-abrir-csv').addEventListener('click', () => document.getElementById('csv-local').click());
document.getElementById('csv-local').addEventListener('change', (e) => {
    if (e.target.files[0]) carregarCsvLocal(e.target.files[0]);
    e.target.value = ''; // permite reabrir o mesmo arquivo
});

// Link cruzado 2D -> 3D (quando o glb é conhecido via URL)
(function () {
    const glb = params.get('glb');
    if (!glb) return;
    const p3 = new URLSearchParams({ v: '2', glb, csv: csvFileURL });
    if (params.get('data')) p3.set('data', params.get('data'));
    if (areasFileURL) p3.set('areas', areasFileURL);
    p3.set('nome', nomeTalude);
    const a = document.getElementById('link-3d');
    a.href = 'visualizador.html?' + p3.toString();
    a.style.display = '';
})();

// Toolbar de ícones: cada ícone abre/fecha o seu card (um por vez)
document.querySelectorAll('#toolbar .tool-btn[data-card]').forEach(btn => {
    btn.addEventListener('click', () => {
        const card = document.getElementById(btn.dataset.card);
        const abrir = card.classList.contains('hidden');
        fecharCards();
        if (abrir) { card.classList.remove('hidden'); btn.classList.add('ativo'); }
    });
});
document.querySelectorAll('.tool-card-x').forEach(x => x.addEventListener('click', fecharCards));

// Modo visualização <-> edição
const editarModal = document.getElementById('editar-modal');
document.getElementById('btn-editar').addEventListener('click', () => editarModal.classList.remove('hidden'));
document.getElementById('editar-cancelar').addEventListener('click', () => editarModal.classList.add('hidden'));
document.getElementById('editar-continuar').addEventListener('click', () => { editarModal.classList.add('hidden'); setModo(true); });
editarModal.addEventListener('click', (e) => { if (e.target === editarModal) editarModal.classList.add('hidden'); });
document.getElementById('ponto-info-fechar').addEventListener('click', fecharInfoPonto);
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
document.getElementById('btn-vista').addEventListener('click', exportarVista);
document.getElementById('btn-pdf').addEventListener('click', abrirPdfModal);
document.getElementById('btn-limpar').addEventListener('click', limparTudo);

// --- Modal de montagem do PDF ---
ligarArrastePrancha();
el('pdf-fechar').addEventListener('click', fecharPdfModal);
el('pdf-gerar').addEventListener('click', gerarPDF);
el('pdf-bg').addEventListener('change', (e) => { if (e.target.files[0]) carregarFundoPDF(e.target.files[0]); });
el('pdf-size').addEventListener('change', () => { layoutPagina(); salvarLayoutPdf(); });
el('pdf-orient').addEventListener('change', () => { layoutPagina(); salvarLayoutPdf(); });
['pdf-titulo', 'pdf-projeto', 'pdf-data', 'pdf-obs', 'pdf-show-info', 'pdf-show-counts', 'pdf-show-legend'].forEach(id => {
    el(id).addEventListener('input', () => { construirConteudo(); posicionar(); salvarLayoutPdf(); });
    el(id).addEventListener('change', () => { construirConteudo(); posicionar(); salvarLayoutPdf(); });
});
// Zoom da prancha e redefinição do layout
el('pdf-zoom').addEventListener('input', () => { pdfState.zoom = parseFloat(el('pdf-zoom').value); layoutPagina(); });
el('pdf-zoom-fit').addEventListener('click', () => { pdfState.zoom = 1; el('pdf-zoom').value = '1'; layoutPagina(); });
el('pdf-redefinir').addEventListener('click', () => {
    if (!confirm('Redefinir o layout da prancha para o padrão?')) return;
    try { localStorage.removeItem(PDF_KEY); } catch (e) {}
    pdfState.layout = layoutPadrao(); pdfState.fs = { info: 1, counts: 1, legend: 1 };
    construirConteudo(); layoutPagina();
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
