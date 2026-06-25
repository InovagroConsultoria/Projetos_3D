// Página inicial: cartões das obras (foto de fundo + nome na frente).
import { OBRAS, TALUDES } from "./config.js";
import { initInfoModal, toast } from "./ui.js";

initInfoModal();

const grade = document.getElementById("obras");

for (const obra of OBRAS) {
    const card = document.createElement("article");
    card.className = "obra" + (obra.disponivel ? "" : " obra-indisponivel");
    card.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.75) 100%), url('${obra.foto}')`;

    if (!obra.disponivel) {
        const tag = document.createElement("span");
        tag.className = "obra-tag";
        tag.textContent = "Em breve";
        card.appendChild(tag);
    }

    const conteudo = document.createElement("div");
    conteudo.className = "obra-conteudo";

    const titulo = document.createElement("h2");
    titulo.className = "obra-nome";
    titulo.textContent = obra.nome;
    conteudo.appendChild(titulo);

    if (obra.disponivel) {
        const sub = document.createElement("p");
        sub.className = "obra-sub";
        const n = TALUDES.length;
        sub.textContent = `${n} talude${n === 1 ? "" : "s"} disponíve${n === 1 ? "l" : "is"}`;
        conteudo.appendChild(sub);

        const acoes = document.createElement("div");
        acoes.className = "obra-acoes";
        const btn = document.createElement("a");
        btn.className = "obra-btn principal";
        btn.href = obra.link;
        btn.textContent = "Ver taludes →";
        acoes.appendChild(btn);
        conteudo.appendChild(acoes);
        // O card inteiro também leva ao destino.
        card.classList.add("clicavel");
        card.addEventListener("click", (e) => { if (e.target.tagName !== "A") window.location.href = obra.link; });
    } else {
        const acoes = document.createElement("div");
        acoes.className = "obra-acoes";
        ["Visualizar 3D", "Editor de linhas"].forEach(rotulo => {
            const b = document.createElement("button");
            b.className = "obra-btn";
            b.textContent = rotulo;
            b.addEventListener("click", () => toast("Em breve"));
            acoes.appendChild(b);
        });
        conteudo.appendChild(acoes);
    }

    card.appendChild(conteudo);
    grade.appendChild(card);
}
