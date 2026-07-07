import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// =============================================================
//  Parâmetros da URL
// =============================================================
// Formato esperado do CSV (SEM cabeçalho), uma linha por ponto:
//   ID , Easting , Elevação , Northing , (descrição opcional)
//   Ex.: H1-GF,231690.1881,210.091723,6714219.098,
//
// Mapeamento de eixos na cena 3D (câmera com "up" = Z):
//   eixo X (tela)  = Easting
//   eixo Y (tela)  = Northing
//   eixo Z (tela)  = Elevação  (vertical / para cima)

const labelVisibilityThreshold = 90; // distância a partir da qual os rótulos somem

const params = new URLSearchParams(window.location.search);
const glbFileURL = params.get('glb');
const csvFileURL = params.get('csv');
const areasFileURL = params.get('areas'); // telas de proteção (opcional)
const dataLevantamento = params.get('data'); // ex.: "13/06/2026" (opcional)

if (!glbFileURL || !csvFileURL) {
    // O módulo executa após o HTML ser interpretado, então a tela de carregamento já existe.
    showError("Nenhum projeto foi especificado. Selecione um talude no menu inicial.");
}

let camera, scene, renderer, labelRenderer, controls;
let currentSurface = null;
let currentPointsGroup = null;
let orientationGizmo = null;

const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.164/examples/jsm/libs/draco/gltf/');
gltfLoader.setDRACOLoader(dracoLoader);

const highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xff1493 }); // rosa pink (ponto pesquisado/selecionado)
let highlightedPoint = null;

// --- Recursos compartilhados (performance) ---
// Uma única geometria e um material por categoria são reutilizados por todos
// os pontos, em vez de criar geometria + material por ponto (milhares de objetos).
const POINT_GEOMETRY = new THREE.SphereGeometry(0.5, 8, 8);
const CATEGORY_MATERIALS = {
    dhp:        new THREE.MeshBasicMaterial({ color: 0x0000ff }), // Azul
    arr:        new THREE.MeshBasicMaterial({ color: 0xffff00 }), // Amarelo
    crista:     new THREE.MeshBasicMaterial({ color: 0x800080 }), // Roxo
    viga:       new THREE.MeshBasicMaterial({ color: 0x808080 }), // Cinza
    crvg:       new THREE.MeshBasicMaterial({ color: 0xff8c00 }), // Laranja (Grampo Crista de Viga)
    grampofech: new THREE.MeshBasicMaterial({ color: 0x00ff00 }), // Verde limão (Grampo de Fechamento)
    outros:     new THREE.MeshBasicMaterial({ color: 0xff0000 }), // Vermelho
};

// --- Estado da busca (suporta IDs duplicados) ---
let searchMatches = [];
let searchIndex = -1;
let lastSearchQuery = '';

// --- Estado de visibilidade dos rótulos ---
let enabledPrefixes = new Set(); // prefixos de nome ativos (filtro da engrenagem)
let enabledCategories = new Set(['dhp', 'arr', 'crista', 'viga', 'crvg', 'grampofech', 'outros']); // categorias ativas (legenda)
let labelsVisibleByZoom = true;  // rótulos visíveis na distância atual?

// --- Zoom suave (inércia na roda do mouse e pinça no toque) ---
let desiredZoomDistance = null;  // distância-alvo câmera→alvo; null = sem zoom pendente
const ZOOM_WHEEL_FACTOR = 1.12;  // quanto cada "passo" da roda multiplica a distância
const ZOOM_SMOOTHING = 0.18;     // fração interpolada por frame (maior = mais rápido)
let pinchStartDistance = 0;      // distância entre os dois dedos no início da pinça
let pinchStartCameraDistance = 0;// distância câmera→alvo no início da pinça
let isAnimating = false;
let animStartTime = 0;
const animDuration = 1000;
const animStartPosition = new THREE.Vector3();
const animEndPosition = new THREE.Vector3();
const animStartTarget = new THREE.Vector3();
const animEndTarget = new THREE.Vector3();

const originalSurfaceCenter = new THREE.Vector3();
const originalCameraPosition = new THREE.Vector3(100, 150, 100);

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// =============================================================
//  Visibilidade dos rótulos
// =============================================================
function updateLabelVisibilityByZoom() {
    if (!camera || !controls) return;
    const within = camera.position.distanceTo(controls.target) <= labelVisibilityThreshold;
    // Só reaplica quando cruza o limiar (evita varrer todos os pontos a cada frame).
    if (within !== labelsVisibleByZoom) {
        labelsVisibleByZoom = within;
        applyVisibility();
    }
}

// Lê o estado das checkboxes do filtro e reaplica a visibilidade.
function updateLabelVisibility() {
    const filterCheckboxes = document.querySelectorAll('#label-filter-container input[type="checkbox"]:not(#chk-filter-all)');
    const filterAllCheckbox = document.getElementById('chk-filter-all');
    enabledPrefixes = new Set();
    let allChecked = true;

    filterCheckboxes.forEach(chk => {
        if (chk.checked) {
            enabledPrefixes.add(chk.value);
        } else {
            allChecked = false;
        }
    });

    if (filterAllCheckbox) filterAllCheckbox.checked = allChecked;
    applyVisibility();
}

// Aplica a visibilidade de cada ponto (esfera) e do seu rótulo:
//  - o PONTO some quando sua categoria está desmarcada no filtro;
//  - o RÓTULO some quando a categoria está desmarcada OU a câmera está longe.
function applyVisibility() {
    if (!currentPointsGroup) return;
    currentPointsGroup.children.forEach(pointMesh => {
        // Visível só se o prefixo (engrenagem) E a categoria (legenda) estiverem ativos.
        const enabled = enabledPrefixes.has(pointMesh.userData.prefix)
            && enabledCategories.has(pointMesh.userData.categoria);
        pointMesh.visible = enabled;
        const label = pointMesh.userData.label;
        if (label) label.visible = enabled && labelsVisibleByZoom;
    });
}

// Liga/desliga uma categoria (clique na legenda) e reaplica a visibilidade.
function toggleCategoria(categoria, itemEl) {
    if (enabledCategories.has(categoria)) {
        enabledCategories.delete(categoria);
        itemEl.classList.add('categoria-off');
    } else {
        enabledCategories.add(categoria);
        itemEl.classList.remove('categoria-off');
    }
    applyVisibility();
}

function toggleAllFilters(event) {
    const isChecked = event.target.checked;
    const filterCheckboxes = document.querySelectorAll('#label-filter-container input[type="checkbox"]:not(#chk-filter-all)');
    filterCheckboxes.forEach(chk => { chk.checked = isChecked; });
    updateLabelVisibility();
}

// =============================================================
//  Inicialização
// =============================================================
init();
animate();

if (glbFileURL && csvFileURL) {
    console.log(`Buscando CSV: ${csvFileURL}`);
    fetch(csvFileURL)
        .then(response => {
            if (!response.ok) throw new Error(`Erro na rede ao buscar CSV: ${response.statusText}`);
            return response.text();
        })
        .then(csvText => {
            // 1º carrega os pontos (define a origem nos campos ocultos)
            console.log("CSV baixado, carregando pontos...");
            loadPoints(csvText, false, updateLabelVisibility);

            // 2º carrega a superfície (já com a origem definida)
            console.log(`Carregando GLB: ${glbFileURL}`);
            loadSurface(glbFileURL);
        })
        .catch(error => {
            console.error("Falha ao carregar o arquivo CSV:", error);
            showError("Não foi possível carregar os dados dos pontos (CSV).", csvFileURL);
        });
}

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xabcdef);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 10, 50000);
    camera.up.set(0, 0, 1); // eixo Z (Elevação) apontando para cima na tela
    camera.position.copy(originalCameraPosition);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.zIndex = 0;
    document.body.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    labelRenderer.domElement.style.pointerEvents = 'none';
    labelRenderer.domElement.style.zIndex = 1;
    document.body.appendChild(labelRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;       // inércia suave (movimento fluido)
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.48;         // giro ~20% mais suave (menos sensível)
    controls.panSpeed = 0.7;
    controls.enableZoom = false;         // zoom da roda é tratado manualmente (suave)
    controls.screenSpacePanning = true;  // pan no plano da tela
    controls.target.set(0, 0, 0);
    // minDistance/maxDistance são ajustados em loadSurface conforme o tamanho do modelo.

    // Zoom suave próprio (a roda do OrbitControls é "em degraus", sem inércia).
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    // Pinça de dois dedos no toque (o zoom nativo do OrbitControls está desligado).
    renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    renderer.domElement.addEventListener('touchend', onTouchEnd);
    renderer.domElement.addEventListener('touchcancel', onTouchEnd);

    // Luzes
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 3.0);
    hemiLight.position.set(0, 500, 0);
    scene.add(hemiLight);
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight1.position.set(300, 500, 300);
    scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight2.position.set(-300, 500, -300);
    scene.add(dirLight2);
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    // Eixos e rótulos de orientação
    orientationGizmo = new THREE.Group();
    const axisLength = 50;
    orientationGizmo.add(new THREE.AxesHelper(axisLength));

    const xLabelDiv = document.createElement('div');
    xLabelDiv.className = 'axis-label axis-label-x';
    xLabelDiv.textContent = 'Eixo E (X)';
    const xLabel = new CSS2DObject(xLabelDiv);
    xLabel.position.set(axisLength + 5, 0, 0);
    orientationGizmo.add(xLabel);

    const yLabelDiv = document.createElement('div');
    yLabelDiv.className = 'axis-label axis-label-y';
    yLabelDiv.textContent = 'Eixo N (Y)';
    const yLabel = new CSS2DObject(yLabelDiv);
    yLabel.position.set(0, axisLength + 5, 0);
    orientationGizmo.add(yLabel);

    const zLabelDiv = document.createElement('div');
    zLabelDiv.className = 'axis-label axis-label-z';
    zLabelDiv.textContent = 'Eixo Elev (Z)';
    const zLabel = new CSS2DObject(zLabelDiv);
    zLabel.position.set(0, 0, axisLength + 5);
    orientationGizmo.add(zLabel);
    // scene.add(orientationGizmo); // gizmo opcional, mantido oculto

    // Rodapé: data dinâmica
    const footerLabel = document.getElementById('footer-label');
    if (footerLabel) {
        footerLabel.textContent = dataLevantamento
            ? `Total de Furos na data ${dataLevantamento}: `
            : `Total de Furos: `;
    }

    // Event listeners
    document.getElementById('searchButton').addEventListener('click', handleSearch);
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            handleSearch();
            e.preventDefault();
        }
    });
    document.getElementById('frameButton').addEventListener('click', frameModel);
    document.getElementById('measureButton').addEventListener('click', toggleMedicao);
    renderer.domElement.addEventListener('click', onPointClick);

    // Link cruzado 3D -> 2D (mantém glb/data para a volta)
    if (csvFileURL) {
        const p2 = new URLSearchParams({ csv: csvFileURL, nome: params.get('nome') || 'Talude' });
        if (glbFileURL) p2.set('glb', glbFileURL);
        if (dataLevantamento) p2.set('data', dataLevantamento);
        if (areasFileURL) p2.set('areas', areasFileURL);
        document.getElementById('link-2d').href = 'editor-linhas.html?' + p2.toString();
    }

    // Clique nos itens da legenda liga/desliga cada categoria.
    document.querySelectorAll('#legenda-painel .legenda-item[data-categoria]').forEach(item => {
        item.addEventListener('click', () => toggleCategoria(item.dataset.categoria, item));
    });

    document.getElementById('originE').addEventListener('change', reloadData);
    document.getElementById('originElev').addEventListener('change', reloadData);
    document.getElementById('originN').addEventListener('change', reloadData);

    window.addEventListener('resize', onWindowResize);

    document.getElementById('toggle-button').addEventListener('click', (e) => {
        document.getElementById('controls').classList.toggle('expanded');
        e.stopPropagation();
    });
    document.getElementById('controls-content').addEventListener('click', (e) => {
        e.stopPropagation();
    });
    document.getElementById('close-info-box').addEventListener('click', (e) => {
        deselectPoint();
        e.stopPropagation();
    });
}

// =============================================================
//  Seleção de pontos
// =============================================================
function deselectPoint() {
    if (highlightedPoint && highlightedPoint.userData.originalMaterial) {
        highlightedPoint.material = highlightedPoint.userData.originalMaterial;
        highlightedPoint = null;
    }
    document.getElementById('info-box').innerHTML = '<small>Clique em um ponto para ver os detalhes.</small>';
    document.getElementById('info-box-container').style.display = 'none';
}

function showPointInfo(pointMesh, occurrence) {
    const coords = pointMesh.userData.originalCoords;
    const id = pointMesh.userData.pointID;
    // occurrence = { index, total } quando a busca encontra IDs repetidos
    const ocorrenciaLinha = (occurrence && occurrence.total > 1)
        ? `<br><em>Ocorrência ${occurrence.index + 1} de ${occurrence.total}</em>`
        : '';
    document.getElementById('info-box').innerHTML = `
        <strong>ID:</strong> ${id}<br>
        <strong>Easting:</strong> ${coords.e.toFixed(3)}<br>
        <strong>Elevação:</strong> ${coords.elev.toFixed(3)}<br>
        <strong>Northing:</strong> ${coords.n.toFixed(3)}${ocorrenciaLinha}
    `;
    document.getElementById('info-box-container').style.display = 'block';
}

function onPointClick(event) {
    if (isAnimating) return;

    const controlsEl = document.getElementById('controls');
    if (controlsEl.classList.contains('expanded')) {
        const r = controlsEl.getBoundingClientRect();
        if (event.clientX >= r.left && event.clientX <= r.right &&
            event.clientY >= r.top && event.clientY <= r.bottom) {
            return;
        }
    }

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    if (!currentPointsGroup) return;
    const intersects = raycaster.intersectObjects(currentPointsGroup.children);
    // Ignora pontos ocultos pelo filtro (continuam clicáveis no raycaster).
    const hit = intersects.find(i => i.object.visible);

    // Modo medição: cliques escolhem os dois pontos da medida.
    if (medindo3d) { if (hit) registrarMed3d(hit.object); return; }

    if (hit) {
        if (highlightedPoint) {
            highlightedPoint.material = highlightedPoint.userData.originalMaterial;
        }
        highlightedPoint = hit.object;
        highlightedPoint.material = highlightMaterial;
        showPointInfo(highlightedPoint);
        // Clicar manualmente encerra o ciclo da busca atual.
        lastSearchQuery = '';
        return;
    }
    // Sem ponto: verifica clique numa tela de proteção (área drapeada).
    if (areasGroup && areasGroup.visible) {
        const hitsArea = raycaster.intersectObjects(areasGroup.children.filter(o => o.isMesh));
        if (hitsArea.length) { deselectPoint(); mostrarInfoArea3d(hitsArea[0].object); return; }
    }
    deselectPoint();
}

// =============================================================
//  Recarregar dados quando a origem muda manualmente
// =============================================================
function reloadData() {
    if (currentSurface) {
        const originE = parseFloat(document.getElementById('originE').value) || 0;
        const originElev = parseFloat(document.getElementById('originElev').value) || 0;
        const originN = parseFloat(document.getElementById('originN').value) || 0;
        currentSurface.position.set(-originE, -originN, -originElev);
        console.log(`Superfície reposicionada para origem: E:${originE}, N:${originN}, Elev:${originElev}`);

        const box = new THREE.Box3().setFromObject(currentSurface);
        const center = box.getCenter(new THREE.Vector3());
        orientationGizmo.position.copy(center);
        originalSurfaceCenter.copy(center);
    }

    if (csvFileURL) {
        console.log(`Recarregando CSV: ${csvFileURL}`);
        fetch(csvFileURL)
            .then(response => {
                if (!response.ok) throw new Error("Erro ao buscar CSV para recarregar.");
                return response.text();
            })
            .then(csvText => loadPoints(csvText, true, updateLabelVisibility))
            .catch(error => {
                console.error("Falha ao recarregar pontos:", error);
                alert("Não foi possível recarregar os dados dos pontos.");
            });
    }
}

// =============================================================
//  Carregamento da superfície (.glb)
// =============================================================
function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.classList.add('hidden');
        setTimeout(() => { loadingScreen.style.display = 'none'; }, 500);
    }
}

// Mostra um estado de erro claro na tela (em vez de alert), com a opção
// de voltar ao menu. `detalhe` é um texto técnico opcional (ex.: o caminho).
function showError(mensagem, detalhe) {
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) {
        alert(mensagem);
        return;
    }
    loadingScreen.classList.remove('hidden');
    loadingScreen.style.display = 'flex';
    loadingScreen.classList.add('error');
    loadingScreen.innerHTML = `
        <div class="error-icon">⚠️</div>
        <div id="loading-text">${mensagem}</div>
        ${detalhe ? `<div class="error-detail">${detalhe}</div>` : ''}
        <a class="error-button" href="index.html">Voltar ao menu</a>
    `;
}

function loadSurface(url) {
    if (currentSurface) {
        scene.remove(currentSurface);
        currentSurface = null;
    }

    const originE = parseFloat(document.getElementById('originE').value) || 0;
    const originElev = parseFloat(document.getElementById('originElev').value) || 0;
    const originN = parseFloat(document.getElementById('originN').value) || 0;

    gltfLoader.load(
        url,
        (gltf) => {
            currentSurface = gltf.scene;

            currentSurface.traverse((child) => {
                if (child.isMesh) {
                    const newMaterial = new THREE.MeshBasicMaterial();
                    if (child.geometry.attributes.color) {
                        newMaterial.vertexColors = true;
                    } else if (child.material && child.material.map) {
                        newMaterial.map = child.material.map;
                    } else {
                        newMaterial.color = new THREE.Color(0xcccccc);
                    }
                    newMaterial.side = THREE.DoubleSide;
                    child.material = newMaterial;
                }
            });

            currentSurface.position.set(-originE, -originN, -originElev);
            scene.add(currentSurface);
            console.log('Superfície carregada.');

            const box = new THREE.Box3().setFromObject(currentSurface);
            const center = box.getCenter(new THREE.Vector3());

            controls.target.copy(center);
            orientationGizmo.position.copy(center);

            const size = box.getSize(new THREE.Vector3()).length();
            camera.position.copy(center);
            camera.position.x -= size * 1.2; // câmera no eixo X negativo, olhando para o modelo

            // Limites de zoom proporcionais ao tamanho do modelo (evita
            // aproximar/afastar demais e travar a navegação).
            controls.minDistance = Math.max(size * 0.02, 2);
            controls.maxDistance = size * 6;

            originalSurfaceCenter.copy(center);
            originalCameraPosition.copy(camera.position);

            controls.update();
            hideLoadingScreen();
            tryLoadAreas();
        },
        (xhr) => {
            if (xhr.lengthComputable) {
                const percentComplete = Math.min(Math.round((xhr.loaded / xhr.total) * 100), 100);
                const loadingText = document.getElementById('loading-text');
                if (loadingText) loadingText.innerText = 'Carregando malha: ' + percentComplete + '%';
            }
        },
        (error) => {
            console.error('Erro ao carregar a superfície:', error);
            showError("Não foi possível carregar o modelo 3D (GLB).", url);
        }
    );
}

// =============================================================
//  Medição de distância entre pontos conhecidos
// =============================================================
let medindo3d = false;
let med3dA = null, med3dB = null;
let medLine = null, medLabel = null;
const measureMaterial = new THREE.MeshBasicMaterial({ color: 0x00c8ff }); // ciano (pontos da medição)

function limparMedicao() {
    if (medLine) { scene.remove(medLine); medLine.geometry.dispose(); medLine = null; }
    if (medLabel) { scene.remove(medLabel); medLabel = null; }
    [med3dA, med3dB].forEach(m => { if (m && m !== highlightedPoint) m.material = m.userData.originalMaterial; });
    med3dA = null; med3dB = null;
}
function toggleMedicao() {
    medindo3d = !medindo3d;
    document.getElementById('measureButton').classList.toggle('primario', medindo3d);
    limparMedicao();
    if (medindo3d) {
        document.getElementById('info-box').innerHTML = '<small>Clique no 1º ponto e depois no 2º para medir.</small>';
        document.getElementById('info-box-container').style.display = 'block';
    } else deselectPoint();
}
function registrarMed3d(mesh) {
    if (!med3dA || med3dB) { limparMedicao(); med3dA = mesh; mesh.material = measureMaterial; return; }
    if (mesh === med3dA) return;
    med3dB = mesh; mesh.material = measureMaterial;
    const a = med3dA.userData.originalCoords, b = med3dB.userData.originalCoords;
    const dE = b.e - a.e, dN = b.n - a.n, dZ = b.elev - a.elev;
    const dH = Math.hypot(dE, dN), d3 = Math.hypot(dH, dZ);
    // linha entre os pontos + rótulo com a distância no meio
    medLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([med3dA.position.clone(), med3dB.position.clone()]),
        new THREE.LineBasicMaterial({ color: 0x00c8ff }));
    scene.add(medLine);
    const div = document.createElement('div');
    div.className = 'label';
    div.textContent = d3.toFixed(2) + ' m';
    medLabel = new CSS2DObject(div);
    medLabel.position.copy(med3dA.position).add(med3dB.position).multiplyScalar(0.5);
    scene.add(medLabel);
    document.getElementById('info-box').innerHTML = `
        <strong>${med3dA.userData.pointID}</strong> → <strong>${med3dB.userData.pointID}</strong><br>
        <strong>Distância 3D:</strong> ${d3.toFixed(2)} m<br>
        <strong>Horizontal:</strong> ${dH.toFixed(2)} m<br>
        <strong>Desnível:</strong> ${dZ >= 0 ? '+' : ''}${dZ.toFixed(2)} m
    `;
    document.getElementById('info-box-container').style.display = 'block';
}

// =============================================================
//  Áreas (telas de proteção) — polígonos drapeados na superfície
// =============================================================
let areasGroup = null;      // grupo com as mantas na cena
let areasCarregadas = false;
let showAreas3d = true;

function tryLoadAreas() {
    if (!areasFileURL || areasCarregadas || !currentSurface || !currentPointsGroup) return;
    areasCarregadas = true;
    fetch(areasFileURL, { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.text(); })
        .then(txt => construirAreas(parseAreasTxt(txt)))
        .catch(err => console.warn('Áreas não carregadas:', err));
}

// Mesmo formato do 2D: [NOME; cor=#rrggbb; area=123.4] + linhas "E; N; Elev".
function parseAreasTxt(txt) {
    const out = [];
    let atual = null;
    const CORES = ['#00c8ff', '#ff8c00', '#e6194B', '#3cb44b', '#911eb4', '#f032e6'];
    txt.split(/\r?\n/).forEach(linha => {
        const l = linha.trim();
        if (!l || l.startsWith('#')) return;
        const cab = l.match(/^\[([^\]]+)\]/); // tolera comentários após o "]"
        if (cab) {
            const partes = cab[1].split(';').map(s => s.trim());
            let cor = null, areaFile = null;
            partes.slice(1).forEach(p => {
                const m = p.match(/^(cor|area)\s*=\s*(.*)$/i);
                if (!m) return;
                if (m[1].toLowerCase() === 'cor' && m[2]) cor = m[2].trim();
                if (m[1].toLowerCase() === 'area') { const v = parseFloat(m[2].replace(',', '.')); if (!Number.isNaN(v)) areaFile = v; }
            });
            atual = { nome: partes[0] || ('Área ' + (out.length + 1)), cor: cor || CORES[out.length % CORES.length], areaFile, pts: [] };
            out.push(atual);
            return;
        }
        if (!atual) return;
        const c = l.split(/[;,\t]/).map(s => parseFloat(s.trim().replace(',', '.')));
        if (c.length >= 3 && c.every(v => !Number.isNaN(v))) atual.pts.push({ e: c[0], n: c[1], elev: c[2] });
    });
    return out.filter(a => a.pts.length >= 3);
}

// Cota da superfície em (x, y) da cena, via raio vertical; null se não acertar.
const areaRaycaster = new THREE.Raycaster();
function cotaSuperficie(x, y, zTopo) {
    areaRaycaster.set(new THREE.Vector3(x, y, zTopo), new THREE.Vector3(0, 0, -1));
    const hits = areaRaycaster.intersectObject(currentSurface, true);
    return hits.length ? hits[0].point.z : null;
}
function dentroPoligonoXY(x, y, vs) {
    let dentro = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        if (((vs[i].y > y) !== (vs[j].y > y)) && (x < (vs[j].x - vs[i].x) * (y - vs[i].y) / (vs[j].y - vs[i].y) + vs[i].x)) dentro = !dentro;
    }
    return dentro;
}

function construirAreas(lista) {
    if (!lista.length) return;
    const oE = parseFloat(document.getElementById('originE').value) || 0;
    const oElev = parseFloat(document.getElementById('originElev').value) || 0;
    const oN = parseFloat(document.getElementById('originN').value) || 0;
    const OFFSET = 0.15; // afastamento da manta acima da superfície (m)

    areasGroup = new THREE.Group();
    scene.add(areasGroup);

    const boxS = new THREE.Box3().setFromObject(currentSurface);
    const zTopo = boxS.max.z + 50;

    lista.forEach(a => {
        // vértices em coords da cena (x=E, y=N)
        const vs = a.pts.map(p => ({ x: p.e - oE, y: p.n - oN, z: p.elev - oElev }));
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        vs.forEach(v => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });

        // passo da grade: ~2000 amostras no máximo
        const passo = Math.max(0.4, Math.sqrt(((maxX - minX) * (maxY - minY)) / 2000));
        // fallback quando o raio não acerta a malha: média ponderada das cotas dos vértices
        const zFallback = (x, y) => {
            let sw = 0, sz = 0;
            vs.forEach(v => { const d = Math.hypot(x - v.x, y - v.y) + 1e-6; sw += 1 / d; sz += v.z / d; });
            return sz / sw;
        };
        const zEm = (x, y) => { const z = cotaSuperficie(x, y, zTopo); return (z == null ? zFallback(x, y) : z) + OFFSET; };

        // malha por células da grade: 2 triângulos por célula com centro dentro do polígono
        const posicoes = [];
        let area3d = 0;
        const nx = Math.ceil((maxX - minX) / passo), ny = Math.ceil((maxY - minY) / passo);
        const cotas = [];
        for (let i = 0; i <= nx; i++) { cotas[i] = []; for (let j = 0; j <= ny; j++) cotas[i][j] = null; }
        const cotaNo = (i, j) => { if (cotas[i][j] == null) cotas[i][j] = zEm(minX + i * passo, minY + j * passo); return cotas[i][j]; };
        const triangulo = (p1, p2, p3) => {
            posicoes.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
            const ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
            const vx = p3[0] - p1[0], vy = p3[1] - p1[1], vz = p3[2] - p1[2];
            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
            area3d += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
        };
        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
                const x0 = minX + i * passo, y0 = minY + j * passo, x1 = x0 + passo, y1 = y0 + passo;
                // dois triângulos; mantém os que têm o centróide dentro do polígono
                const t1 = [[x0, y0], [x1, y0], [x1, y1]], t2 = [[x0, y0], [x1, y1], [x0, y1]];
                [[t1, [i, j], [i + 1, j], [i + 1, j + 1]], [t2, [i, j], [i + 1, j + 1], [i, j + 1]]].forEach(([t, a1, b1, c1]) => {
                    const cxm = (t[0][0] + t[1][0] + t[2][0]) / 3, cym = (t[0][1] + t[1][1] + t[2][1]) / 3;
                    if (!dentroPoligonoXY(cxm, cym, vs)) return;
                    triangulo(
                        [t[0][0], t[0][1], cotaNo(a1[0], a1[1])],
                        [t[1][0], t[1][1], cotaNo(b1[0], b1[1])],
                        [t[2][0], t[2][1], cotaNo(c1[0], c1[1])]);
                });
            }
        }
        if (!posicoes.length) return;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(posicoes, 3));
        geo.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(a.cor), transparent: true, opacity: 0.35,
            side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
        });
        // área em planta (projeção E×N) — mesma convenção do levantamento
        let nz = 0;
        for (let i = 0; i < a.pts.length; i++) {
            const p1 = a.pts[i], p2 = a.pts[(i + 1) % a.pts.length];
            nz += (p1.e - p2.e) * (p1.n + p2.n);
        }
        const areaPlanta = Math.abs(nz) / 2;

        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData = { isArea: true, nome: a.nome, areaFile: a.areaFile, areaPlanta, area3d, cor: a.cor };
        areasGroup.add(mesh);

        // contorno drapeado (borda nítida)
        const bordas = [];
        vs.forEach((v, i2) => {
            const w = vs[(i2 + 1) % vs.length];
            const passos = Math.max(2, Math.ceil(Math.hypot(w.x - v.x, w.y - v.y) / passo));
            for (let k = 0; k <= passos; k++) {
                const x = v.x + (w.x - v.x) * k / passos, y = v.y + (w.y - v.y) * k / passos;
                bordas.push(new THREE.Vector3(x, y, zEm(x, y) + 0.05));
            }
        });
        const linha = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(bordas),
            new THREE.LineBasicMaterial({ color: new THREE.Color(a.cor) }));
        areasGroup.add(linha);
    });

    montarLegendaAreas(lista.length);
    console.log(`Áreas carregadas: ${lista.length}`);
}

function montarLegendaAreas(qtd) {
    const painel = document.getElementById('legenda-painel');
    if (!painel || document.getElementById('legenda-areas')) return;
    const total = painel.querySelector('.legenda-total');
    const item = document.createElement('div');
    item.className = 'legenda-item';
    item.id = 'legenda-areas';
    item.title = 'Clique para mostrar/ocultar';
    item.innerHTML = `<span class="bola" style="background-color:#00c8ff;"></span><span>Telas de proteção: <strong>${qtd}</strong></span>`;
    item.addEventListener('click', () => {
        showAreas3d = !showAreas3d;
        if (areasGroup) areasGroup.visible = showAreas3d;
        item.classList.toggle('categoria-off', !showAreas3d);
    });
    painel.insertBefore(item, total);
}

function mostrarInfoArea3d(mesh) {
    const d = mesh.userData;
    const valor = d.areaFile != null ? d.areaFile : d.areaPlanta;
    const fonte = d.areaFile != null ? 'arquivo' : 'em planta';
    document.getElementById('info-box').innerHTML = `
        <strong>Tela:</strong> ${d.nome}<br>
        <strong>Área:</strong> ${valor.toFixed(1)} m² <small>(${fonte})</small><br>
        <strong>Em planta:</strong> ${d.areaPlanta.toFixed(1)} m²<br>
        <strong>Inclinada (superfície):</strong> ${d.area3d.toFixed(1)} m²
    `;
    document.getElementById('info-box-container').style.display = 'block';
}

// Extrai as coordenadas de uma linha conforme o formato detectado:
//  - Formato novo (TAB, >=7 colunas): ID, E, N, Elev, E, N, Elev
//    -> usa o 2º conjunto (colunas 5-7), único sempre preenchido (ex.: CRVG).
//  - Formato antigo (vírgula, 5 colunas): ID, E, Elev, N.
function extrairCoords(parts) {
    if (parts.length >= 7) {
        return { e: parseFloat(parts[4]), n: parseFloat(parts[5]), elev: parseFloat(parts[6]) };
    }
    return { e: parseFloat(parts[1]), elev: parseFloat(parts[2]), n: parseFloat(parts[3]) };
}

// =============================================================
//  Carregamento dos pontos (.csv)
// =============================================================
function loadPoints(csvData, isReload = false, onFilterChange) {
    if (currentPointsGroup) {
        scene.remove(currentPointsGroup);
        currentPointsGroup = null;
    }

    currentPointsGroup = new THREE.Group();
    scene.add(currentPointsGroup);

    const filterContainer = document.getElementById('label-filter-container');
    filterContainer.innerHTML = '';
    const prefixes = new Set();

    // Parser robusto: ignora linhas vazias, normaliza CR/LF e espaços.
    // Auto-detecta o delimitador (TAB ou vírgula) pela primeira linha.
    const linhas = csvData.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "");
    if (linhas.length === 0) {
        console.warn("Arquivo CSV vazio ou inválido.");
        filterContainer.innerHTML = '<small>Não foram encontrados pontos.</small>';
        return;
    }
    const delimiter = linhas[0].includes('\t') ? '\t' : ',';
    const rows = linhas.map(l => l.split(delimiter).map(c => c.trim()));

    let originE = parseFloat(document.getElementById('originE').value) || 0;
    let originElev = parseFloat(document.getElementById('originElev').value) || 0;
    let originN = parseFloat(document.getElementById('originN').value) || 0;

    // Na primeira carga, usa o primeiro ponto como origem (para aproximar de 0,0,0).
    if (originE === 0 && originElev === 0 && originN === 0 && !isReload) {
        const first = rows[0];
        if (first.length >= 4) {
            const c0 = extrairCoords(first);
            originE = c0.e;       // Easting
            originElev = c0.elev; // Elevação
            originN = c0.n;       // Northing

            document.getElementById('originE').value = originE;
            document.getElementById('originElev').value = originElev;
            document.getElementById('originN').value = originN;

            if (currentSurface) {
                currentSurface.position.set(-originE, -originN, -originElev);
                const box = new THREE.Box3().setFromObject(currentSurface);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3()).length();

                controls.target.copy(center);
                orientationGizmo.position.copy(center);

                camera.position.copy(center);
                camera.position.x += size / 1.2;
                camera.position.y += size / 5.0;
                camera.position.z += size / 2.0;

                originalSurfaceCenter.copy(center);
                originalCameraPosition.copy(camera.position);
                controls.update();
            }
        }
    }

    // Contadores por categoria
    let contadorDHP = 0;
    let contadorARR = 0;
    let contadorCRISTA = 0;
    let contadorViga = 0;
    let contadorCRVG = 0;
    let contadorGrampoFech = 0;
    let contadorOutros = 0;

    rows.forEach(parts => {
        if (parts.length < 4) return;

        const pointID = parts[0];
        const coords = extrairCoords(parts);
        const rawE = coords.e;       // Easting
        const rawElev = coords.elev; // Elevação
        const rawN = coords.n;       // Northing
        const desc = parts.length >= 7 ? "" : (parts[4] || ""); // descrição só no formato antigo

        if (Number.isNaN(rawE) || Number.isNaN(rawElev) || Number.isNaN(rawN)) return;

        const match = pointID.match(/^([a-zA-Z]+)/);
        const prefix = match ? match[1] : 'outros';
        prefixes.add(prefix);

        // Posição na cena: X=Easting, Y=Northing, Z=Elevação (vertical)
        const x = rawE - originE;
        const y = rawN - originN;
        const z = rawElev - originElev;

        // Categoria e contagem
        let categoria;
        const idMaiusculo = pointID.toUpperCase();
        if (idMaiusculo.includes('DHP')) {
            categoria = 'dhp';
            contadorDHP++;
        } else if (idMaiusculo.includes('ARR')) {
            categoria = 'arr';
            contadorARR++;
        } else if (idMaiusculo.includes('CRVG')) {
            // Grampo Crista de Viga — checar ANTES de CRISTA/CR (começa com "CR").
            categoria = 'crvg';
            contadorCRVG++;
        } else if (idMaiusculo.startsWith('GF')) {
            // Grampo de Fechamento: todos que começam com "GF" (GFA, GFB, GFC, ...).
            categoria = 'grampofech';
            contadorGrampoFech++;
        } else if (idMaiusculo.includes('CRISTA') || idMaiusculo.startsWith('CR')) {
            categoria = 'crista';
            contadorCRISTA++;
        } else if (idMaiusculo.includes('VIGA')) {
            categoria = 'viga';
            contadorViga++;
        } else {
            categoria = 'outros';
            contadorOutros++;
        }

        const pointMesh = new THREE.Mesh(POINT_GEOMETRY, CATEGORY_MATERIALS[categoria]);
        pointMesh.userData.pointID = idMaiusculo;
        pointMesh.userData.originalMaterial = CATEGORY_MATERIALS[categoria];
        pointMesh.userData.originalCoords = { e: rawE, elev: rawElev, n: rawN };
        pointMesh.userData.prefix = prefix;
        pointMesh.userData.categoria = categoria;
        pointMesh.position.set(x, y, z);
        currentPointsGroup.add(pointMesh);

        const labelDiv = document.createElement('div');
        labelDiv.className = 'label';
        labelDiv.textContent = desc ? `${pointID}: ${desc}` : pointID;

        const labelObject = new CSS2DObject(labelDiv);
        labelObject.position.set(0, 1, 0);
        labelObject.userData.prefix = prefix;
        pointMesh.add(labelObject);
        pointMesh.userData.label = labelObject; // referência p/ controlar visibilidade
    });

    const totalPlotados = currentPointsGroup.children.length;

    // Contagem real de furos plotados (rodapé)
    const countDisplayElement = document.getElementById('point-count-display');
    if (countDisplayElement) countDisplayElement.textContent = totalPlotados;

    // Legenda / quantitativos
    if (document.getElementById('qtd-dhp')) {
        document.getElementById('qtd-dhp').innerText = contadorDHP;
        document.getElementById('qtd-arr').innerText = contadorARR;
        document.getElementById('qtd-crista').innerText = contadorCRISTA;
        document.getElementById('qtd-viga').innerText = contadorViga;
        document.getElementById('qtd-crvg').innerText = contadorCRVG;
        document.getElementById('qtd-grampofech').innerText = contadorGrampoFech;
        document.getElementById('qtd-outros').innerText = contadorOutros;
        document.getElementById('qtd-total').innerText =
            contadorDHP + contadorARR + contadorCRISTA + contadorViga + contadorCRVG + contadorGrampoFech + contadorOutros;
    }

    // Filtros por prefixo
    if (totalPlotados > 0) {
        const allDiv = document.createElement('div');
        allDiv.id = 'filter-all-container';
        const allCheckbox = document.createElement('input');
        allCheckbox.type = 'checkbox';
        allCheckbox.id = 'chk-filter-all';
        allCheckbox.value = 'all';
        allCheckbox.checked = true;
        allCheckbox.addEventListener('change', toggleAllFilters);

        const allLabel = document.createElement('label');
        allLabel.htmlFor = 'chk-filter-all';
        allLabel.textContent = ` Marcar/Desmarcar Todos`;

        allDiv.appendChild(allCheckbox);
        allDiv.appendChild(allLabel);
        filterContainer.appendChild(allDiv);

        Array.from(prefixes).sort().forEach(prefix => {
            const checkboxDiv = document.createElement('div');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `chk-filter-${prefix}`;
            checkbox.value = prefix;
            checkbox.checked = true;
            checkbox.addEventListener('change', onFilterChange);

            const label = document.createElement('label');
            label.htmlFor = `chk-filter-${prefix}`;
            label.textContent = ` ${prefix}`;

            checkboxDiv.appendChild(checkbox);
            checkboxDiv.appendChild(label);
            filterContainer.appendChild(checkboxDiv);
        });
    } else {
        filterContainer.innerHTML = '<small>Não foram encontrados pontos.</small>';
    }

    // Reseta o estado da busca e aplica a visibilidade inicial (todas as
    // categorias marcadas => todos os pontos e rótulos visíveis).
    searchMatches = [];
    searchIndex = -1;
    lastSearchQuery = '';
    updateLabelVisibility();

    console.log(`Carregados ${totalPlotados} pontos.`);
    tryLoadAreas();
}

// =============================================================
//  Janela / busca / reset / animação
// =============================================================
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
}

function handleSearch() {
    const query = document.getElementById('searchInput').value.toUpperCase().trim();
    if (!query || !currentPointsGroup) return;

    if (query === lastSearchQuery && searchMatches.length > 0) {
        // Mesma busca repetida: avança para a próxima ocorrência (ciclo).
        searchIndex = (searchIndex + 1) % searchMatches.length;
    } else {
        searchMatches = currentPointsGroup.children.filter(p => p.userData.pointID === query);
        searchIndex = 0;
        lastSearchQuery = query;
    }

    if (searchMatches.length === 0) {
        lastSearchQuery = '';
        alert('Ponto não encontrado.');
        return;
    }

    const targetPoint = searchMatches[searchIndex];
    targetPoint.visible = true; // garante que apareça mesmo se a categoria estiver filtrada

    flyToPoint(targetPoint);
    deselectPoint();

    highlightedPoint = targetPoint;
    highlightedPoint.material = highlightMaterial;
    showPointInfo(highlightedPoint, { index: searchIndex, total: searchMatches.length });
}

// Inicia uma animação suave de câmera até (endPosition, endTarget).
function startFlight(endPosition, endTarget) {
    animEndPosition.copy(endPosition);
    animEndTarget.copy(endTarget);
    animStartPosition.copy(camera.position);
    animStartTarget.copy(controls.target);

    desiredZoomDistance = null; // cancela zoom suave pendente durante o voo
    isAnimating = true;
    animStartTime = performance.now();
    controls.enabled = false;
}

function flyToPoint(pointMesh) {
    const endPos = pointMesh.position.clone().add(new THREE.Vector3(0, 20, 20));
    startFlight(endPos, pointMesh.position);
}

// Enquadra o modelo inteiro na tela, mantendo o ângulo de visão atual.
function frameModel() {
    if (isAnimating || !currentSurface) return;
    const box = new THREE.Box3().setFromObject(currentSurface);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;

    // Distância para a esfera envolvente caber no campo de visão (com margem).
    const fov = camera.fov * Math.PI / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.1;

    // Mantém a direção de visão atual; se indefinida, usa o eixo X negativo.
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(-1, 0, 0);
    dir.normalize();

    startFlight(center.clone().add(dir.multiplyScalar(dist)), center);
}

function updateAnimation() {
    const now = performance.now();
    let t = (now - animStartTime) / animDuration;
    t = Math.min(t, 1.0);

    const easedT = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(animStartPosition, animEndPosition, easedT);
    controls.target.lerpVectors(animStartTarget, animEndTarget, easedT);

    if (t >= 1.0) {
        isAnimating = false;
        controls.enabled = true;
        camera.position.copy(animEndPosition);
        controls.target.copy(animEndTarget);
        controls.update();
    }
}

// Roda do mouse: define a distância-alvo (não move na hora; o animate desliza).
function onWheel(event) {
    event.preventDefault();
    if (isAnimating || !controls) return;
    const base = (desiredZoomDistance !== null)
        ? desiredZoomDistance
        : camera.position.distanceTo(controls.target);
    const alvo = base * Math.pow(ZOOM_WHEEL_FACTOR, event.deltaY / 100);
    const min = controls.minDistance || 1;
    const max = controls.maxDistance || Infinity;
    desiredZoomDistance = Math.min(Math.max(alvo, min), max);
}

// Distância (em pixels) entre dois toques.
function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

// Início da pinça: guarda a separação dos dedos e a distância atual da câmera.
function onTouchStart(event) {
    if (event.touches.length === 2) {
        pinchStartDistance = touchDistance(event.touches);
        pinchStartCameraDistance = (desiredZoomDistance !== null)
            ? desiredZoomDistance
            : camera.position.distanceTo(controls.target);
    }
}

// Movimento da pinça: ajusta a distância-alvo conforme a separação dos dedos.
function onTouchMove(event) {
    if (event.touches.length === 2 && pinchStartDistance > 0) {
        event.preventDefault();
        const atual = touchDistance(event.touches);
        if (atual <= 0) return;
        // Afastar os dedos (atual > inicial) => aproxima (distância menor).
        const alvo = pinchStartCameraDistance * (pinchStartDistance / atual);
        const min = controls.minDistance || 1;
        const max = controls.maxDistance || Infinity;
        desiredZoomDistance = Math.min(Math.max(alvo, min), max);
    }
}

function onTouchEnd(event) {
    if (event.touches.length < 2) pinchStartDistance = 0;
}

// Desliza a câmera suavemente até a distância-alvo (inércia do zoom).
function applySmoothZoom() {
    if (desiredZoomDistance === null) return;
    const offset = camera.position.clone().sub(controls.target);
    const atual = offset.length();
    const proximo = THREE.MathUtils.lerp(atual, desiredZoomDistance, ZOOM_SMOOTHING);
    // Encerra quando estiver perto o bastante do alvo.
    if (Math.abs(proximo - atual) < Math.max(atual * 0.0008, 0.0005)) {
        offset.setLength(desiredZoomDistance);
        camera.position.copy(controls.target).add(offset);
        desiredZoomDistance = null;
        return;
    }
    offset.setLength(proximo);
    camera.position.copy(controls.target).add(offset);
}

function animate() {
    requestAnimationFrame(animate);
    updateLabelVisibilityByZoom();

    if (isAnimating) {
        updateAnimation();
    } else {
        // OrbitControls escuta eventos no canvas; os painéis de UI são
        // elementos separados por cima, então não interferem na câmera.
        // Atualiza sempre para o amortecimento (inércia) ficar fluido.
        applySmoothZoom();
        controls.update();
    }

    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}
