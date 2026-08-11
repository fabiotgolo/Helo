// ——— Limitador de taxa distribuído (Fase 5.4C — A-10) ———
//
// A auditoria da 5.4A procurou por `rateLimit`, `throttle`, `quota`, `429`,
// `Retry-After`, Upstash, Redis, contador em memória e Cloud Armor, e não
// encontrou **um único limitador** do lado do Helo. O pior caso é a geração de
// música: autenticada, mas sem teto, com até 300 segundos de composição paga
// por pedido. Um cuidador legítimo, sozinho, esgota a cota da conta.
//
// ——— Por que não um contador em memória ———
//
// `apphosting.yaml` traz `minInstances: 0`. A instância morre quando o uso
// para, e com ela morreria o contador — o limite se apagaria sozinho a cada
// pausa. E as Cloud Functions de música e de síntese escalam à parte, com o
// padrão da plataforma. Um contador local não seria frouxo: seria decorativo.
//
// O Firestore já é a base do produto, já é transacional, e já é aquilo de que
// a AUTORIZAÇÃO depende — o que tem uma consequência que vale dizer por
// extenso, porque ela decide o comportamento em falha (ver §"fail" abaixo).
//
// ——— O algoritmo: janela fixa ———
//
// O balde é `(endpoint, usuário[, paciente], índice da janela)`, e o índice é
// `floor(agora / janela)`. Escolhido sobre janela deslizante por três motivos
// concretos, nenhum deles estético:
//
//   1. **É exato para o Retry-After.** O fim da janela é conhecido, então o
//      valor que devolvemos é o valor verdadeiro — não uma estimativa.
//   2. **É uma leitura e uma escrita.** Uma janela deslizante honesta guarda a
//      lista de instantes; aqui um documento minúsculo basta.
//   3. **A limpeza é estrutural.** Cada janela tem documento próprio, então o
//      lixo é identificável sem varredura (ver `LIMPA_JANELA_ANTERIOR`).
//
// O preço da janela fixa é conhecido e aceito: na virada, um usuário pode
// emitir até `2 × limite` num intervalo curto. Para um limitador de CUSTO —
// que é o que este é — o que importa é o teto por hora, e ele continua valendo.
//
// ——— O que NUNCA entra na chave ———
//
// Nome, e-mail, texto clínico, prompt, título, telefone. Só identificadores
// técnicos opacos: o id do documento do usuário (gerado pelo Firestore, 20
// caracteres) e, quando o limite é por paciente, o id numérico interno dele.
// A coleção é inacessível ao cliente — `firestore.rules` nega tudo ao
// navegador, e é o servidor que lê e escreve pelo Admin SDK.

import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { CABECALHOS_SEM_ARMAZENAMENTO } from "@/lib/cache-policy";
import { firestore } from "@/lib/firestore";

/** Onde os baldes vivem. Não é lida pelo cliente: ver firestore.rules. */
export const COLECAO_DE_LIMITES = "rateLimits";

/**
 * Margem depois do fim da janela antes de o documento poder ser recolhido.
 * Existe para que um relógio adiantado num runtime não apague o balde que
 * outro ainda está contando.
 */
export const MARGEM_DE_EXPIRACAO_MS = 60_000;

/** Prazo da limpeza oportunista. Um documento; se demorar mais, desiste. */
export const PRAZO_DE_LIMPEZA_MS = 2_000;

/**
 * A unidade de contagem.
 *
 * `usuario` — o abuso é uma propriedade da conta, não do paciente. É o caso da
 *   composição de música: quem paga é a conta, e somar por paciente só daria a
 *   quem cuida de mais gente um teto maior sem nenhuma razão.
 *
 * `usuarioEPaciente` — o recurso é do paciente e a repetição legítima é por
 *   paciente. É o caso da pré-síntese de frases: montar a lista de frases de
 *   uma pessoa é uma rajada legítima que não deve consumir a cota da outra.
 *
 * IP não aparece em lugar nenhum, e é deliberado: cuidadores de uma mesma
 * instituição saem pelo mesmo NAT, e limitar por IP puniria a equipe inteira
 * por causa de uma pessoa. Estes endpoints são todos autenticados — existe
 * identidade melhor que o endereço.
 */
export type UnidadeDeLimite = "usuario" | "usuarioEPaciente";

export interface Limite {
  /** Quantos pedidos a janela aceita. */
  readonly limite: number;
  readonly janelaMs: number;
  readonly unidade: UnidadeDeLimite;
  /**
   * O que fazer quando o próprio limitador não consegue decidir (Firestore
   * fora do ar). Ver a nota sobre falha abaixo da tabela.
   */
  readonly falhaFechada: boolean;
}

const MINUTO = 60_000;
const HORA = 60 * MINUTO;

/**
 * ——— Os limites, com a conta que os justifica ———
 *
 * Nenhum número aqui é preferência. Cada um sai de um uso real medido no
 * código, e o critério é o mesmo: **precisa caber folgado no pior uso legítimo
 * que o produto consegue produzir, e ainda assim ter teto.**
 *
 * `musica` — 6/hora por usuário. Cada chamada compra até 300 s de composição
 *   paga e grava um MP3. O uso real é o cuidador pedindo uma música durante
 *   uma sessão; seis por hora já é generoso para uma pessoa que também precisa
 *   ESCUTAR o que pediu. Por usuário, e não por paciente: quem paga é a conta.
 *
 * `fraseAudio` — 30/hora por usuário e paciente. Montar a lista de frases
 *   favoritas de alguém é uma rajada legítima; e cada edição de texto
 *   re-sintetiza. Trinta cobre montar a lista inteira de uma vez e ainda
 *   corrigir várias. Por paciente porque a rajada é por paciente.
 *
 * `tts` — 60/minuto por usuário. O pior caso legítimo está medido:
 *   `app/(palco)/emergencia/page.tsx` pré-aquece o áudio de todas as frases de
 *   emergência ao entrar na tela, e `lib/voice/audio-cache.ts` documenta esse
 *   conjunto como "15 no pior caso realista". Sessenta deixa esse pré-aquecimento
 *   inteiro passar quatro vezes dentro do mesmo minuto. Ninguém aperta botões
 *   uma vez por segundo durante um minuto inteiro; um laço, sim.
 *
 * `grant` — 90/minuto por usuário. É o passo anterior a cada `tts` que não vem
 *   do cache, então precisa ser >= o de `tts`, com folga. Não gasta crédito: o
 *   que ele protege é a tentativa repetida.
 *
 * `conversa` — 12 por 5 minutos por usuário. Uma sessão de conversa por vez é
 *   o uso real; doze cobre reconexões seguidas numa rede ruim, que é o único
 *   caminho legítimo que repete este pedido.
 *
 * `ditado` — 20/minuto por usuário. Cada chamada carrega um arquivo de áudio.
 *   Hoje o recurso está desligado em produção (`HELO_VOICE_DICTATION_ENABLED`
 *   ausente); o limite entra agora para que a ativação futura não dependa de
 *   ninguém lembrar disso.
 *
 * `vozesAdmin` — 60/minuto por usuário. É o único ponto do produto que
 *   consulta a conta da ElevenLabs; o alvo é a enumeração, não o custo.
 */
export const LIMITES = {
  musica: { limite: 6, janelaMs: HORA, unidade: "usuario", falhaFechada: true },
  fraseAudio: { limite: 30, janelaMs: HORA, unidade: "usuarioEPaciente", falhaFechada: true },
  tts: { limite: 60, janelaMs: MINUTO, unidade: "usuario", falhaFechada: false },
  grant: { limite: 90, janelaMs: MINUTO, unidade: "usuario", falhaFechada: false },
  conversa: { limite: 12, janelaMs: 5 * MINUTO, unidade: "usuario", falhaFechada: false },
  ditado: { limite: 20, janelaMs: MINUTO, unidade: "usuario", falhaFechada: true },
  vozesAdmin: { limite: 60, janelaMs: MINUTO, unidade: "usuario", falhaFechada: false },
} as const satisfies Record<string, Limite>;

export type EndpointLimitado = keyof typeof LIMITES;

/**
 * ——— O comportamento em falha, e por que ele não é o buraco que parece ———
 *
 * A regra do escopo é clara: "Firestore indisponível → libera chamadas
 * infinitas" não pode acontecer. Aqui ela não acontece, e a razão é estrutural
 * em vez de configurada: **o limitador guarda o estado no MESMO Firestore de
 * que a autorização depende.** `requirePatientAccess` lê a sessão, o usuário e
 * o vínculo do banco. Com o banco fora do ar, nenhuma requisição chega ao
 * ponto de consultar o limitador — ela já foi recusada antes, na autenticação.
 *
 * Ou seja: `falhaFechada: false` não abre uma porta; ele decide o que fazer
 * numa falha PARCIAL, em que a leitura da sessão funcionou e a transação do
 * balde não. Nesse estado:
 *
 *   - custo alto e não clínico (`musica`, `fraseAudio`, `ditado`) → recusa.
 *     Não gastar é sempre reversível; a frase continua sendo falada pelo
 *     caminho do grant, que é o que a pré-síntese otimiza.
 *   - caminho clínico (`tts`, `grant`, `conversa`) → passa, com registro.
 *     Recusar aqui silenciaria a voz do paciente — inclusive na Emergência —
 *     por causa de um contador. A troca é consciente: um limitador financeiro
 *     não desliga uma funcionalidade clínica.
 */
export type Veredicto =
  | { readonly permitido: true; readonly usadas: number }
  | {
      readonly permitido: false;
      readonly causa: "limite" | "indisponivel";
      readonly esperaSegundos: number;
    };

/** Início e fim da janela que contém `agoraMs`. */
export function janelaDe(agoraMs: number, janelaMs: number) {
  const indice = Math.floor(agoraMs / janelaMs);
  return { indice, comecaEm: indice * janelaMs, terminaEm: (indice + 1) * janelaMs };
}

/**
 * O identificador do balde.
 *
 * Só caracteres seguros de id de documento, e só valores técnicos. O separador
 * é `__` para que nenhum campo consiga se disfarçar de outro por conter o
 * separador — os componentes são todos `[a-z0-9-]` por construção, mas a
 * suíte confere isso em vez de acreditar.
 */
export function idDoBalde(input: {
  endpoint: EndpointLimitado;
  userId: string;
  patientId?: number | null;
  agoraMs: number;
}): string {
  const config = LIMITES[input.endpoint];
  const { indice } = janelaDe(input.agoraMs, config.janelaMs);
  const paciente =
    config.unidade === "usuarioEPaciente" && input.patientId != null
      ? String(input.patientId)
      : "-";
  return `${input.endpoint}__${input.userId}__${paciente}__${indice}`;
}

function idDaJanelaAnterior(idAtual: string): string | null {
  const partes = idAtual.split("__");
  const indice = Number(partes[partes.length - 1]);
  if (!Number.isFinite(indice) || indice <= 0) return null;
  partes[partes.length - 1] = String(indice - 1);
  return partes.join("__");
}

export interface DepsDeLimite {
  /** Injetável para a suíte controlar o tempo sem esperar uma hora. */
  readonly agoraMs?: number;
  readonly db?: Firestore;
}

/**
 * Conta um pedido e diz se ele passa.
 *
 * Roda **depois** da autenticação e da autorização — precisa da identidade
 * para montar a chave, e recusar por limite antes de recusar por acesso
 * contaria a um desconhecido que aquele paciente existe.
 *
 * A contagem é feita numa transação porque o padrão "ler, decidir, escrever"
 * fora de uma delas deixa passar exatamente aquilo que o limite existe para
 * impedir: duas requisições simultâneas leem `limite - 1` e ambas gravam
 * `limite`. `FieldValue.increment` seria atômico mas não devolve o valor novo,
 * e sem o valor novo não há decisão.
 */
export async function consomeLimite(
  endpoint: EndpointLimitado,
  identidade: { userId: string; patientId?: number | null },
  deps: DepsDeLimite = {}
): Promise<Veredicto> {
  const config = LIMITES[endpoint];
  const agoraMs = deps.agoraMs ?? Date.now();
  const db = deps.db ?? firestore;
  const { terminaEm } = janelaDe(agoraMs, config.janelaMs);
  const esperaSegundos = Math.max(1, Math.ceil((terminaEm - agoraMs) / 1000));
  const id = idDoBalde({ endpoint, ...identidade, agoraMs });
  const ref = db.collection(COLECAO_DE_LIMITES).doc(id);

  // ——— Por que a transação devolve um objeto, e não a contagem ———
  //
  // Devolvia. E a primeira execução da suíte mostrou o preço: quando o balde
  // já estava no teto, a transação devolvia `contagem` (12); quando ela
  // acabava de gastar a última vaga, devolvia `contagem + 1` (12 também). Os
  // dois casos saíam com o MESMO número, e `usadas > limite` — falso para 12
  // nos dois — deixava passar tanto a décima segunda quanto a décima terceira,
  // a décima quarta e todas as seguintes. O contador parava certo no banco e o
  // portão ficava aberto: o limite existia e não valia.
  //
  // O veredito precisa ser dito pela transação, que é quem sabe, em vez de
  // deduzido de um número que descreve dois estados diferentes.
  let resultado: { excedeu: boolean; contagem: number };
  try {
    resultado = await db.runTransaction(async (tx) => {
      const atual = await tx.get(ref);
      const contagem = atual.exists ? Number(atual.data()?.contagem ?? 0) : 0;
      if (contagem >= config.limite) return { excedeu: true, contagem };
      tx.set(
        ref,
        {
          contagem: contagem + 1,
          // Timestamp e não string: é o tipo que uma política de TTL do
          // Firestore sabe ler. Ver docs/fase-5.4c-hardening-final.md.
          expiraEm: Timestamp.fromMillis(terminaEm + MARGEM_DE_EXPIRACAO_MS),
        },
        { merge: true }
      );
      return { excedeu: false, contagem: contagem + 1 };
    });
  } catch (falha) {
    // Nada do erro sai daqui: nem mensagem do driver, nem caminho do
    // documento, nem a identidade. Só a decisão e o endpoint.
    console.error("[LIMITE] contador indisponível", {
      endpoint,
      decisao: config.falhaFechada ? "recusa" : "libera",
      nome: falha instanceof Error ? falha.name : "desconhecido",
    });
    return config.falhaFechada
      ? { permitido: false, causa: "indisponivel", esperaSegundos }
      : { permitido: true, usadas: 0 };
  }

  if (resultado.excedeu) return { permitido: false, causa: "limite", esperaSegundos };
  const usadas = resultado.contagem;

  // ——— A limpeza, sem fila e sem varredura ———
  //
  // O primeiro pedido de uma janela apaga o balde da janela ANTERIOR daquela
  // mesma chave. É uma exclusão por id, sem consulta e sem índice, e garante
  // que a coleção nunca guarde mais de duas janelas por chave — sem depender
  // de ninguém ter configurado a política de TTL no projeto.
  //
  // Best-effort e com prazo, pela lição da 5.4B: uma limpeza sem relógio
  // dentro do caminho de uma requisição do cuidador é uma requisição que pode
  // ficar pendurada. Se falhar, o balde velho fica — e a política de TTL, se
  // existir, o recolhe.
  //
  // O `try` em volta não é decoração, e ele custou uma reprovação para
  // aparecer: `.delete()` estava protegido por `.catch()`, que só alcança a
  // promessa REJEITADA. Um lançamento SÍNCRONO — o método ausente, uma forma
  // inesperada do SDK — passava por fora e derrubava uma requisição que já
  // tinha passado pelo limite e só precisava terminar. É a mesma lição que a
  // 5.4B pagou com a faxina de Storage: uma limpeza best-effort que pode
  // reprovar a operação não é best-effort.
  if (usadas === 1) {
    const anterior = idDaJanelaAnterior(id);
    if (anterior) {
      try {
        await Promise.race([
          db.collection(COLECAO_DE_LIMITES).doc(anterior).delete().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, PRAZO_DE_LIMPEZA_MS)),
        ]);
      } catch {
        // O balde velho fica. A política de TTL o recolhe, e a janela seguinte
        // tenta de novo: a limpeza se conserta sozinha.
      }
    }
  }

  return { permitido: true, usadas };
}

/**
 * A resposta de recusa.
 *
 * Sanitizada de propósito: nada de contador, de limite configurado, de
 * patientId, de e-mail, de cota do provedor, de caminho do Firestore. Quem
 * bateu no limite precisa saber duas coisas — que foi rápido demais e quando
 * tentar de novo. O resto é infraestrutura, e infraestrutura não se conta.
 *
 * `Retry-After` é exato, não estimado: a janela é fixa, então o segundo em que
 * ela vira é conhecido. Um valor inventado seria pior que nenhum.
 */
export function respostaDeLimite(veredicto: Veredicto & { permitido: false }): Response {
  const headers = {
    ...CABECALHOS_SEM_ARMAZENAMENTO,
    "Retry-After": String(veredicto.esperaSegundos),
  };
  if (veredicto.causa === "indisponivel") {
    return Response.json(
      { error: "serviço temporariamente indisponível", reason: "rate_limit_unavailable" },
      { status: 503, headers }
    );
  }
  return Response.json(
    { error: "muitos pedidos em pouco tempo", reason: "rate_limited" },
    { status: 429, headers }
  );
}
