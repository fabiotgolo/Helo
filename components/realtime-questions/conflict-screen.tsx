"use client";

// ——— A tela onde o cuidador decide (Fase 4.9.3-C.2, §10) ———
//
// A regra que governa este arquivo inteiro, escrita na primeira linha da §10:
// **nenhum conflito é resolvido silenciosamente.** Toda saída daqui é um
// clique de um humano.
//
// O que esta tela NÃO faz, e é tão importante quanto o que ela faz:
//
//   • não abre sozinha. Um conflito espera; ele não interrompe uma conversa em
//     curso. Quem abre é o cuidador, pelo chip (§11);
//   • não emite som, não vibra, não pisca;
//   • não aparece sobre o palco do paciente — quem responde por essa fronteira
//     é `pacienteEstaOlhando`, no ponto de montagem, a MESMA expressão que
//     governa a barra de contexto e o chip;
//   • não tem botão padrão que aplique por cima. A ordem dos botões vem de
//     `conflito.opcoes`, e o classificador já garante que o primeiro nunca é o
//     mais destrutivo.
//
// ——— Por que a cadeia aparece antes da confirmação ———
//
// Descartar uma criação condena tudo que dependia dela (decisions.ts). Mostrar
// só "descartar este registro" quando na verdade três vão embora seria mentir
// no momento em que mais custa. §10, caso 13: o cuidador decide sobre o
// conjunto, não sobre uma peça solta.

import { useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import {
  cadeiaDependente,
  opcaoDisponivel,
  textoDe,
} from "@/lib/offline/decisions";
import type { ConflictCase, ConflictOptionId } from "@/lib/offline/conflicts";
import type { OfflineOperation } from "@/lib/offline/types";

/** Nome de cada tipo de operação, na língua do cuidador — nunca o identificador. */
const NOME_DA_ACAO: Record<string, string> = {
  createTurn: "a pergunta que você escreveu",
  turnAction: "uma ação sobre a pergunta",
  createPath: "a conversa por opções que você abriu",
  pathAction: "uma ação sobre a conversa por opções",
  createNode: "o nível de opções que você montou",
  reviewNode: "a conferência do nível",
  nodeAction: "uma ação sobre o nível",
  createStatement: "a frase que você escreveu",
  statementAction: "uma ação sobre a frase",
  createCaregiverInterpretation: "a interpretação que você escreveu",
  saveSessionContext: "o contexto da conversa",
  openPatientControl: "um pedido do paciente",
  patientControlAction: "uma ação sobre o pedido do paciente",
  sessionAction: "uma ação sobre a conversa",
};

function nomeDaAcao(op: OfflineOperation): string {
  return NOME_DA_ACAO[op.operationType] ?? "um registro";
}

function horario(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Quem formulou o texto — o dever extra do caso 6 (§10).
 *
 * Uma interpretação do cuidador NÃO é fala do paciente. Numa tela que mostra
 * dois textos lado a lado, essa fronteira é exatamente o que corre risco de se
 * perder — e perdê-la é o risco central da Fase 4.6. Por isso a autoria é
 * rótulo fixo da caixa, não uma observação no rodapé que o olho pula.
 */
function Autoria({ children }: { children: string }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
      {children}
    </span>
  );
}

function Caixa({
  autoria,
  texto,
  destaque = false,
  testid,
}: {
  autoria: string;
  texto: string;
  destaque?: boolean;
  testid?: string;
}) {
  return (
    <div
      data-testid={testid}
      className={`flex flex-col gap-1.5 rounded-2xl border p-3 ${
        destaque
          ? "border-line bg-surface"
          : "border-line/60 bg-surface/50"
      }`}
    >
      <Autoria>{autoria}</Autoria>
      <p className="whitespace-pre-wrap break-words text-sm text-ink">{texto}</p>
    </div>
  );
}

export function ConflictScreen({
  operacao,
  conflito,
  fila,
  onDecidir,
  onFechar,
}: {
  operacao: OfflineOperation;
  conflito: ConflictCase;
  fila: readonly OfflineOperation[];
  onDecidir: (opcao: ConflictOptionId) => void;
  onFechar: () => void;
}) {
  const [verCadeia, setVerCadeia] = useState(false);
  const cadeia = cadeiaDependente(fila, operacao.id);
  const meuTexto = textoDe(operacao);
  const quando = horario(conflito.fatos.serverAt);

  // Só as saídas que têm para onde apontar nesta operação — um botão que não
  // pode fazer nada é pior que um botão a menos.
  const opcoes = conflito.opcoes.filter((o) =>
    opcaoDisponivel(conflito, operacao, o.id)
  );

  const decidir = (opcao: ConflictOptionId) => {
    if (opcao === "VER_PENDENTES" || opcao === "DECIDIR_A_CADEIA") {
      setVerCadeia(true);
      return;
    }
    onDecidir(opcao);
  };

  return (
    <ModalShell
      onClose={onFechar}
      labelledBy="conflito-titulo"
      describedBy="conflito-descricao"
      // `alertdialog` e não `dialog`: quem chegou aqui clicou para resolver
      // algo que está travando a fila, e o leitor de tela deve anunciar o
      // título inteiro, não só o foco.
      role="alertdialog"
    >
      <div data-testid="tela-de-conflito" data-caso={conflito.caso} className="flex flex-col gap-5">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
            Precisa da sua decisão
          </p>
          <h2 id="conflito-titulo" className="text-lg font-semibold text-ink">
            {conflito.titulo}
          </h2>
          <p id="conflito-descricao" className="text-sm text-ink-mute">
            {quando
              ? `O Helo registrou essa mudança às ${quando}. `
              : ""}
            Nada do que está aqui foi enviado — {nomeDaAcao(operacao)} continua
            guardada neste aparelho até você decidir.
          </p>
        </header>

        {/* Os dois lados. Só aparece quando há um texto do cuidador para
            mostrar: inventar uma caixa vazia para "manter a simetria" faria a
            tela parecer que perdeu algo. */}
        {meuTexto && (
          <section className="flex flex-col gap-2">
            <Caixa
              testid="conflito-meu-texto"
              autoria="Você escreveu, sem conexão"
              texto={meuTexto}
              destaque
            />
            {conflito.fatos.serverValue && (
              <Caixa
                testid="conflito-texto-do-servidor"
                autoria="O Helo tem registrado"
                texto={conflito.fatos.serverValue}
              />
            )}
          </section>
        )}

        {/* A cadeia: o que mais vai junto. Aparece por pedido do cuidador, e
            também sozinha quando há mais de uma coisa em jogo — porque aí ela
            deixa de ser detalhe e passa a ser parte da decisão. */}
        {cadeia.length > 0 && (
          <section
            data-testid="conflito-cadeia"
            className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3"
          >
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
              {cadeia.length === 1
                ? "Mais um registro depende deste:"
                : `Mais ${cadeia.length} registros dependem deste:`}
            </p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-amber-900 dark:text-amber-100">
              {cadeia.map((op) => (
                <li key={op.id}>{nomeDaAcao(op)}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-900/80 dark:text-amber-100/80">
              Se você descartar, {cadeia.length === 1 ? "ele vai" : "eles vão"}{" "}
              junto — {cadeia.length === 1 ? "ele não tem" : "eles não têm"} como
              existir sem este.
            </p>
          </section>
        )}

        {verCadeia && cadeia.length === 0 && (
          <p
            data-testid="conflito-sem-cadeia"
            className="rounded-2xl border border-line bg-surface/50 p-3 text-sm text-ink-mute"
          >
            Nenhum outro registro depende deste. A decisão vale só para ele.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {/* Todas as saídas com o MESMO peso visual, de propósito.

              A primeira versão desta tela dava realce de ação primária à
              primeira opção — e o retrato mostrou "Ver o que ficou pendente",
              que é meramente informativa, virando o botão mais forte da tela.
              Corrigir só aquele caso trataria o sintoma: o problema é que
              destacar QUALQUER opção aqui é o produto opinando sobre uma
              decisão clínica que não é dele. §10 proíbe o padrão "aplicar
              mesmo assim"; a leitura honesta disso é não ter padrão nenhum.
              Quem sabe qual é a saída certa é quem está à beira do leito. */}
          {opcoes.map((opcao) => (
            <button
              key={opcao.id}
              type="button"
              onClick={() => decidir(opcao.id)}
              data-testid={`conflito-opcao-${opcao.id}`}
              className="min-h-11 rounded-xl border border-line px-4 py-2.5 text-left text-base font-semibold text-ink transition-colors hover:bg-surface"
            >
              {opcao.rotulo}
            </button>
          ))}

          <button
            type="button"
            onClick={onFechar}
            data-testid="conflito-decidir-depois"
            className="min-h-11 rounded-xl px-4 py-2.5 text-sm font-medium text-ink-mute hover:text-ink"
          >
            Decidir depois
          </button>
        </div>

        {/* Dito com todas as letras, porque é a garantia que sustenta o
            "decidir depois": sair daqui não descarta nada. */}
        <p className="text-xs text-ink-mute">
          Enquanto você não decidir, este registro continua guardado neste
          aparelho e nada é enviado ao Helo.
        </p>
      </div>
    </ModalShell>
  );
}
