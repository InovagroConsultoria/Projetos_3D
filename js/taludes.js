// Lista de taludes da obra BR 158 (cada um com Visualizar 3D / Editor de linhas).
import { TALUDES } from "./config.js";
import { initInfoModal } from "./ui.js";

initInfoModal();

const lista = document.getElementById("lista-projetos");

for (const talude of TALUDES) {
    const paramsVis = new URLSearchParams({ v: "2", glb: talude.glb, csv: talude.csv, nome: talude.nome });
    if (talude.data) paramsVis.set("data", talude.data);
    if (talude.areas) paramsVis.set("areas", talude.areas);
    // O link 2D leva também o glb/data para permitir o botão "Ver em 3D" lá dentro.
    const paramsEd = new URLSearchParams({ csv: talude.csv, nome: talude.nome, glb: talude.glb });
    if (talude.data) paramsEd.set("data", talude.data);
    if (talude.areas) paramsEd.set("areas", talude.areas);

    const li = document.createElement("li");
    li.className = "projeto";

    const info = document.createElement("div");
    info.className = "projeto-info";
    const nome = document.createElement("div");
    nome.className = "projeto-nome";
    nome.textContent = talude.nome;
    info.appendChild(nome);
    if (talude.data) {
        const data = document.createElement("div");
        data.className = "projeto-data";
        data.textContent = "Levantamento: " + talude.data;
        info.appendChild(data);
    }

    const acoes = document.createElement("div");
    acoes.className = "projeto-acoes";

    const aVis = document.createElement("a");
    aVis.href = `visualizador.html?${paramsVis.toString()}`;
    aVis.className = "btn-visualizar";
    aVis.textContent = "Visualizar 3D";

    const aEd = document.createElement("a");
    aEd.href = `editor-linhas.html?${paramsEd.toString()}`;
    aEd.className = "btn-editor";
    aEd.textContent = "Visualização 2D";

    acoes.appendChild(aVis);
    acoes.appendChild(aEd);
    li.appendChild(info);
    li.appendChild(acoes);
    lista.appendChild(li);
}
