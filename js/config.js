// =============================================================
//  Configuração dos projetos (taludes) — fonte única da verdade
// =============================================================
//
// Para adicionar / remover um talude, basta editar esta lista.
// Campos:
//   nome -> texto exibido no botão do menu
//   glb  -> caminho do modelo 3D da superfície (.glb)
//   csv  -> caminho do arquivo de pontos (.csv)
//   data -> data do levantamento (texto livre, ex.: "13/06/2026")
//           usada no rodapé do visualizador. Deixe "" se não houver.
//
// OBS.: as datas abaixo foram inferidas pelo nome dos arquivos.
//       Verifique/ajuste cada uma conforme o levantamento real.

// Obras (nível acima dos taludes). Cada obra tem foto de fundo e um destino.
//   disponivel:true  -> card leva ao seu conteúdo (link)
//   disponivel:false -> botões aparecem, mas avisam "Em breve"
export const OBRAS = [
    {
        id: "br158",
        nome: "Obra BR 158 — Contenção de Talude",
        foto: "Fotos/obra_br158_web.jpg",
        disponivel: true,
        link: "taludes.html",
    },
    {
        id: "perau",
        nome: "Obra do Perau",
        foto: "Fotos/obra_perau_web.jpg",
        disponivel: false,
        link: null,
    },
];

export const TALUDES = [
    {
        nome: "Talude T-5",
        glb:  "Superficie/t5/t5_1203.glb",
        csv:  "Superficie/t5/Pontos_t5.csv",
        data: "12/03/2026",
    },
    {
        nome: "Talude T-6",
        glb:  "Superficie/t6t7/t6_superficie.glb",
        csv:  "Superficie/t6t7/Pontos_t6.csv",
        data: "",
    },
    {
        nome: "Talude T-7",
        glb:  "Superficie/t6t7/t7.glb",
        csv:  "Superficie/t6t7/t7.csv",
        data: "",
    },
    {
        nome: "Talude T-8",
        glb:  "Superficie/t8/t8_0604.glb",
        csv:  "Superficie/t8/Total_t8.csv",
        data: "06/04/2026",
    },
    {
        nome: "Talude T-10",
        glb:  "Superficie/t_10/superficie_t10.glb",
        csv:  "Superficie/t_10/Pontos_t10_visu.csv",
        data: "",
    },
    {
        nome: "Talude T-16",
        glb:  "Superficie/t_16/T16_1306.glb",
        csv:  "Superficie/t_16/Todos_Pontos_t16.csv",
        data: "13/06/2026",
    },
    {
        nome: "Talude T-18",
        glb:  "Superficie/t-18/t18_03_2026.glb",
        csv:  "Superficie/t-18/Todos_pontos_t18_VZ.csv",
        data: "03/2026",
    },
];
