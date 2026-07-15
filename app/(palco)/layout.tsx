// ——— Layout do palco: a camada persistente da experiência Helo ———
// Este layout NUNCA desmonta ao navegar entre home, conversa, rotina e
// emergência (App Router preserva layouts entre rotas filhas). O OrbStage,
// a voz e o estado vivem aqui em cima; as páginas são apenas a camada
// dinâmica de conteúdo, renderizada como overlay sobre o palco.
//
// Home: orbes protagonistas no centro-alto. Experiência aberta: o trio
// encolhe para a faixa superior e o conteúdo sobe por baixo dele.

import PalcoLayoutClient from "@/components/palco-layout-client";

export default function PalcoLayout({ children }: { children: React.ReactNode }) {
  return <PalcoLayoutClient>{children}</PalcoLayoutClient>;
}
