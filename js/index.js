// Página inicial: cartões das obras (foto de fundo + nome na frente).
import { OBRAS, TALUDES } from "./config.js";
import { initInfoModal, toast } from "./ui.js";

initInfoModal();

const grade = document.getElementById("obras");

for (const obra of OBRAS) {
    const card = document.createElement("article");
    card.className = "obra";
    card.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.75) 100%), url('${obra.foto}')`;

    const conteudo = document.createElement("div");
    conteudo.className = "obra-conteudo";

    const titulo = document.createElement("h2");
    titulo.className = "obra-nome";
    titulo.textContent = obra.nome;
    conteudo.appendChild(titulo);

    const subTexto = obra.id === "br158"
        ? `${TALUDES.length} talude${TALUDES.length === 1 ? "" : "s"} disponíve${TALUDES.length === 1 ? "l" : "is"}`
        : obra.sub;
    if (subTexto) {
        const sub = document.createElement("p");
        sub.className = "obra-sub";
        sub.textContent = subTexto;
        conteudo.appendChild(sub);
    }

    const acoes = document.createElement("div");
    acoes.className = "obra-acoes";
    for (const acao of obra.acoes) {
        if (acao.emBreve) {
            const b = document.createElement("button");
            b.className = "obra-btn em-breve";
            b.textContent = acao.label;
            b.addEventListener("click", (e) => { e.stopPropagation(); toast("Em breve"); });
            acoes.appendChild(b);
        } else {
            const a = document.createElement("a");
            a.className = "obra-btn" + (acao.principal || acao.viz ? " principal" : "");
            if (acao.viz) {
                const p = new URLSearchParams({ v: "2", glb: acao.viz.glb, csv: acao.viz.csv });
                if (acao.viz.data) p.set("data", acao.viz.data);
                a.href = `visualizador.html?${p.toString()}`;
            } else if (acao.editor) {
                const p = new URLSearchParams({ csv: acao.editor.csv, nome: acao.editor.nome });
                a.href = `editor-linhas.html?${p.toString()}`;
            } else {
                a.href = acao.href;
            }
            a.textContent = acao.label;
            acoes.appendChild(a);
        }
    }
    conteudo.appendChild(acoes);

    if (obra.cardLink) {
        card.classList.add("clicavel");
        card.addEventListener("click", (e) => { if (e.target.tagName !== "A" && e.target.tagName !== "BUTTON") window.location.href = obra.cardLink; });
    }

    card.appendChild(conteudo);
    grade.appendChild(card);
}
