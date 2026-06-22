// Monta o menu de projetos a partir da lista em config.js
import { TALUDES } from "./config.js";

const lista = document.getElementById("lista-projetos");

for (const talude of TALUDES) {
    // Link do visualizador 3D
    const paramsVis = new URLSearchParams({ v: "2", glb: talude.glb, csv: talude.csv });
    if (talude.data) paramsVis.set("data", talude.data);

    // Link do editor de linhas
    const paramsEd = new URLSearchParams({ csv: talude.csv, nome: talude.nome });

    const li = document.createElement("li");
    li.className = "projeto";

    const nome = document.createElement("div");
    nome.className = "projeto-nome";
    nome.textContent = talude.nome;

    const acoes = document.createElement("div");
    acoes.className = "projeto-acoes";

    const aVis = document.createElement("a");
    aVis.href = `visualizador.html?${paramsVis.toString()}`;
    aVis.className = "btn-visualizar";
    aVis.textContent = "Visualizar 3D";

    const aEd = document.createElement("a");
    aEd.href = `editor-linhas.html?${paramsEd.toString()}`;
    aEd.className = "btn-editor";
    aEd.textContent = "Editor de linhas";

    acoes.appendChild(aVis);
    acoes.appendChild(aEd);
    li.appendChild(nome);
    li.appendChild(acoes);
    lista.appendChild(li);
}
