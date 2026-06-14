// Monta o menu de projetos a partir da lista em config.js
import { TALUDES } from "./config.js";

const lista = document.getElementById("lista-projetos");

for (const talude of TALUDES) {
    const params = new URLSearchParams({
        v: "2",
        glb: talude.glb,
        csv: talude.csv,
    });
    if (talude.data) params.set("data", talude.data);

    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `visualizador.html?${params.toString()}`;
    a.textContent = talude.nome;

    li.appendChild(a);
    lista.appendChild(li);
}
