"use client";

// ——— A ponte entre a sessão na tela e o armazenamento local (Fase 4.9.2) ———
//
// Um hook, com escopo fixo em (usuário, paciente, sessão). Ele guarda o que o
// servidor disse, guarda o que o cuidador pediu, e devolve os dois somados —
// já projetados — para a tela consumir.
//
// O que ele NÃO faz, nesta fase: enviar. Nada sai daqui para o servidor. A
// fila enche, sobrevive a refresh, e espera a 4.9.3.
//
// CONECTIVIDADE. `navigator.onLine` responde "estou conectado" em portal
// cativo, em Wi-Fi sem rota e em VPN caída. Ele serve para saber que a conexão
// VOLTOU (o evento `online`), não para afirmar que ela existe. Quem afirma é a
// requisição real: uma falha de rede em `useRtqPersistence` marca offline aqui,
// e uma resposta do servidor marca online. O estado visual segue os fatos, não
// a opinião do navegador.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OfflineSessionStore,
  type AvisoDeDescarte,
  type RascunhoLocal,
} from "@/lib/offline/store";
import { limparOutrosEscopos } from "@/lib/offline/limpeza";
import {
  ordenada,
  resumo,
  type NovaOperacao,
} from "@/lib/offline/queue";
import {
  motivoParaRecusarOffline,
  projetarCaminhos,
  projetarSessao,
  type AutorLocal,
  type ProjecaoMarcas,
  type SessionDetailBase,
} from "@/lib/offline/projection";
import type {
  OfflineOperation,
  OfflineStatusSummary,
} from "@/lib/offline/types";
import type { PathDetail } from "@/lib/option-conversation-types";

/**
 * O que a ponte recebe. Sessão e paciente NÃO entram: eles vêm do escopo do
 * hook, e deixá-los fora é o que impede uma chamada de gravar a intenção no
 * paciente errado.
 */
export type EntradaOffline = Omit<NovaOperacao, "sessionId" | "patientId">;

export interface RegistroOffline {
  operacao: OfflineOperation;
  sessao: SessionDetailBase | null;
  caminhos: PathDetail[];
  marcas: ProjecaoMarcas;
}

export interface OfflineBridge {
  /** O navegador tem Web Crypto e IndexedDB, e há sessão e paciente. */
  disponivel: boolean;
  /** Carga inicial concluída — antes disso, nada é lido nem gravado. */
  pronto: boolean;
  online: boolean;
  status: OfflineStatusSummary;
  fila: OfflineOperation[];
  marcas: ProjecaoMarcas;
  avisoDeDescarte: AvisoDeDescarte | null;
  reconhecerDescarte: () => void;
  /**
   * Quantas áreas de OUTROS pacientes ficaram no aparelho por terem intenção
   * pendente. Elas não são legíveis daqui — a chave é escopada —, mas o
   * cuidador precisa saber que existem.
   */
  pendenciasDeOutroPaciente: number;

  /** Uma requisição real falhou por rede. */
  registrarQueda: () => void;
  /** Uma requisição real respondeu. */
  registrarSucesso: () => void;

  guardarSessao: (detail: SessionDetailBase) => void;
  guardarCaminhos: (details: PathDetail[]) => void;

  /** O último estado conhecido, já com a fila aplicada. */
  sessaoLocal: () => SessionDetailBase | null;
  caminhosLocais: () => PathDetail[] | null;

  /** Guarda uma intenção e devolve o estado projetado depois dela. */
  registrar: (entrada: EntradaOffline) => Promise<RegistroOffline>;

  // ——— Rascunhos: o terceiro estatuto ———
  //
  // Texto digitado e ainda NÃO submetido. Ele não entra na fila, não vira
  // operação, não gera evento de auditoria e não chega perto do portão de
  // autoria. Sobrevive a refresh e a fechar o navegador porque perder o que o
  // cuidador acabou de escrever é uma forma pequena e diária de desrespeito.

  /**
   * Já carregou os rascunhos deste escopo. Vira `true` UMA vez, e é o sinal
   * para a tela hidratar o campo dela.
   */
  rascunhosProntos: boolean;
  /** O que estava guardado para esta chave. Leitura direta, sem estado. */
  lerRascunho: (chave: string) => unknown;
  definirRascunho: (chave: string, valor: unknown, sensivel?: boolean) => void;
  /** Some com o rascunho: submissão concluída ou cancelamento explícito. */
  descartarRascunho: (chave: string) => void;
}

const MARCAS_VAZIAS: ProjecaoMarcas = {
  locais: new Set(),
  confirmacaoPendente: new Set(),
  naoAplicadas: [],
};

export function useOfflineSession(args: {
  userId: string | null;
  patientId: number | null;
  sessionId: string | null;
  assistantName: string | null;
  /**
   * A sessão como o servidor a entregou à tela, AGORA.
   *
   * Sem ela existiria uma corrida real, e os testes de interface a
   * encontraram: uma sessão recém-criada chega por `createSession`, sem passar
   * por `sessionDetail`, e o snapshot só nasceria depois que o IndexedDB
   * terminasse de abrir. Uma queda de conexão nesse intervalo deixava o
   * cuidador sem nada para continuar — justamente o que a fase existe para
   * evitar. A semente elimina a janela: o estado inicial está disponível na
   * primeira renderização, antes de qualquer leitura de banco.
   */
  sementeSessao?: SessionDetailBase | null;
  /**
   * Chamado UMA vez, quando os rascunhos deste escopo terminam de ser lidos.
   *
   * É por aqui que a tela hidrata os campos dela. O caminho é este, e não um
   * efeito olhando `rascunhosProntos`, porque atualizar estado dentro do corpo
   * de um efeito dispara renderizações em cascata — a própria regra de lint do
   * projeto recusa. Dentro de um retorno assíncrono, não há cascata.
   */
  aoCarregarRascunhos?: (valores: Record<string, unknown>) => void;
}): OfflineBridge {
  const {
    userId,
    patientId,
    sessionId,
    assistantName,
    sementeSessao,
    aoCarregarRascunhos,
  } = args;

  // Em ref para não entrar nas dependências do efeito de carga: a tela pode
  // recriar a função a cada render, e recarregar o banco por causa disso seria
  // ler o mesmo dado dezenas de vezes.
  const aoCarregarRef = useRef(aoCarregarRascunhos);
  aoCarregarRef.current = aoCarregarRascunhos;

  const disponivel =
    OfflineSessionStore.disponivel() &&
    !!userId &&
    patientId != null &&
    !!sessionId;

  const store = useMemo(
    () =>
      disponivel
        ? new OfflineSessionStore(userId!, patientId!, sessionId!)
        : null,
    [disponivel, userId, patientId, sessionId]
  );

  // `pronto` é DERIVADO de qual escopo já foi carregado, e não um booleano
  // solto: trocar de sessão precisa voltar a "carregando" sem que ninguém
  // lembre de zerar uma flag — e um `pronto` que sobrevivesse à troca deixaria
  // a tela ler a fila da conversa anterior.
  const chaveDoEscopo = store ? `${store.escopo}|${store.sessionId}` : null;
  const [carregadoPara, setCarregadoPara] = useState<string | null>(null);
  const pronto = chaveDoEscopo != null && carregadoPara === chaveDoEscopo;

  // A fila vive em DOIS lugares, e os dois são necessários.
  //
  //   estado → o que a faixa do cuidador desenha;
  //   ref    → o que a lógica lê.
  //
  // Sem o ref existe um erro sutil e caro: a releitura que acontece logo depois
  // de uma escrita offline (`nodeAction` e em seguida `reload`) roda dentro do
  // MESMO fechamento, capturado antes de `setFila`. Ela projetaria a fila
  // ANTIGA — sem a operação que acabou de ser guardada — e sobrescreveria a
  // tela com o estado anterior. A seleção que o cuidador registrou some, sem
  // erro e sem aviso. Foi exatamente o que os testes de interface pegaram.
  const [fila, setFilaEstado] = useState<OfflineOperation[]>([]);
  const filaRef = useRef<OfflineOperation[]>([]);
  const setFila = useCallback((nova: OfflineOperation[]) => {
    filaRef.current = nova;
    setFilaEstado(nova);
  }, []);
  const [avisoDeDescarte, setAviso] = useState<AvisoDeDescarte | null>(null);

  // Atrelado ao escopo, e não um objeto solto: trocar de paciente ou de
  // sessão precisa esvaziar os rascunhos sem que ninguém lembre de zerar
  // nada — e um rascunho que atravessasse a troca apareceria na conversa
  // errada, que é o pior lugar possível para um texto aparecer.
  //
  // Os VALORES ficam num ref, e não em estado. A primeira versão os guardava
  // em estado e a tela lia dali a cada tecla — o que fazia a árvore inteira
  // renderizar por caractere digitado e transformava uma digitação comum numa
  // rajada de renderizações. Pior: mover estado de digitação para um store
  // assíncrono abriu espaço para atualizações concorrentes atropelarem o campo
  // (foi assim que um campo do formulário de contexto sumiu).
  //
  // Agora o dono do texto continua sendo a tela, com `useState` local. Este
  // módulo só GUARDA e DEVOLVE — e `rascunhosProntos`, que vira `true` uma vez,
  // é o único sinal que atravessa o render.
  const rascunhosRef = useRef<Record<string, unknown>>({});
  const [escopoDosRascunhos, setEscopoDosRascunhos] = useState<string | null>(
    null
  );
  const rascunhosProntos =
    chaveDoEscopo != null && escopoDosRascunhos === chaveDoEscopo;
  const temporizadores = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Palpite inicial do navegador, lido uma vez na montagem. Ele erra em portal
  // cativo e em Wi-Fi sem rota — quem corrige é a primeira requisição real.
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false
  );

  // Snapshots ficam em ref: eles alimentam leituras sob demanda, e colocá-los
  // em estado provocaria uma renderização a cada gravação — no meio de uma
  // apresentação ao paciente.
  const snapSessao = useRef<SessionDetailBase | null>(sementeSessao ?? null);
  const snapCaminhos = useRef<PathDetail[] | null>(null);
  const [marcas, setMarcas] = useState<ProjecaoMarcas>(MARCAS_VAZIAS);

  const autor = useMemo<AutorLocal | null>(
    () =>
      userId && patientId != null
        ? { assistantId: userId, assistantName, patientId }
        : null,
    [userId, patientId, assistantName]
  );

  // ——— Carga inicial ———

  useEffect(() => {
    if (!store || !chaveDoEscopo) return;
    let cancelado = false;
    // Fila e caminhos do escopo anterior não atravessam. A sessão volta à
    // semente — que é o estado que a tela tem em mãos AGORA, e portanto o mais
    // recente que existe.
    snapSessao.current = sementeSessao ?? null;
    snapCaminhos.current = null;
    void store
      .carregar()
      .then((carga) => {
        if (cancelado) return;
        setFila(carga.fila);
        setAviso(carga.avisoDeDescarte);
        rascunhosRef.current = Object.fromEntries(
          (carga.rascunhos as RascunhoLocal[]).map((r) => [r.chave, r.valor])
        );
        setEscopoDosRascunhos(chaveDoEscopo);
        aoCarregarRef.current?.(rascunhosRef.current);
        for (const s of carga.snapshots) {
          // A semente ganha do guardado: ela veio do servidor nesta abertura,
          // e o guardado pode ser de dias atrás.
          if (s.kind === "sessionDetail" && !sementeSessao) {
            snapSessao.current = s.value as SessionDetailBase;
          }
          if (s.kind === "pathDetails") {
            snapCaminhos.current = s.value as PathDetail[];
          }
        }
      })
      .catch(() => {
        // Banco indisponível: o modo segue online-only, sem quebrar a tela.
      })
      .finally(() => {
        if (!cancelado) setCarregadoPara(chaveDoEscopo);
      });
    return () => {
      cancelado = true;
    };
    // `sementeSessao` fica FORA das dependências de propósito: ela muda a cada
    // resposta do servidor, e recarregar a fila do banco a cada uma seria
    // relê-la dezenas de vezes por conversa. Ela é lida como valor inicial, e
    // quem mantém o snapshot em dia depois disso é `guardarSessao`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, chaveDoEscopo]);

  // ——— A área de outros pacientes sai do aparelho ———

  const [pendenciasDeOutroPaciente, setPendenciasDeOutroPaciente] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelado = false;
    void limparOutrosEscopos(userId, patientId).then((r) => {
      if (!cancelado) setPendenciasDeOutroPaciente(r.preservados);
    });
    return () => {
      cancelado = true;
    };
  }, [userId, patientId]);

  // ——— Conectividade ———

  useEffect(() => {
    if (typeof window === "undefined") return;
    const voltou = () => setOnline(true);
    const caiu = () => setOnline(false);
    window.addEventListener("online", voltou);
    window.addEventListener("offline", caiu);
    return () => {
      window.removeEventListener("online", voltou);
      window.removeEventListener("offline", caiu);
    };
  }, []);

  const registrarQueda = useCallback(() => setOnline(false), []);
  const registrarSucesso = useCallback(() => setOnline(true), []);

  // ——— Snapshot ———

  /**
   * Snapshot: memória na hora, disco na hora também.
   *
   * Houve uma versão com gravação adiada, para agrupar rajadas. Ela custou
   * caro: entre a ação e a gravação existia uma janela em que um refresh sem
   * rede recuperava o estado ANTERIOR — a pergunta recém-criada sumia. O
   * problema de desempenho que ela tentava resolver era outro (a ponte sem
   * memoização, que fazia o efeito rodar a cada render), e esse já está
   * resolvido na origem.
   */
  const guardarSessao = useCallback(
    (detail: SessionDetailBase) => {
      snapSessao.current = detail;
      void store?.salvarSnapshot("sessionDetail", detail).catch(() => {});
    },
    [store]
  );

  const guardarCaminhos = useCallback(
    (details: PathDetail[]) => {
      snapCaminhos.current = details;
      void store?.salvarSnapshot("pathDetails", details).catch(() => {});
    },
    [store]
  );

  // ——— Projeção ———

  const projetar = useCallback(
    (filaAtual: readonly OfflineOperation[] = filaRef.current) => {
      const base = snapSessao.current;
      const caminhosBase = snapCaminhos.current ?? [];
      if (!autor || !sessionId) {
        return { sessao: base, caminhos: caminhosBase, marcas: MARCAS_VAZIAS };
      }
      const sessaoProjetada = base
        ? projetarSessao(base, filaAtual, autor)
        : null;
      const caminhosProjetados = projetarCaminhos(
        caminhosBase,
        filaAtual,
        autor,
        sessionId
      );
      return {
        sessao: sessaoProjetada?.detail ?? null,
        caminhos: caminhosProjetados.details,
        marcas: {
          locais: new Set([
            ...(sessaoProjetada?.marcas.locais ?? []),
            ...caminhosProjetados.marcas.locais,
          ]),
          confirmacaoPendente: new Set([
            ...(sessaoProjetada?.marcas.confirmacaoPendente ?? []),
            ...caminhosProjetados.marcas.confirmacaoPendente,
          ]),
          naoAplicadas: [
            ...(sessaoProjetada?.marcas.naoAplicadas ?? []),
            ...caminhosProjetados.marcas.naoAplicadas,
          ],
        },
      };
    },
    [autor, sessionId]
  );

  // Sem `fila` nas dependências: elas leem `filaRef.current`, que está sempre em
  // dia. Depender do estado devolveria justamente o fechamento velho.
  const sessaoLocal = useCallback(() => projetar().sessao, [projetar]);

  const caminhosLocais = useCallback(() => {
    if (!snapCaminhos.current) return null;
    return projetar().caminhos;
  }, [projetar]);

  // ——— Registro de intenção ———

  const registrar = useCallback(
    async (entrada: EntradaOffline): Promise<RegistroOffline> => {
      if (!store) throw new Error("armazenamento local indisponível");

      const sessaoAtual = snapSessao.current;
      if (!sessaoAtual) {
        // §2: sem os dados mínimos da sessão em mãos, não há continuidade
        // possível — e inventar uma sessão local seria começar uma identidade
        // nova sem servidor, que é justamente o que a fase proíbe.
        throw new Error(
          "esta conversa ainda não foi carregada neste aparelho; conecte-se uma vez antes de continuar sem conexão"
        );
      }
      const recusa = motivoParaRecusarOffline(
        entrada.operationType,
        entrada.payload,
        sessaoAtual.session
      );
      if (recusa) throw new Error(recusa);

      const { fila: nova, operacao } = await store.enfileirar(filaRef.current, entrada);
      setFila(nova);
      const projecao = projetar(nova);
      setMarcas(projecao.marcas);
      return {
        operacao,
        sessao: projecao.sessao,
        caminhos: projecao.caminhos,
        marcas: projecao.marcas,
      };
    },
    [store, projetar, setFila]
  );

  const lerRascunho = useCallback((chave: string) => rascunhosRef.current[chave], []);

  const definirRascunho = useCallback(
    (chave: string, valor: unknown, sensivel = false) => {
      rascunhosRef.current = { ...rascunhosRef.current, [chave]: valor };
      if (!store) return;
      // A tela já respondeu — quem espera é o disco. Gravar a cada tecla
      // escreveria dezenas de vezes por frase, e cifrar não é de graça.
      const anterior = temporizadores.current.get(chave);
      if (anterior) clearTimeout(anterior);
      temporizadores.current.set(
        chave,
        setTimeout(() => {
          temporizadores.current.delete(chave);
          void store.salvarRascunho(chave, valor, sensivel).catch(() => {});
        }, 300)
      );
    },
    [store]
  );

  const descartarRascunho = useCallback(
    (chave: string) => {
      const pendente = temporizadores.current.get(chave);
      if (pendente) {
        clearTimeout(pendente);
        temporizadores.current.delete(chave);
      }
      const { [chave]: _fora, ...resto } = rascunhosRef.current;
      void _fora;
      rascunhosRef.current = resto;
      void store?.descartarRascunho(chave).catch(() => {});
    },
    [store]
  );

  useEffect(() => {
    const mapa = temporizadores.current;
    return () => {
      for (const t of mapa.values()) clearTimeout(t);
      mapa.clear();
    };
  }, [chaveDoEscopo]);

  const reconhecerDescarte = useCallback(() => {
    setAviso(null);
    void store?.reconhecerDescarte().catch(() => {});
  }, [store]);

  const status = useMemo(() => resumo(fila, online), [fila, online]);
  const filaOrdenada = useMemo(() => ordenada(fila), [fila]);

  // ——— A ponte é MEMOIZADA, e isso não é micro-otimização ———
  //
  // Devolver um objeto novo a cada renderização parecia inofensivo e não era.
  // Ele entra nas dependências de `useRtqPersistence` e dos efeitos de
  // snapshot lá em cima; com identidade nova a cada quadro, o efeito de
  // snapshot passava a rodar SEMPRE — ou seja, uma cifragem AES e uma escrita
  // no IndexedDB por renderização —, e `persist` era reconstruído junto,
  // derrubando a memoização de toda a árvore abaixo.
  //
  // O efeito não aparecia isolado: um teste sozinho passava. Aparecia sob
  // carga, como timeouts itinerantes na suíte de interface, em testes que não
  // tinham nada a ver com armazenamento local.
  return useMemo(
    () => ({
      disponivel,
      pronto,
      online,
      status,
      fila: filaOrdenada,
      marcas,
      avisoDeDescarte,
      reconhecerDescarte,
      pendenciasDeOutroPaciente,
      registrarQueda,
      registrarSucesso,
      guardarSessao,
      guardarCaminhos,
      sessaoLocal,
      caminhosLocais,
      registrar,
      rascunhosProntos,
      lerRascunho,
      definirRascunho,
      descartarRascunho,
    }),
    [
      disponivel,
      pronto,
      online,
      status,
      filaOrdenada,
      marcas,
      avisoDeDescarte,
      reconhecerDescarte,
      pendenciasDeOutroPaciente,
      registrarQueda,
      registrarSucesso,
      guardarSessao,
      guardarCaminhos,
      sessaoLocal,
      caminhosLocais,
      registrar,
      rascunhosProntos,
      lerRascunho,
      definirRascunho,
      descartarRascunho,
    ]
  );
}
