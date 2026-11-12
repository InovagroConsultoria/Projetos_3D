// =============================================================
//  Leitura de pontos (.csv / .txt) em qualquer formato comum
// =============================================================
// Usada pelo visualizador 3D e pela visualização 2D. Aceita:
//   - separador vírgula, ponto e vírgula, TAB, barra vertical ou espaços;
//   - decimal com ponto ou com vírgula (CSV do Excel em português);
//   - com ou sem cabeçalho (Ponto/Nome, E/Este/X, N/Norte/Y, Z/Cota/Elev, Descrição);
//   - colunas em qualquer ordem: PNEZ, PENZ, PEZN (formato antigo), ENZP...
// Sem cabeçalho, as colunas são reconhecidas pela grandeza dos valores em
// UTM: o Norte tem 7 dígitos (milhões), o Este tem 6 e a cota é pequena.

export const PAPEIS = ['nome', 'e', 'n', 'z', 'desc'];
export const ROTULO_PAPEL = { nome: 'Nome do ponto', e: 'Este (E)', n: 'Norte (N)', z: 'Cota (Z)', desc: 'Descrição' };
const NOME_SEP = { '\t': 'TAB', ';': 'ponto e vírgula', ',': 'vírgula', '|': 'barra vertical', ' ': 'espaços' };

// Cabeçalhos reconhecidos (comparados sem acento, maiúsculas, espaços ou unidade).
const SINONIMOS = {
    nome: /^(ponto|pontos|pto|pt|nome|name|id|point|pointid|pointname|ptname|numero|num|estaca|grampo)$/,
    e: /^(e|x|este|leste|easting|coordx|coorde|utme)m?$/,
    n: /^(n|y|norte|northing|coordy|coordn|utmn)m?$/,
    z: /^(z|h|cota|cotas|elev|elevacao|elevation|altitude|alt|altura)m?$/,
    desc: /^(desc|descricao|description|obs|observacao|observacoes|codigo|cod|code|tipo|comentario)$/,
};
// Formato antigo dos levantamentos: Ponto, E, Cota, N (ainda o mais usado aqui).
const LEGADO = { nome: 0, e: 1, z: 2, n: 3, desc: -1 };

function normalizar(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Número de um campo; aceita "309.203", "309,203" e, se o arquivo usar
// decimal com vírgula, "6.716.233,286". Texto qualquer vira NaN.
export function numero(campo, decimalVirgula) {
    let t = String(campo ?? '').trim();
    if (!t) return NaN;
    if (/^[-+]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
    else if (decimalVirgula && /^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : NaN;
}

// O separador é o que divide o maior número de linhas na mesma quantidade de
// campos (>= 3). Assim linhas de título no topo não atrapalham. No empate vale a
// ordem da lista: ";" antes de "," para não confundir com o decimal com vírgula.
function detectarSeparador(amostra) {
    let melhor = ' ', melhorNota = 0;
    for (const c of ['\t', ';', '|', ',', ' ']) {
        const contagem = {};
        amostra.forEach(l => { const k = dividir(l, c).length; if (k >= 3) contagem[k] = (contagem[k] || 0) + 1; });
        const nota = Math.max(0, ...Object.values(contagem));
        if (nota > melhorNota) { melhor = c; melhorNota = nota; }
    }
    return melhor;
}

function dividir(linha, sep) {
    const campos = sep === ' ' ? linha.trim().split(/\s+/) : linha.split(sep);
    return campos.map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
}

function mediana(v) {
    if (!v.length) return NaN;
    const s = v.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Estatística de cada coluna nas linhas de dados (para reconhecer pela grandeza).
function estatisticas(linhas, inicio, dec) {
    const amostra = linhas.slice(inicio, inicio + 300);
    const ncols = Math.max(0, ...amostra.map(r => r.length));
    const out = [];
    for (let j = 0; j < ncols; j++) {
        const vals = amostra.map(r => (r[j] ?? '').trim()).filter(v => v !== '');
        const nums = vals.map(v => numero(v, dec)).filter(Number.isFinite);
        out.push({
            j,
            preenchida: amostra.length ? vals.length / amostra.length : 0,
            numerica: vals.length ? nums.length / vals.length : 0,
            med: mediana(nums.map(Math.abs)),
            decimais: mediana(vals.filter(v => Number.isFinite(numero(v, dec))).map(v => (v.split(/[.,]/).pop() || '').length)),
        });
    }
    return out;
}

// Reconhece pela grandeza os papéis que ainda faltam em `cols`.
function inferirPorValores(est, cols) {
    const usadas = new Set(Object.values(cols).filter(j => j >= 0));
    const livres = est.filter(c => !usadas.has(c.j) && c.preenchida >= 0.5);
    const numericas = livres.filter(c => c.numerica >= 0.9);
    const pegar = (filtro) => {
        const c = numericas.filter(c => !usadas.has(c.j) && filtro(c)).sort((a, b) => b.preenchida - a.preenchida || a.j - b.j)[0];
        if (c) { usadas.add(c.j); return c.j; }
        return -1;
    };
    if (cols.n < 0) cols.n = pegar(c => c.med >= 1e6 && c.med < 1e7);   // Norte UTM: milhões
    if (cols.e < 0) cols.e = pegar(c => c.med >= 1e5 && c.med < 1e6);   // Este UTM: centenas de milhar
    // Nome: nos formatos de topografia (PNEZ, PENZ...) é a 1ª coluna, inclusive
    // quando os pontos são números ("15"). Só vai para outra coluna de texto quando
    // a 1ª é coordenada (ex.: E, N, Cota, Nome) ou é a única coluna pequena (a cota).
    if (cols.nome < 0) {
        const texto = livres.find(c => !usadas.has(c.j) && c.numerica < 0.5);
        const pequenas = numericas.filter(c => !usadas.has(c.j) && c.med < 1e5);
        const c0 = est[0];
        if (c0 && !usadas.has(0) && c0.preenchida > 0 && (c0.numerica < 0.5 || pequenas.length >= 2 || !texto)) cols.nome = 0;
        else if (texto) cols.nome = texto.j;
        if (cols.nome >= 0) usadas.add(cols.nome);
    }
    if (cols.z < 0) cols.z = pegar(c => c.med < 1e5);                    // cota: valor pequeno
    if (cols.desc < 0) {
        const d = livres.find(c => !usadas.has(c.j) && c.numerica < 0.5 && c.preenchida >= 0.3);
        if (d) cols.desc = d.j;
    }
    return cols;
}

// Lê o texto do arquivo. `colunasForcadas` ({nome,e,n,z,desc}, índices; -1 = não
// tem) pula o reconhecimento — é o que vem da tela de conferência das colunas.
// Retorna também `linhas` (campos de cada linha não vazia) e `cabecalho` (índice
// da linha de cabeçalho ou -1), usados para reexportar o arquivo como veio.
export function lerPontos(texto, colunasForcadas = null) {
    const brutas = String(texto ?? '').replace(/^﻿/, '')
        .split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');
    const sep = detectarSeparador(brutas.slice(0, 30));
    const linhas = brutas.map(l => dividir(l, sep));
    // Decimal com vírgula só existe quando o separador não é vírgula.
    const decimalVirgula = sep !== ',' && linhas.slice(0, 50).some(r => r.some(c => /^[-+]?\d+,\d+$/.test(c)));

    // 1ª linha de dados: a primeira com ao menos 3 campos numéricos.
    let inicio = linhas.findIndex(r => r.filter(c => Number.isFinite(numero(c, decimalVirgula))).length >= 3);
    const avisos = [];
    if (inicio < 0) return { linhas, sep, decimalVirgula, inicio: -1, cabecalho: -1, cols: { ...LEGADO }, origem: 'vazio', pontos: [], avisos: ['Nenhuma linha com coordenadas numéricas.'] };

    let cabecalho = -1, origem;
    let cols = { nome: -1, e: -1, n: -1, z: -1, desc: -1 };
    if (colunasForcadas) {
        cols = { ...cols, ...colunasForcadas };
        origem = 'manual';
        if (inicio > 0) cabecalho = inicio - 1;
    } else {
        // Cabeçalho: a linha logo antes dos dados, se tiver nomes reconhecíveis.
        if (inicio > 0) {
            linhas[inicio - 1].forEach((campo, j) => {
                const k = normalizar(campo);
                for (const p of PAPEIS) if (cols[p] < 0 && SINONIMOS[p].test(k)) { cols[p] = j; break; }
            });
            if (PAPEIS.some(p => cols[p] >= 0)) cabecalho = inicio - 1;
        }
        const est = estatisticas(linhas, inicio, decimalVirgula);
        const ehE = (j) => est[j] && est[j].med >= 1e5 && est[j].med < 1e6;
        const ehN = (j) => est[j] && est[j].med >= 1e6 && est[j].med < 1e7;
        if (cabecalho < 0 && est.length >= 7 && ehE(4) && ehN(5)) {
            // Formato de 7+ colunas: ID, E, N, Cota, E, N, Cota (2º conjunto sempre preenchido).
            cols = { nome: 0, e: 4, n: 5, z: 6, desc: -1 };
            origem = 'legado7';
        } else {
            inferirPorValores(est, cols);
            // Cabeçalho com E e N trocados (comum com X/Y): a grandeza decide.
            if (cols.e >= 0 && cols.n >= 0 && ehN(cols.e) && ehE(cols.n)) {
                [cols.e, cols.n] = [cols.n, cols.e];
                avisos.push('As colunas de Este e Norte do cabeçalho estavam trocadas; foram corrigidas pela grandeza dos valores.');
            }
            origem = cabecalho >= 0 ? 'cabecalho' : 'valores';
            if (cols.e < 0 || cols.n < 0 || cols.z < 0) {
                // Coordenadas locais (fora da grandeza UTM): fica o formato antigo.
                cols = { ...LEGADO };
                origem = 'incerto';
                const graus = est.filter(c => c.numerica >= 0.9 && c.med <= 180 && c.decimais >= 4);
                avisos.push(graus.length >= 2
                    ? 'As coordenadas parecem latitude/longitude (graus). O visualizador usa coordenadas UTM em metros: exporte os pontos em UTM.'
                    : 'Não foi possível reconhecer as colunas pelos valores (as coordenadas não parecem UTM). Usado o formato Ponto, E, Cota, N.');
            }
        }
    }

    const pontos = [];
    for (let i = inicio; i < linhas.length; i++) {
        const r = linhas[i];
        const e = numero(r[cols.e], decimalVirgula), n = numero(r[cols.n], decimalVirgula), elev = numero(r[cols.z], decimalVirgula);
        if (!Number.isFinite(e) || !Number.isFinite(n) || !Number.isFinite(elev)) continue;
        pontos.push({
            rowIndex: i,
            id: cols.nome >= 0 ? (r[cols.nome] ?? '').trim() : '',
            e, n, elev,
            desc: cols.desc >= 0 ? (r[cols.desc] ?? '').trim() : '',
        });
    }
    return { linhas, sep, decimalVirgula, inicio, cabecalho, cols, origem, pontos, avisos };
}

// Texto curto do formato reconhecido, ex.: "ponto e vírgula · decimal vírgula · Nome, E, N, Cota".
export function descreverFormato(leitura) {
    const ordem = Object.entries(leitura.cols).filter(([, j]) => j >= 0).sort((a, b) => a[1] - b[1])
        .map(([p]) => ({ nome: 'Nome', e: 'E', n: 'N', z: 'Cota', desc: 'Descrição' })[p]);
    return `${NOME_SEP[leitura.sep]} · decimal ${leitura.decimalVirgula ? 'vírgula' : 'ponto'}${leitura.cabecalho >= 0 ? ' · com cabeçalho' : ''} · ${ordem.join(', ')}`;
}

// Arquivo-modelo para quem vai montar o CSV à mão (abre direto no Excel em português).
export function modeloCsv() {
    return 'Ponto;Este;Norte;Cota;Descricao\r\n'
        + 'A1;231611,855;6716233,286;309,203;grampo\r\n'
        + 'A2;231615,829;6716233,546;309,113;grampo\r\n'
        + 'DHP1;231617,884;6716235,486;309,138;dreno\r\n';
}
