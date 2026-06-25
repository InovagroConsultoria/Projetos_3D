// Elementos de UI compartilhados entre as páginas (cabeçalho):
//  - modal "Informações" (sobre a empresa + crédito)
//  - toast (mensagens curtas, ex.: "Em breve")

export function initInfoModal() {
    const modal = document.getElementById('info-modal');
    const abrir = document.getElementById('btn-info');
    const fechar = document.getElementById('info-fechar');
    if (!modal || !abrir) return;
    abrir.addEventListener('click', () => modal.classList.remove('hidden'));
    fechar.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.add('hidden'); });
}

let toastTimer = null;
export function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
