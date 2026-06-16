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
const dataLevantamento = params.get('data'); // ex.: "13/06/2026" (opcional)

if (!glbFileURL || !csvFileURL) {
    alert("Erro: Nenhum arquivo de projeto foi especificado na URL. Por favor, selecione um projeto a partir da página inicial.");
    window.location.href = "index.html";
}

let camera, scene, renderer, labelRenderer, controls;
let currentSurface = null;
let currentPointsGroup = null;
let orientationGizmo = null;

const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.164/examples/jsm/libs/draco/gltf/');
gltfLoader.setDRACOLoader(dracoLoader);

const highlightMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
let highlightedPoint = null;

// --- Recursos compartilhados (performance) ---
// Uma única geometria e um material por categoria são reutilizados por todos
// os pontos, em vez de criar geometria + material por ponto (milhares de objetos).
const POINT_GEOMETRY = new THREE.SphereGeometry(0.5, 8, 8);
const CATEGORY_MATERIALS = {
    dhp:    new THREE.MeshBasicMaterial({ color: 0x0000ff }), // Azul
    arr:    new THREE.MeshBasicMaterial({ color: 0xffff00 }), // Amarelo
    crista: new THREE.MeshBasicMaterial({ color: 0x800080 }), // Roxo
    viga:   new THREE.MeshBasicMaterial({ color: 0x808080 }), // Cinza
    outros: new THREE.MeshBasicMaterial({ color: 0xff0000 }), // Vermelho
};

// --- Estado da busca (suporta IDs duplicados) ---
let searchMatches = [];
let searchIndex = -1;
let lastSearchQuery = '';

// --- Estado de visibilidade dos rótulos ---
let enabledPrefixes = new Set(); // categorias (prefixos) ativas no filtro
let labelsVisibleByZoom = true;  // rótulos visíveis na distância atual?

// --- Zoom suave (inércia na roda do mouse) ---
let desiredZoomDistance = null;  // distância-alvo câmera→alvo; null = sem zoom pendente
const ZOOM_WHEEL_FACTOR = 1.12;  // quanto cada "passo" da roda multiplica a distância
const ZOOM_SMOOTHING = 0.18;     // fração interpolada por frame (maior = mais rápido)
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
        const enabled = enabledPrefixes.has(pointMesh.userData.prefix);
        pointMesh.visible = enabled;
        const label = pointMesh.userData.label;
        if (label) label.visible = enabled && labelsVisibleByZoom;
    });
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
            alert("Não foi possível carregar os dados dos pontos. Verifique o console.");
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
    document.getElementById('resetViewButton').addEventListener('click', resetView);
    renderer.domElement.addEventListener('click', onPointClick);

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

    if (hit) {
        if (highlightedPoint) {
            highlightedPoint.material = highlightedPoint.userData.originalMaterial;
        }
        highlightedPoint = hit.object;
        highlightedPoint.material = highlightMaterial;
        showPointInfo(highlightedPoint);
        // Clicar manualmente encerra o ciclo da busca atual.
        lastSearchQuery = '';
    } else {
        deselectPoint();
    }
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
            alert('Erro ao carregar o arquivo da superfície.');
            hideLoadingScreen();
        }
    );
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
    const rows = csvData
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== "")
        .map(line => line.split(',').map(cell => cell.trim()));

    if (rows.length === 0) {
        console.warn("Arquivo CSV vazio ou inválido.");
        filterContainer.innerHTML = '<small>Não foram encontrados pontos.</small>';
        return;
    }

    let originE = parseFloat(document.getElementById('originE').value) || 0;
    let originElev = parseFloat(document.getElementById('originElev').value) || 0;
    let originN = parseFloat(document.getElementById('originN').value) || 0;

    // Na primeira carga, usa o primeiro ponto como origem (para aproximar de 0,0,0).
    if (originE === 0 && originElev === 0 && originN === 0 && !isReload) {
        const first = rows[0];
        if (first.length >= 4) {
            originE = parseFloat(first[1]);    // Easting
            originElev = parseFloat(first[2]); // Elevação
            originN = parseFloat(first[3]);    // Northing

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
    let contadorOutros = 0;

    rows.forEach(parts => {
        if (parts.length < 4) return;

        const pointID = parts[0];
        const rawE = parseFloat(parts[1]);    // Easting
        const rawElev = parseFloat(parts[2]); // Elevação
        const rawN = parseFloat(parts[3]);    // Northing
        const desc = parts[4] || "";          // descrição (opcional)

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
        document.getElementById('qtd-outros').innerText = contadorOutros;
        document.getElementById('qtd-total').innerText = contadorDHP + contadorARR + contadorCRISTA + contadorViga + contadorOutros;
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

    flyToPoint(targetPoint, true);
    deselectPoint();

    highlightedPoint = targetPoint;
    highlightedPoint.material = highlightMaterial;
    showPointInfo(highlightedPoint, { index: searchIndex, total: searchMatches.length });
}

function resetView() {
    if (isAnimating) return;
    deselectPoint();
    flyToPoint(null, false);
}

function flyToPoint(pointMesh, isSearch) {
    if (isSearch) {
        animEndTarget.copy(pointMesh.position);
        animEndPosition.copy(pointMesh.position).add(new THREE.Vector3(0, 20, 20));
    } else {
        animEndTarget.copy(originalSurfaceCenter);
        animEndPosition.copy(originalCameraPosition);
    }

    animStartPosition.copy(camera.position);
    animStartTarget.copy(controls.target);

    desiredZoomDistance = null; // cancela zoom suave pendente durante o voo
    isAnimating = true;
    animStartTime = performance.now();
    controls.enabled = false;
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
