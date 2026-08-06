// ——— O que a decisão do cuidador FAZ com a fila (Fase 4.9.3-C.2, §10) ———
//
// Módulo PURO: recebe a fila e a saída escolhida, devolve a fila nova e o que
// mais precisa acontecer. Não toca IndexedDB, não faz requisição, não conhece
// React. Quem persiste é o store; quem chama é a tela.
//
// ——— Por que descartar não é apagar uma linha ———
//
// A regra da fila (queue.ts) é que nada some sem alguém mandar. `pruneSynced`
// recusa receber um filtro justamente para que não exista o caminho por onde,
// um dia, alguém apagaria uma operação pendente sem perceber.
//
// A decisão do cuidador É esse alguém — mas ela vem com uma consequência que a
// matriz obriga a encarar (§10, caso 13): **descartar uma criação condena tudo
// que dependia dela.** Se o nível não foi criado, a opção escolhida naquele
// nível não tem onde existir. Apagar só a peça de cima deixaria na fila uma
// operação órfã, que ficaria tentando para sempre contra um registro que nunca
// vai nascer — e falharia com uma mensagem que não explicaria nada.
//
// Por isso toda decisão que descarta devolve a CADEIA inteira, e a tela mostra
// a cadeia ANTES de o cuidador confirmar. Ele decide sobre o conjunto, não
// sobre uma peça solta.

import {
  markStatus,
  ordenada,
  type NovaOperacao,
  appendOperation,
} from "@/lib/offline/queue";
import type { ConflictCase, ConflictOptionId } from "@/lib/offline/conflicts";
import type { OfflineOperation } from "@/lib/offline/types";

// ---------- A cadeia ----------

/**
 * Tudo que depende desta operação, direta ou indiretamente, e que ainda não
 * foi confirmado pelo servidor.
 *
 * Duas fontes de dependência, as mesmas que `calcularDependencias` usa na
 * inserção: `dependsOn` (declarado) e a citação do `createdEntityId` no
 * payload (que é como uma operação diz "eu falo daquele registro"). Olhar só
 * `dependsOn` deixaria passar quem cita o id sem ter declarado nada.
 *
 * `SYNCED` nunca entra: o servidor já aceitou, e nada local desfaz isso.
 */
export function cadeiaDependente(
  fila: readonly OfflineOperation[],
  operationId: string
): OfflineOperation[] {
  const porId = new Map(fila.map((op) => [op.id, op]));
  const raiz = porId.get(operationId);
  if (!raiz) return [];

  const condenados = new Set<string>([raiz.id]);
  const idsCriados = new Set<string>();
  if (raiz.createdEntityId) idsCriados.add(raiz.createdEntityId);
  const sequencias = new Set<number>([raiz.sequence]);

  // Varredura em ordem causal: uma operação só pode depender de outra ANTES
  // dela, então uma passada crescente basta para fechar o fecho transitivo.
  for (const op of ordenada(fila)) {
    if (op.status === "SYNCED") continue;
    if (condenados.has(op.id)) continue;

    const dependeDeclarado = op.dependsOn.some((s) => sequencias.has(s));
    const citaCriado =
      idsCriados.size > 0 && citaAlgum(op.payload, idsCriados);

    if (dependeDeclarado || citaCriado) {
      condenados.add(op.id);
      sequencias.add(op.sequence);
      if (op.createdEntityId) idsCriados.add(op.createdEntityId);
    }
  }

  condenados.delete(raiz.id);
  return ordenada(fila).filter((op) => condenados.has(op.id));
}

function citaAlgum(payload: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof payload === "string") return ids.has(payload);
  if (payload === null || typeof payload !== "object") return false;
  if (Array.isArray(payload)) return payload.some((v) => citaAlgum(v, ids));
  return Object.values(payload as Record<string, unknown>).some((v) =>
    citaAlgum(v, ids)
  );
}

// ---------- Reescrever o alvo ----------

/**
 * A mesma operação, apontando para outro registro. Usada por "repetir sobre a
 * nova versão" (casos 3 e 6): a intenção do cuidador não mudou, o registro
 * sobre o qual ela recai é que é outro.
 *
 * O espelho de `alvoDe` em queue.ts — e a razão de os dois viverem perto um do
 * outro na cabeça de quem lê: se um campo novo aparecer lá, precisa aparecer
 * aqui, senão "repetir" mandaria a ação para o registro velho de novo.
 */
export function comAlvo(op: OfflineOperation, novoAlvo: string): unknown {
  const p = { ...((op.payload ?? {}) as Record<string, unknown>) };
  switch (op.operationType) {
    case "turnAction":
      p.turnId = novoAlvo;
      return p;
    case "nodeAction":
    case "reviewNode":
      p.nodeId = novoAlvo;
      return p;
    case "statementAction":
      p.statementId = novoAlvo;
      return p;
    case "pathAction":
      p.pathId = novoAlvo;
      return p;
    case "patientControlAction":
      p.requestId = novoAlvo;
      return p;
    default:
      // Criações e ações de sessão não têm alvo para trocar. Devolver o
      // payload intacto é melhor que inventar um campo: quem chamou já
      // verificou que a opção fazia sentido (`opcaoDisponivel`).
      return p;
  }
}

/** O texto que o cuidador escreveu, para virar rascunho. Nem toda operação tem. */
export function textoDe(op: OfflineOperation): string | null {
  const p = (op.payload ?? {}) as Record<string, unknown>;
  for (const campo of ["text", "promptText", "reviewedText", "statementText"]) {
    const v = p[campo];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// ---------- O resultado de uma decisão ----------

export interface DecisaoAplicada {
  fila: OfflineOperation[];
  /** Ids que saem do banco local. Já descontada a cadeia. */
  removidas: string[];
  /** Texto a preservar como RASCUNHO — nunca como confirmação (§10, caso 1). */
  rascunho: { chave: string; valor: string } | null;
  /**
   * Frase curta, no passado, do que aconteceu. Vai para o cuidador: ele
   * acabou de tomar uma decisão clínica e precisa ver que ela valeu.
   */
  descricao: string;
}

/** Chave do rascunho gerado por "reaproveitar". Uma por operação. */
export function chaveDeReaproveitamento(op: OfflineOperation): string {
  return `conflito-reaproveitado:${op.id}`;
}

/**
 * As saídas que fazem sentido para ESTA operação, dentre as que o caso
 * oferece.
 *
 * Existe porque a matriz descreve o caso, não a operação: o caso 3 oferece
 * "repetir sobre a nova versão", mas só dá para repetir se o servidor disse
 * QUAL é a nova (`replacedById`). Sem isso o botão existiria e não teria para
 * onde apontar — pior que não existir.
 */
export function opcaoDisponivel(
  conflito: ConflictCase,
  op: OfflineOperation,
  opcao: ConflictOptionId
): boolean {
  switch (opcao) {
    case "REPETIR_SOBRE_A_NOVA":
      return Boolean(conflito.fatos.replacedById);
    case "REAPROVEITAR_COMO_RASCUNHO":
      return textoDe(op) !== null;
    default:
      return true;
  }
}

/**
 * Aplica a decisão. Nunca lança por escolha do cuidador: uma opção que não se
 * aplica devolve a fila intacta com a descrição dizendo isso — a alternativa
 * seria uma exceção subindo de um clique, no meio de uma conversa.
 */
export function aplicarDecisao(
  fila: readonly OfflineOperation[],
  operationId: string,
  opcao: ConflictOptionId,
  conflito: ConflictCase,
  agora: number = Date.now()
): DecisaoAplicada {
  const alvo = fila.find((op) => op.id === operationId);
  if (!alvo) {
    return { fila: [...fila], removidas: [], rascunho: null, descricao: "" };
  }

  const cadeia = cadeiaDependente(fila, operationId);
  const descartarTudo = (): { fila: OfflineOperation[]; removidas: string[] } => {
    const fora = new Set([operationId, ...cadeia.map((o) => o.id)]);
    return {
      fila: fila.filter((op) => !fora.has(op.id)),
      removidas: [...fora],
    };
  };

  switch (opcao) {
    case "DESCARTAR":
    case "MANTER_DO_SERVIDOR": {
      const { fila: nova, removidas } = descartarTudo();
      return {
        fila: nova,
        removidas,
        rascunho: null,
        descricao:
          opcao === "MANTER_DO_SERVIDOR"
            ? "Mantivemos o que estava no Helo."
            : frase(removidas.length, "Descartamos"),
      };
    }

    case "REAPROVEITAR_COMO_RASCUNHO": {
      // §10, casos 1 e 5: o texto volta como RASCUNHO. Nunca como registro,
      // nunca como fala confirmada — o paciente não respondeu a isto, e um
      // texto que reaparecesse já confirmado seria exatamente o que a Fase
      // 4.6 existe para impedir.
      const texto = textoDe(alvo);
      const { fila: nova, removidas } = descartarTudo();
      return {
        fila: nova,
        removidas,
        rascunho: texto ? { chave: chaveDeReaproveitamento(alvo), valor: texto } : null,
        descricao: texto
          ? "Guardamos o texto como rascunho. Ele não foi registrado nem apresentado."
          : frase(removidas.length, "Descartamos"),
      };
    }

    case "REPETIR_SOBRE_A_NOVA": {
      const novoAlvo = conflito.fatos.replacedById;
      if (!novoAlvo) {
        return {
          fila: [...fila],
          removidas: [],
          rascunho: null,
          descricao: "O Helo não informou qual é a versão nova.",
        };
      }
      // Chave NOVA, de propósito: esta é outra intenção, sobre outro
      // registro. Reaproveitar a chave antiga faria o servidor reconhecê-la
      // como reenvio da primeira — e devolver o resultado da que foi recusada.
      const { fila: semAntiga, removidas } = descartarTudo();
      const entrada: NovaOperacao = {
        operationType: alvo.operationType,
        sessionId: alvo.sessionId,
        patientId: alvo.patientId,
        payload: comAlvo(alvo, novoAlvo),
        createdEntityId: null,
        baseVersion: null,
      };
      const { fila: nova } = appendOperation(semAntiga, entrada, agora);
      return {
        fila: nova,
        removidas,
        rascunho: null,
        descricao: "Refizemos a ação sobre a versão nova.",
      };
    }

    case "RETOMAR_E_CONTINUAR": {
      // §10, caso 2: RESUME entra ANTES do resto. A operação que topou com a
      // pausa volta para PENDING e depende dele — assim a ordem causal
      // continua sendo a fila quem garante, e não a sorte do temporizador.
      const entrada: NovaOperacao = {
        operationType: "sessionAction",
        sessionId: alvo.sessionId,
        patientId: alvo.patientId,
        payload: { sessionId: alvo.sessionId, action: "RESUME" },
      };
      const { fila: comResume, operacao: resume } = appendOperation(
        fila,
        entrada,
        agora
      );
      const reenfileirada = markStatus(
        comResume,
        operationId,
        "PENDING",
        { error: null, nextRetryAt: null },
        agora
      ).map((op) =>
        op.id === operationId
          ? {
              ...op,
              conflict: null,
              dependsOn: [...new Set([...op.dependsOn, resume.sequence])],
            }
          : op
      );
      return {
        fila: reenfileirada,
        removidas: [],
        rascunho: null,
        descricao: "Vamos retomar a conversa e enviar o que ficou.",
      };
    }

    // Informativas: não mexem na fila. Existem como saída nomeada porque a
    // tela precisa de um caminho para "quero ver antes de decidir" que não
    // seja fechar o diálogo e perder o contexto.
    case "VER_PENDENTES":
    case "DECIDIR_A_CADEIA":
      return { fila: [...fila], removidas: [], rascunho: null, descricao: "" };

    // ——— Casos 4 e 7 ———
    //
    // As duas reenviam a intenção do cuidador, e as duas precisam das MESMAS
    // duas coisas, pelas mesmas razões:
    //
    //   baseVersion LIMPO — a operação foi recusada justamente por citar uma
    //   versão que não é mais a vigente. Reenviar com ela seria pedir a mesma
    //   recusa de novo, num laço em que o cuidador decide e nada acontece.
    //   Limpar é o registro de que ele VIU o outro lado e decidiu assim
    //   mesmo: a checagem de concorrência já cumpriu o papel dela.
    //
    //   chave NOVA — o servidor guardou a primeira tentativa no ledger. Com a
    //   mesma chave ele reconheceria um reenvio e devolveria o resultado
    //   daquela, que foi recusa. Esta é outra intenção: a de sobrepor-se ao
    //   que o servidor tem, tomada com a informação à vista.
    case "APLICAR_A_MINHA": {
      // §10, caso 4: "vira CHANGE_RESPONSE, contabilizada como correção, com
      // trilha". A troca de SELECT para CHANGE não é detalhe de implementação
      // — é o que faz o servidor registrar isto como CORREÇÃO de uma resposta
      // que já existia, e não como se fosse a primeira leitura do gesto. Uma
      // correção declarada é auditável; uma sobrescrita silenciosa não.
      const { fila: sem, removidas } = descartarTudo();
      const p = { ...((alvo.payload ?? {}) as Record<string, unknown>) };
      const acao = { ...((p.action ?? {}) as Record<string, unknown>) };
      if (acao.kind === "SELECT_RESPONSE") acao.kind = "CHANGE_RESPONSE";
      p.action = acao;
      const { fila: nova } = appendOperation(
        sem,
        {
          operationType: alvo.operationType,
          sessionId: alvo.sessionId,
          patientId: alvo.patientId,
          payload: p,
          createdEntityId: null,
          baseVersion: null,
        },
        agora
      );
      return {
        fila: nova,
        removidas,
        rascunho: null,
        descricao: "Sua resposta vai ser registrada como correção.",
      };
    }

    case "GRAVAR_COMO_NOVA_VERSAO": {
      // §10, caso 7. E aqui não há nada de perigoso: gravar contexto SEMPRE
      // cria versão nova e nunca apaga a anterior (§4.8). O que muda é qual
      // passa a ser a vigente — por isso esta saída é o comportamento normal
      // do produto, e não uma concessão.
      const { fila: sem, removidas } = descartarTudo();
      const { fila: nova } = appendOperation(
        sem,
        {
          operationType: alvo.operationType,
          sessionId: alvo.sessionId,
          patientId: alvo.patientId,
          payload: alvo.payload,
          createdEntityId: alvo.createdEntityId,
          baseVersion: null,
        },
        agora
      );
      return {
        fila: nova,
        removidas,
        rascunho: null,
        descricao: "Seu contexto vai ser gravado como uma versão nova.",
      };
    }
  }
}

function frase(n: number, verbo: string): string {
  return n === 1
    ? `${verbo} este registro.`
    : `${verbo} este registro e mais ${n - 1} que dependiam dele.`;
}
