# Fase 4.9 — Auditoria técnica e arquitetura offline

**Execução 1 de 3 — auditoria, desenho e documentação. Sem implementação.**

Estado verificado no início desta auditoria:

| Item | Valor |
| --- | --- |
| Diretório (`pwd -P`) | `/Users/fabiogarcia/Projects/Helo/helo-app` |
| Branch | `rescue-imported-2026-08-02` |
| `git status` | limpo (nenhuma modificação pendente) |
| Último commit | `286a3f9` — *test(4.8): confirmar por testes que `pacienteEstaOlhando` governa a tela e o contexto* |
| TypeScript | `tsc --noEmit` — **0 erros** |
| Build | `next build` — **aprovado** (todas as rotas geradas) |
| Testes HTTP + domínio | **13 suítes · 793 asserções · 0 falhas** |

Detalhe das suítes: access 72 · activities 84 · feedback 57 · realtime-questions 87 ·
authorship 53 · session-context 55 · interpretation 69 · patient-controls 85 ·
oc:core 66 · oc:branches 45 · oc:versioning 33 · oc:history 30 · oc:screen 57.
Rodadas contra o dev server em `localhost:3000` + emulador do Firestore em
`127.0.0.1:8080` (banco `helo-db`), conforme o procedimento documentado no README.
Nenhum acesso a `/Users/fabiogarcia/Documents/Helo`.

**Escopo desta fase.** A 4.9 atende exclusivamente à *continuidade de uma sessão
manual já iniciada e já autenticada quando a conexão cai*. Ficam explicitamente
fora: login offline, criação de paciente offline, troca de paciente offline, IA
offline, ElevenLabs offline, decisões automáticas e sincronização silenciosa de
conflitos.

---

## 1. Arquitetura atual

### 1.1 Banco e SDK

- **Firestore** acessado **somente pelo servidor**, via `firebase-admin`
  (`lib/firestore.ts`). O banco é nomeado — `helo-db`, não `(default)`.
- **Não existe Firebase client SDK no projeto.** `package.json` traz apenas
  `firebase-admin`. O navegador nunca abre uma conexão com o Firestore.
- `firestore.rules` nega **toda** leitura e escrita de cliente
  (`allow read, write: if false`). Isso é estrutural, não uma configuração de
  conveniência.

Consequência direta para a 4.9: **a persistência offline nativa do Firestore
(`enableIndexedDbPersistence`) não está disponível e não deve ser buscada.** Usá-la
exigiria (a) adicionar o SDK cliente, (b) abrir as regras do Firestore para o
navegador e (c) mover a autorização por paciente do servidor para as rules — ou
seja, desmontar a garantia central de segurança do produto para ganhar um cache.
Está descartada.

### 1.2 Coleções da sessão RTQ

```
conversationQuestionSessions/{sessionId}                        ← sessão
conversationQuestionSessions/{sessionId}/turns/{turnId}         ← perguntas fechadas
conversationQuestionSessions/{sessionId}/paths/{pathId}         ← caminhos
conversationQuestionSessions/{sessionId}/nodes/{nodeId}         ← níveis (campo pathId)
conversationQuestionSessions/{sessionId}/statements/{stmtId}    ← frases (campo pathId)
conversationQuestionSessions/{sessionId}/contexts/{contextId}   ← contexto (4.8)
conversationQuestionSessions/{sessionId}/patientControls/{id}   ← comandos do paciente (4.7)
conversationQuestionSessions/{sessionId}/events/{eventId}       ← trilha de auditoria
patients/{patientId}/realtimeQuestionConfig/responseProfile     ← sinal → resposta
users/{userId} · userPatientAccess/{userId}_{patientId} · authSessions/{token} · auditEvents/{id}
```

`nodes` e `statements` ficam **planos** sob a sessão (não aninhados no caminho),
para que histórico, breadcrumb e leitura transacional sejam consultas simples.

Mapeamento pedido → onde vive:

| Conceito | Onde | Observação |
| --- | --- | --- |
| Perguntas | `turns/{turnId}` | `reviewedText` (editável) vs. `presentedText` (congelado) |
| Turnos | `turns/{turnId}` | `sequence` do contador da sessão, dentro da transação |
| Caminhos | `paths/{pathId}` | `kind: OPTION_TREE \| CAREGIVER_INTERPRETATION` |
| Nós | `nodes/{nodeId}` | opções **embutidas** no documento do nó |
| Respostas provisórias | campo `provisionalResponse` / `provisionalOptionId` | nunca uma coleção própria |
| Frases finais | `statements/{stmtId}` | `origin` decide o modo, nunca o contrário |
| Interpretações do cuidador | `statements` com `origin: CAREGIVER_INTERPRETATION` | mesma entidade da frase final |
| Comandos diretos do paciente | `patientControls/{id}` | não é fala; não passa pelo portão de autoria |
| Contexto da sessão | `contexts/{contextId}` | versionado, uma única `ACTIVE` |
| Eventos de auditoria | `events/{eventId}` | append-only, sem rota de escrita |
| Confirmações reforçadas | `reconfirmedAt` + status `RECONFIRMATION_PENDING` | obrigatório em conteúdo sensível |

### 1.3 Versionamento e substituição

Nada apresentado ao paciente é reescrito. As três formas de "mudar" são:

1. **Editar antes de apresentar** — mesmo registro (`REVIEW`, `EDIT`).
2. **Versão corrigida depois de apresentar** — registro NOVO em rascunho, o
   original vai a `REPLACED` com `replacedByNodeId`/`replacedByStatementId`; o
   novo carrega `replacesNodeId`/`replacesStatementId`. Nenhuma resposta migra.
3. **Voltar pelo breadcrumb** — o alvo e seus descendentes vão a `INACTIVE`
   preservando a escolha que receberam, e uma **cópia** do nível reabre numa
   ramificação nova (`branchId` novo).

O contexto (4.8) segue o mesmo princípio: gravar cria a versão *n+1* e marca a
anterior como `REPLACED` **na mesma transação** — nunca há duas vigentes, e
nenhuma versão desaparece.

### 1.4 Atomicidade, transações e timestamps

- Toda mudança de estado e o evento de auditoria correspondente são gravados na
  **mesma** `firestore.runTransaction`. Nunca uma sem a outra.
- A transação **relê** o documento antes de decidir: duas ações simultâneas não
  confirmam respostas diferentes — a segunda reexecuta contra o estado novo e é
  recusada pela máquina de estados.
- **Timestamps são sempre do servidor** (`new Date().toISOString()`). O cliente
  nunca envia horário, autoria nem `sequence`.
- `patientId` e `assistantId` **nunca** vêm do corpo da requisição: o paciente é
  o da sessão (imutável) e o assistente é o usuário autenticado.

### 1.5 Quem faz o quê

| Camada | Responsabilidade | O que **não** faz |
| --- | --- | --- |
| **Cliente** (componentes) | Mostra o que o servidor devolveu; despacha a *ação* do assistente | Não escolhe o próximo estado; não escreve `status`; não gera id de entidade |
| **Cliente** (`realtime-question-client.ts`) | Ponte única: fila serializada em memória, deduplicação de requisição em voo, contador "Registrando…", tradução do erro | Não persiste nada; não retenta; não sobrevive a um refresh |
| **API** (`app/api/realtime-questions/*`) | Autorização (`requirePatientAccess`), parsing estrito do corpo, tradução de erro de domínio em HTTP 400 | Não decide transição; recusa campos que só o domínio pode escrever (ex.: `MARK_REPLACED`) |
| **Máquina de estados** (`*-machine.ts`) | Ponto único de transição; calcula `patch` + `event` | Não toca no Firestore |
| **Store** (`*-store.ts`) | Normaliza, valida invariantes, executa a transação, grava a trilha | Não confia em nada vindo do cliente |
| **Firestore** | Isolamento estrutural por `patientId`; releitura transacional | Não é acessível ao navegador |

### 1.6 Autenticação e autorização

- **Identidade do cuidador**: cookie `__session` — nome obrigatório, porque atrás
  do Firebase Hosting o CDN descarta todos os outros cookies das requisições ao
  backend.
- **Forma**: token opaco de 32 bytes aleatórios em hex. `HttpOnly`, `SameSite=Lax`,
  `Secure` em produção, `Max-Age` de 30 dias.
- **Sessão**: `authSessions/{token}` no Firestore, com `expiresAt` de 30 dias.
  `getSessionUserId` valida o formato (`/^[a-f0-9]{64}$/`), lê o documento,
  compara `expiresAt` e **apaga** o documento se expirou.
- **Renovação**: **não existe**. O token não é rotacionado nem estendido; ele
  simplesmente vale 30 dias e depois morre.
- **Autorização por paciente**: `requirePatientAccess` consulta
  `userPatientAccess/{userId}_{patientId}`, exige vínculo `active` e, quando
  pedido, a permissão específica (`createSession`, `viewSessions`). Admin passa
  sem vínculo. **Isso é reverificado a cada requisição** — nunca em cache.
- **Proteção entre pacientes**: além do vínculo, o isolamento é estrutural —
  `getRtqSession` devolve `null` se o `patientId` da sessão não bate, e cada
  `readNode`/`readStatement`/`readPath` refaz a checagem dentro da transação.
  Trocar o id na URL não alcança dados de outro paciente.
- **Revogação**: `revokeLink` **apaga** o documento do vínculo. `updateUser` com
  `status: inactive` chama `invalidateUserSessions`, que apaga todas as sessões do
  usuário. O efeito é imediato na próxima requisição — 401 ou 403.

**Perda de conexão hoje**: `fetch` lança, o cliente traduz para
`RtqClientError("offline", "Sem conexão com o Helo. O registro não foi salvo.")`,
uma faixa aparece e a escrita é **perdida**. O rascunho digitado continua na tela
(estado React), mas some num refresh.

**Expiração da autenticação hoje**: 401 → `"Sua sessão expirou. Entre novamente
para continuar."`. Em `/api/patients`, o 401 dispara `clearLocalMirrors()` +
`redirectToLogin()` — os espelhos locais do usuário anterior são limpos.

### 1.7 Identificadores e idempotência

**Todos os ids de entidade nascem no servidor**, por `newId(prefix)` em
`lib/realtime-question-store.ts`:

| Entidade | Prefixo | Gerado por |
| --- | --- | --- |
| Sessão | `cqs` | servidor |
| Turno | `cqt` | servidor |
| Caminho | `ocp` | servidor |
| Nó | `ocn` | servidor |
| Ramificação | `br` | servidor |
| Frase | *(via `newId` no store)* | servidor |
| Contexto | `ctx` | servidor |
| Comando do paciente | `pcr` | servidor |
| Evento de auditoria | `ev` | servidor |

O **único** identificador gerado no cliente é o `clientRequestId`
(`newRequestId(prefix)` → `prefixo-base36(agora)-6 chars aleatórios`). Ele **não é
a identidade do registro**: é a identidade da *intenção*.

Cobertura atual da idempotência por `clientRequestId`, **verificada dentro da
transação**:

| Operação | Idempotente por `clientRequestId` |
| --- | --- |
| `createPath` | ✅ |
| `restartPath` | ✅ |
| `createNode` | ✅ |
| `replaceNode` | ✅ |
| `returnToNode` (breadcrumb) | ✅ |
| `createStatement` | ✅ |
| `replaceStatement` | ✅ |
| `createCaregiverInterpretation` | ✅ (chave dupla: `${id}:path` + `${id}`) |
| `reuseNode` / `reuseStatement` / `reusePath` | ⚠️ parcial — ver §2, G1 |
| `saveSessionContext` | ✅ |
| `openPatientControl` | ✅ |
| `createTurn` | ❌ — dedup só no cliente, pela chave `newTurn:${sessionId}:${texto}` |
| `runTurnAction` · `runNodeAction` · `runStatementAction` · `runPathAction` · `runSessionAction` · `runPatientControlAction` · `reviewNode` | ❌ — ver §2, G2 |

**Concorrência entre dispositivos**: garantida pela releitura transacional + máquina
de estados. Dois dispositivos não confirmam respostas diferentes; o segundo é
recusado. Não existe hoje *token de versão* exposto ao cliente (as entidades têm
`updatedAt`, mas nenhuma rota aceita `If-Match`).

**Dependências entre operações** já existentes no cliente:

- `createNode` → `reviewNode` (duas chamadas em `flow.tsx:createNode`);
- `present` → `PRESENT` + `AWAIT_SELECTION` (duas chamadas);
- criar caminho → criar nó → apresentar → registrar seleção → confirmar.

### 1.8 Cliente serializado — o que existe hoje

`useRtqPersistence` (`lib/realtime-question-client.ts`) é a **ponte única**:

- `chain` (`useRef<Promise>`) serializa as **escritas**: a ordem em que o
  assistente agiu é a ordem em que o servidor recebe. Uma falha não trava a fila
  (`chain.current = tracked.catch(() => undefined)`).
- `inflight` (`useRef<Map>`) deduplica requisições **em voo** pela chave — o
  segundo clique compartilha a primeira promessa.
- Leituras ficam **fora** da fila: consultar não espera gravação.
- `pending` alimenta `saving` → indicador "Registrando…".

**Ambos vivem em `useRef`. Nada sobrevive a um refresh, a uma navegação ou a um
fechamento de aba.**

Recuperação após refresh, hoje, é **100% servidor**:

- `GET /api/realtime-questions/sessions?sessionId=…` devolve sessão + turnos +
  contexto vigente + pedido de controle aberto, numa leitura só;
- `GET /paths?detail=1` devolve todos os caminhos com nós e frases;
- `flow.tsx` deriva a tela de `telaDerivada(detail)` e o rascunho do editor de
  `draftFromNode(editingNode)` — o rascunho digitado (`typedDraft`) só sobrepõe o
  persistido enquanto a chave do nível bate;
- `session.tsx` reabre sozinho o caminho ainda vivo.

Estado **puramente de tela** (não persistido, some no refresh — e está correto que
suma): `correctingTurnId`, `correctingNodeId`, `override`/`setScreen`,
`controlsOpen`, `notUnderstood`, `historyEntry`, `revisandoInterpretacao`,
`interpretationDraft` antes de confirmar, `failed` (a última ação que falhou).

Estado que **pode ser serializado com segurança** (é conteúdo do cuidador, não
afirmação sobre o paciente): `typedDraft` do editor de nível, `draft`/`sensitive`/
`category` do compositor de pergunta, `interpretationDraft`, `ContextDraft`,
`openPathId`, e o snapshot de leitura (`SessionDetail` + `PathDetail[]`).

Estado que **não pode** ser serializado como verdade: qualquer `status`,
`confirmedResponse`, `confirmedAt`, `presentedText`, `sequence`, `version` —
tudo isso nasce no servidor e só o servidor pode afirmá-lo.

### 1.9 Recursos offline existentes

| Recurso | Situação |
| --- | --- |
| Service Worker | **não existe** |
| PWA / `manifest.json` | **não existe** (`public/` tem só áudio, ícones e SVGs) |
| Cache de assets | Firebase Hosting: `/_next/static/**` → `max-age=31536000, immutable`; todo o resto → `no-cache` |
| Cache Storage API | **não usado** |
| IndexedDB | **não usado** |
| `localStorage` | usado — ver abaixo |
| `sessionStorage` | `heloWelcomeAudioPlayed` |
| Persistência offline do Firebase | **indisponível** (sem SDK cliente, e as rules negam tudo) |
| Listeners realtime | **não existem** — todo dado chega por `fetch` sob demanda |
| Estratégia de reconexão | apenas em `helo-agent-provider.tsx` (ElevenLabs), via `navigator.onLine`. **Nada no modo RTQ.** |
| Bibliotecas reutilizáveis já instaladas | **nenhuma** para offline. Deps de produção: `@anthropic-ai/sdk`, `@elevenlabs/react`, `firebase-admin`, `next`, `react`, `three` |

Chaves em `localStorage` hoje:

| Chave | Conteúdo | Limpa no logout? |
| --- | --- | --- |
| `helo.patientId` | paciente ativo | ✅ |
| `helo.patients` | lista de pacientes autorizados | ✅ |
| `helo.settings.{pid}` | configurações do paciente | ✅ |
| `helo.items.{pid}.{mode}` | itens de Rotina/Emergência | ✅ |
| `heloPlatformMuted` | preferência de mute do usuário | ❌ (sem o ponto — fora do prefixo) |
| `heloAgentInputDeviceId` | microfone escolhido | ❌ (idem) |

`clearLocalMirrors()` varre **exatamente** o prefixo `helo.` e é chamada em dois
pontos: no `logout()` e no 401 de `/api/patients`. As duas chaves fora do prefixo
são preferências de dispositivo, sem dado de paciente — a exclusão é deliberada e
está correta.

**Este é o ativo mais importante que a 4.9 herda**: já existe um ciclo de vida de
espelho local, com ponto único de limpeza, testado em produção. A camada offline
deve **entrar nele**, não criar um segundo.

---

## 2. Lacunas encontradas

**G1 — `reuseNode`/`reuseStatement`/`reusePath` duplicam a trilha no replay.**
Essas três funções são **compostas de transações independentes**: `createPath` →
`createNode`/`createStatement` → `recordReuse`. As criações são idempotentes por
`clientRequestId`, mas `recordReuse` abre uma transação própria e grava
`CONTENT_REUSED` num `newId("ev")` novo **a cada chamada**. Se a resposta se
perder depois do commit e a operação for reenviada com o mesmo
`clientRequestId`, os registros são deduplicados corretamente e a trilha ganha
**um segundo evento de reutilização para a mesma reutilização**. Hoje isso é raro;
com fila offline, vira rotina.

**G2 — transições de estado não têm chave de idempotência.**
`runTurnAction`, `runNodeAction`, `runStatementAction`, `runPathAction`,
`runSessionAction`, `runPatientControlAction` e `reviewNode` não aceitam
`clientRequestId`. A proteção contra replay é a máquina de estados, e ela é
**suficiente contra corrupção, mas não é idempotência**:

- na quase totalidade dos casos o replay é *recusado* porque o estado já avançou
  (`PRESENT` sobre `PRESENTED`, `REPRESENT` sobre `PRESENTED`, `CONFIRM` sobre
  `CONFIRMED`, `CHANGE_RESPONSE` com a mesma resposta → *"a resposta selecionada
  já é essa"*). O cuidador recebe **um erro de domínio para uma ação que de fato
  foi aplicada** — indistinguível de "sua ação foi recusada". Offline, esse é o
  caso comum, não a exceção;
- há **uma exceção que corrompe**: `REMOVE_RESPONSE` sobre uma frase
  (`option-conversation-machine`) é permitida a partir de `PROVISIONAL_RESPONSE`
  **e devolve `PROVISIONAL_RESPONSE`**. Um replay é aceito e incrementa
  `correctionCount` **de novo**, além de gravar um segundo evento. `correctionCount`
  é dado observacional sobre a interação do paciente — inflá-lo é exatamente o tipo
  de corrupção silenciosa que o resto do projeto evita. (Os equivalentes de turno e
  de nó são seguros: `REMOVE_RESPONSE` de turno vai para `AWAITING_RESPONSE` e
  `REMOVE_SELECTION` vai para `AWAITING_SELECTION`, então o replay é barrado.)
- operações naturalmente idempotentes no conteúdo (`REVIEW`, `EDIT` com o mesmo
  texto) não incrementam contador, mas **gravam um segundo evento de auditoria**.

**G3 — a fila do cliente é volátil.** `chain` e `inflight` são `useRef`. Um
refresh, uma troca de aba ou o `beforeunload` matam a fila com o que houver
dentro.

**G4 — não há retentativa.** `RtqClientError.kind === "offline"` existe e é
traduzido, mas nada o consome como "tentar de novo depois". `failed` em
`session.tsx` guarda **uma** ação para um botão manual "Tentar novamente", em
memória.

**G5 — sem app shell, offline é tela em branco.** Não há Service Worker. Um
refresh sem rede (ou o simples fim do timeout de uma navegação) tira o app inteiro
do ar, incluindo o que já estava carregado.

**G6 — sem cache de leitura, não há o que renderizar.** `sessionDetail` e
`pathDetails` vêm sempre da rede. Sem elas o modo não monta.

**G7 — o modo RTQ não sabe que está offline.** `navigator.onLine` e os eventos
`online`/`offline` só existem em `helo-agent-provider.tsx`. Não há estado visual de
conectividade em nenhuma tela de sessão.

**G8 — sem token de versão para concorrência entre dispositivos.** As entidades têm
`updatedAt`, mas nenhuma rota aceita uma pré-condição. Um dispositivo que ficou
offline não tem como dizer ao servidor "eu agi sobre a versão X".

**G9 — sem sinal de expiração da sessão de autenticação no cliente.** O cookie é
`HttpOnly` (correto), mas o cliente não recebe nem um `expiresAt` opaco. Ele
descobre que expirou apenas ao receber 401 — e offline não recebe nada.

**G10 — `pauseOnUnload` falha em silêncio.** Sai da página sem rede → a sessão fica
`ACTIVE` no servidor. Isso é **aceitável por desenho**: `perguntas/page.tsx`
trata `ACTIVE` como recuperável, com o comentário explícito de que a página pode
ter sido recarregada antes de a pausa chegar. Fica registrado, não é defeito.

---

## 3. Arquitetura offline proposta

### 3.1 O princípio

> **A camada offline é um registro de INTENÇÕES, nunca uma réplica do banco.**

O local guarda três coisas, separadas e com estatutos diferentes:

1. **Snapshot** — a última verdade que o servidor disse, cifrada, somente leitura,
   carimbada com `snapshotAt`. É o único material que pode ser tratado como fato.
2. **Fila** — operações que o cuidador pediu e que ainda não foram aceitas pelo
   servidor. São *pedidos*, não resultados.
3. **Rascunhos** — texto do cuidador ainda não enviado (editor de nível,
   compositor de pergunta, interpretação, contexto).

A tela renderiza o snapshot **mais** uma projeção otimista da fila, e as duas nunca
se confundem visualmente nem no tipo.

**Por que isso, e não um mirror do Firestore:** porque a invariável de autoria
(§7) exige que nenhum conteúdo vire fala confirmada por estar salvo localmente. Se
o local fabricasse documentos de `statement` com `status: "CONFIRMED"`, bastaria
alimentá-los a `tryToConfirmedPatientStatement` para que a interface exibisse
*"Confirmada pelo paciente"* sem que o paciente tivesse sido registrado em lugar
nenhum. Guardando **intenções**, a fabricação é impossível por construção: o portão
de autoria continua recebendo **apenas** documentos vindos do snapshot do servidor.

### 3.2 As três camadas novas

```
┌───────────────────────────────────────────────────────────────┐
│ components/realtime-questions/*  (inalterados no essencial)   │
│   + chip de sincronização (só na moldura do cuidador)         │
└───────────────────┬───────────────────────────────────────────┘
                    │  mesma interface RtqPersistence
┌───────────────────▼───────────────────────────────────────────┐
│ lib/realtime-question-client.ts   ← ponto de entrada ÚNICO    │
│   escrita:  tenta rede → se offline, ENFILEIRA e devolve      │
│             um resultado PENDENTE (nunca um documento falso)  │
│   leitura:  rede → grava snapshot; offline → lê snapshot      │
└───────────────────┬───────────────────────────────────────────┘
                    │
┌───────────────────▼───────────────┐  ┌────────────────────────┐
│ lib/offline/queue.ts              │  │ lib/offline/store.ts   │
│  fila ordenada, dependências,     │  │  IndexedDB + AES-GCM   │
│  backoff, reconciliação           │  │  ciclo de vida da chave│
└───────────────────────────────────┘  └────────────────────────┘
```

Nenhum componente muda de contrato: `RtqPersistence` continua sendo a mesma
interface. É isso que mantém a mudança contida.

### 3.3 IDs antes da sincronização

> ### ⚠ SUPERADA na execução 2 — ver a Decisão 1, no fim deste documento
>
> O desenho de **handles** descrito abaixo **não foi implementado** e não deve
> ser. A execução 2 (Fase 4.9.2) já havia entregue, testado e posto em produção
> o desenho oposto — o cliente cunha o id definitivo — e a Fase 4.9.3-B o
> formalizou no servidor. O texto original fica preservado abaixo, sem edição,
> porque apagá-lo esconderia a razão de a Decisão 1 existir.
>
> Onde este documento ainda disser "handle" (§4, §5, §9, §10 linha 13, §15),
> leia **"id definitivo cunhado pelo cliente"**. Não há tabela `handle → idReal`,
> e não há reescrita da fila depois de uma criação.

**A identidade do registro continua sendo a que o servidor cunha.** O offline não
inventa `ocn…`/`ocp…`/`cqt…`.

Introduz-se um **handle local de correlação**, que existe apenas dentro da fila:

```
local:node:9f3c…      local:path:1a7b…      local:statement:c40e…
```

Regras:

1. Um handle **nunca** viaja para o servidor. O sincronizador o substitui pelo id
   real antes de montar o corpo da requisição.
2. Quando o servidor responde a uma criação, o sincronizador registra
   `handle → idReal` e **reescreve** as operações seguintes da fila que dependiam
   do handle.
3. Se uma operação ainda tem handle não resolvido no momento do envio, ela **não é
   enviada** — fica bloqueada por dependência (§5).
4. Handles são descartados assim que a fila esvazia. Eles não entram no snapshot,
   não entram na trilha e não têm significado fora da sessão de sincronização.

Isso atende "gerar ids antes da sincronização sem alterar a identidade do registro":
o que se gera antes é a **correlação**, não a identidade.

**Chave de idempotência.** Cada operação da fila carrega um `clientRequestId`
gerado **uma vez**, no momento em que o cuidador age, e **preservado por todas as
retentativas**. Isso é o oposto do comportamento atual, em que a interface chama
`newRequestId(...)` a cada clique.

### 3.4 Mudanças necessárias no servidor (Execução 2)

Para que a fila seja segura, três mudanças mínimas:

**(a) Ledger de idempotência transacional.**

```
conversationQuestionSessions/{sessionId}/appliedRequests/{clientRequestId}
  → { op, appliedAt, resultRef: { kind, id }, assistantId }
```

Escrito **na mesma transação** da operação. Antes de aplicar, a transação lê o
documento: se existe, devolve o resultado registrado em vez de reaplicar. Isso
resolve G1 e G2 de uma vez, para **todas** as operações, sem espalhar checagens
`clientRequestId` por dez funções — e sem tocar em nenhuma máquina de estados.

**(b) `clientRequestId` aceito nas rotas de transição.** `turns` (PATCH), `nodes`
(PATCH), `statements` (PATCH), `paths` (PATCH), `sessions` (PATCH),
`patient-controls` (PATCH), e no POST de `turns`. Opcional, para não quebrar nada.

**(c) `recordReuse` dentro da transação de criação.** Elimina a janela de G1 na
origem, em vez de só mascará-la com o ledger.

**Não** se propõe `If-Match`/versão otimista: a releitura transacional + máquina de
estados já cobre a concorrência, e o `updatedAt` do snapshot basta para a
**detecção** de conflito (§10).

### 3.5 Marcação de origem offline na auditoria

Uma operação enfileirada offline e aplicada depois recebe:

- `createdAt` = **horário do servidor no momento da aplicação** (regra do projeto,
  inalterada);
- `metadata.offlineQueued = true`;
- `metadata.intendedAt` = horário do relógio **local** quando o cuidador agiu,
  explicitamente marcado como não confiável.

O relógio local nunca substitui o do servidor. Ele entra como *observação sobre a
intenção*, não como fato temporal.

---

## 4. Arquivos que seriam alterados

**Novos**

| Arquivo | Papel |
| --- | --- |
| `lib/offline/store.ts` | IndexedDB + Web Crypto: abrir, cifrar, decifrar, expirar, limpar |
| `lib/offline/queue.ts` | Fila ordenada, dependências, handles, backoff, reconciliação |
| `lib/offline/types.ts` | `QueuedOperation`, `SyncState`, `ConflictKind`, `OfflineSnapshot` |
| `lib/offline/snapshot.ts` | Serialização/validação do `SessionDetail` + `PathDetail[]` |
| `lib/offline/connectivity.ts` | `useConnectivity()` — `navigator.onLine` + sonda real ao servidor |
| `components/realtime-questions/sync-chip.tsx` | Os sete estados visuais (§11) |
| `components/realtime-questions/conflict-screen.tsx` | Decisão do cuidador diante de cada conflito |
| `public/manifest.webmanifest` | PWA mínimo (nome, ícones, `display`, `start_url`) |
| `app/sw.ts` (ou `public/sw.js`) | Service Worker: app shell + **nunca** cachear `/api/**` |
| `scripts/test-offline-queue.mjs` | Suíte de domínio da fila (puro, sem rede) |
| `scripts/test-offline-idempotency.mjs` | Suíte HTTP do ledger de idempotência |
| `tests/e2e/offline-continuidade.spec.ts` | Playwright com `context.setOffline(true)` |

**Alterados**

| Arquivo | Mudança |
| --- | --- |
| `lib/realtime-question-client.ts` | Escritas passam pela fila; leituras alimentam/consultam o snapshot; `clientRequestId` estável por gesto |
| `lib/use-auth.ts` | `clearLocalMirrors()` passa a limpar também IndexedDB e a chave — **ponto único de limpeza** |
| `lib/patient.tsx` | Troca de paciente limpa a área offline do paciente anterior |
| `components/realtime-questions/session.tsx` | Monta o chip; usa `pacienteEstaOlhando` para escondê-lo; monta a tela de conflito |
| `components/realtime-questions/option-conversation/flow.tsx` | Idem, dentro do caminho |
| `lib/realtime-question-store.ts` | Ledger `appliedRequests` (helper transacional compartilhado) |
| `lib/option-conversation-store.ts` | Ledger nas transições; `recordReuse` para dentro da transação |
| `lib/session-context-store.ts` · `lib/patient-control-store.ts` | Ledger |
| `app/api/realtime-questions/{turns,nodes,statements,paths,sessions,patient-controls}/route.ts` | Aceitar `clientRequestId` opcional |
| `app/layout.tsx` | Link do manifest + registro do Service Worker |
| `firebase.json` | Header `no-cache` explícito para `/sw.js` |
| `package.json` | Novos scripts de teste |
| `README.md` | Seção 4.9 |

**Não alterados, deliberadamente**

`lib/confirmed-patient-statement.ts` · `lib/*-machine.ts` · `lib/option-conversation-screen.ts` ·
`firestore.rules`. O portão de autoria, as máquinas de estados e a regra de quem
vê a tela **não mudam**. Se a implementação precisar mexer em qualquer um deles, é
sinal de que o desenho saiu do trilho.

---

## 5. Modelo da fila

```ts
type OperationStatus =
  | "PENDING"        // aguardando envio
  | "BLOCKED"        // dependência não resolvida
  | "SENDING"        // em voo
  | "APPLIED"        // aceita pelo servidor
  | "CONFLICT"       // recusada; exige decisão do cuidador
  | "FAILED";        // falha permanente; exige decisão do cuidador

interface QueuedOperation {
  seq: number;                    // ordem monotônica local — a ordem em que o cuidador agiu
  clientRequestId: string;        // ESTÁVEL entre retentativas
  op: OperationKind;              // "createNode" | "nodeAction" | "statementAction" | …
  sessionId: string;
  patientId: number;
  userId: string;                 // dono da fila; nunca sincroniza sob outra identidade

  payload: Record<string, unknown>;   // sem token, sem cookie, sem chave
  handles: string[];                  // handles locais citados no payload
  dependsOn: number[];                // seq de operações que precisam estar APPLIED

  status: OperationStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: { kind: RtqErrorKind; message: string } | null;

  intendedAt: string;             // relógio LOCAL — metadado, nunca createdAt
  snapshotUpdatedAt: string | null; // updatedAt da entidade quando o cuidador agiu
}
```

**Ordem.** Estritamente FIFO por `seq` dentro de uma sessão. Uma operação
`BLOCKED` **não** é ultrapassada: a ordem em que o assistente agiu é a ordem em que
o servidor recebe, e essa é a mesma promessa que a `chain` já faz hoje online.

**Dependências.** Explícitas, nunca inferidas. Os pares compostos que já existem no
cliente entram como dependência declarada:

```
createNode(local:node:X)  →  reviewNode(local:node:X)
                          →  nodeAction(local:node:X, PRESENT)
                          →  nodeAction(local:node:X, AWAIT_SELECTION)
```

**Retry e backoff.** Exponencial com jitter: `2s, 4s, 8s, 16s, 32s, 60s`, teto de
60s, **máximo de 8 tentativas** por operação. Tentativa só acontece com
conectividade confirmada (sonda real, não só `navigator.onLine`).

**Interrupção.** Um `CONFLICT` ou `FAILED` **para a fila daquela sessão**. Nada
depois dele é enviado. Isso é deliberado: enviar a operação seguinte por cima de um
conflito não resolvido é exatamente a "sincronização silenciosa" que a fase proíbe.

**Retomada.** Após a decisão do cuidador, a fila retoma do ponto exato.

**Limpeza.** Uma operação `APPLIED` é removida assim que o snapshot correspondente
é atualizado. Fila vazia + snapshot fresco → área offline daquela sessão pode ser
descartada.

**Expiração da autenticação durante a sincronização.** 401/403 →
`status: "FAILED"`, fila **parada**, estado visual "Autenticação necessária". A fila
**não** é descartada: ela é preservada até o cuidador reautenticar **com a mesma
identidade** (`userId` bate). Login com outra identidade → a fila é descartada sem
sincronizar, e o cuidador é avisado do descarte. Nunca se grava sob a autoria
errada.

---

## 6. Classificação dos dados

| Grupo | Classificação | Justificativa |
| --- | --- | --- |
| `sessionId`, `pathId`, `nodeId`, `statementId`, `turnId`, `contextId` | **Permitido localmente, cifrado** | Opacos, mas correlacionáveis a uma sessão clínica |
| `patientId` | **Permitido localmente, cifrado** | Já espelhado hoje em claro (`helo.patientId`); sob a nova área, cifrado |
| Handles locais (`local:*`) | **Permitido localmente, em claro** | Aleatórios, sem significado fora da fila |
| Perguntas (`reviewedText`, `presentedText`) | **Permitido localmente, cifrado** | Conteúdo de conversa |
| Opções e rótulos dos níveis | **Permitido localmente, cifrado** | Conteúdo de conversa |
| Respostas **provisórias** | **Permitido localmente, cifrado** | Observação do cuidador, ainda não confirmada |
| Respostas **confirmadas** | **Permitido localmente, cifrado, somente como snapshot do servidor** | Nunca produzidas localmente — ver §7 |
| Interpretações do cuidador | **Permitido localmente, cifrado** | Texto do cuidador; a origem viaja junto e não pode se perder |
| Contexto da sessão | **Permitido localmente, cifrado** | Contém nome e relação do interlocutor |
| Comandos diretos do paciente | **Permitido localmente, cifrado** | Não é fala; mas revela o curso da conversa |
| Rascunhos e seleções provisórias | **Permitido localmente, cifrado** | É o que a fase existe para não perder |
| Trilha de auditoria (eventos) | **Proibido localmente como trilha** | A trilha nasce no servidor, na transação. O local guarda **intenção**, não evento |
| Nome do paciente | **Permitido localmente, cifrado, por prazo limitado** | Já espelhado hoje; passa a expirar |
| Nomes de interlocutores / rede do paciente | **Permitido localmente, cifrado, por prazo limitado** | Dado de terceiros |
| Conteúdo de conversa (geral) | **Permitido localmente, cifrado, por prazo limitado** | Núcleo da fase |
| Dados sensíveis / médicos (`isSensitive`, `sensitiveCategory`, texto marcado) | **Permitido localmente, cifrado, prazo mais curto** | TTL de 24h, contra 7 dias do restante |
| Credenciais (cookie, token, senha, hash) | **Proibido localmente** | O cookie é `HttpOnly` — inalcançável por JS, e assim deve permanecer |
| Chaves de API (ElevenLabs, Anthropic) | **Proibido localmente** | Só existem no servidor; nunca chegam ao cliente |
| Conversation token WebRTC | **Proibido localmente** | Efêmero, por definição |
| Permissões do vínculo | **Permitido apenas para exibição, nunca para autorizar** | A autorização é sempre do servidor, a cada requisição |
| Configurações de voz (voz do paciente, preferência de voz do usuário) | **Exige conexão** | Fora do escopo da fase; TTS é online |
| Lista de pacientes | **Exige conexão para mudar** | Espelho de leitura já existe; **trocar** de paciente offline é proibido |
| Perfil de resposta (sinal → SIM/TALVEZ/NÃO) | **Permitido localmente, cifrado, por prazo limitado** | Sem ele o palco do paciente não monta corretamente |

**Prazos.** Snapshot e fila: **7 dias**. Conteúdo marcado como sensível: **24 horas**.
Fila com falha permanente não expira sozinha — ela **exige decisão do cuidador**
(mas o snapshot ao redor expira normalmente).

---

## 7. Autoria e consentimento

A arquitetura preserva integralmente a invariável, e o faz **por construção**:

1. **`ConfirmedPatientStatement` não muda.** `lib/confirmed-patient-statement.ts`
   não é tocado. O símbolo `AUTHORSHIP` continua não exportado.
2. **O portão só recebe documentos do snapshot.** A projeção otimista da fila é um
   tipo **diferente** (`PendingStatementView`) que **não** é
   `OptionConversationFinalStatement` e portanto **não compila** se alguém tentar
   passá-lo a `toConfirmedPatientStatement`. A proteção é do compilador, não da
   disciplina do autor.
3. **Origem do texto e quem o formulou** viajam na fila como parte do payload
   (`origin: OPTION_PATH | CAREGIVER_INTERPRETATION`) e são gravados pelo servidor.
   `MODO_POR_ORIGEM` continua sendo a fonte única, conferida nos dois sentidos.
4. **Confirmação válida do paciente.** O SIM registrado offline é uma **intenção de
   registrar um SIM**. Enquanto não sincronizar, a tela diz *"Aguardando conexão"* —
   nunca *"Confirmada pelo paciente"*. `rotuloDeAutoria` só é chamado com uma
   `ConfirmedPatientStatement`, que só existe a partir do snapshot.
5. **Reconfirmação de conteúdo sensível.** `RECONFIRM` é uma operação da fila como
   outra qualquer, com a mesma ordem. O servidor continua recusando `CONFIRM` de
   frase sensível sem `reconfirmedAt`. A fila **não pode** pular a etapa: se o
   cuidador tentar, a operação simplesmente falha na sincronização — o que é
   correto.
6. **Distinção rascunho / interpretação / fala confirmada.** Três estatutos
   diferentes no armazenamento local: rascunho (chave `drafts`), intenção (chave
   `queue`), fato (chave `snapshot`). Não há caminho que promova um ao outro sem o
   servidor.
7. **Histórico e auditoria.** Nenhum evento é criado localmente. Ao sincronizar, o
   servidor grava o evento na mesma transação, com seu próprio horário, marcando
   `offlineQueued` e `intendedAt`.

> **Nenhum conteúdo vira fala confirmada por estar salvo localmente.** O local não
> tem como afirmar isso, porque não tem como construir o tipo que afirma.

---

## 8. Segurança local

### 8.1 IndexedDB — sim, e por quê

`localStorage` **não** serve para esta camada:

- é **síncrono** — bloquearia a thread principal durante o palco do paciente;
- é limitado (~5 MB) e só aceita string;
- **não pode guardar um `CryptoKey` não extraível** — só o texto da chave, que é a
  pior forma possível de guardar uma chave.

`IndexedDB` resolve os três. Os espelhos `helo.*` de hoje **ficam onde estão**:
movê-los não traz ganho e traria risco de regressão.

### 8.2 Criptografia com Web Crypto

```
generateKey({ name: "AES-GCM", length: 256 }, extractable = FALSE, ["encrypt","decrypt"])
```

- `extractable: false` — o `CryptoKey` é armazenado no IndexedDB por
  structured clone; **os bytes da chave nunca são alcançáveis por JavaScript**,
  nem por código nosso, nem por código injetado.
- **IV de 12 bytes, novo a cada gravação**, de `crypto.getRandomValues`. Reusar IV
  em GCM quebra a confidencialidade — é o erro clássico e não pode acontecer.
- Dados adicionais autenticados (AAD): `${userId}|${patientId}|${sessionId}`. Um
  blob movido para outro paciente ou outro usuário **falha na decifração**, não
  decifra errado.

### 8.3 Ciclo de vida da chave

| Momento | Ação |
| --- | --- |
| Primeira gravação offline da sessão | Gera a chave; grava sob `key:{userId}:{patientId}` |
| Logout | **Apaga a chave e todo o banco offline**, dentro de `clearLocalMirrors()` |
| 401 em qualquer rota | Idem — mesmo caminho, já existente |
| Troca de paciente | Apaga a chave e a área **do paciente anterior** |
| Login de outro usuário na mesma máquina | Apaga tudo antes de criar a nova chave |
| Expiração (7 dias / 24h sensível) | Apaga chave + dados na abertura seguinte do app |
| Fila pendente no logout | **Avisa antes**: "há registros aguardando conexão; sair agora os descarta" — e só descarta se o cuidador confirmar |

Apagar a chave **inutiliza os dados mesmo que o blob sobreviva** no disco por
algum motivo do navegador. É a única forma de "apagar" com alguma confiança em
IndexedDB.

### 8.4 Dispositivo compartilhado

As proteções reais, em ordem de eficácia:

1. **Limpeza no logout** — ponto único, já testado.
2. **Limpeza no 401** — sessão expirada sem logout explícito não deixa resíduo.
3. **TTL curto**.
4. **Escopo por `(userId, patientId)` na AAD** — outro usuário no mesmo navegador
   não decifra a área de quem veio antes.
5. **A criptografia** — última, e a menos importante das cinco.

### 8.5 Limitações reais — o que a criptografia **não** faz

Isto precisa estar dito com todas as letras, porque a tentação de tratar
"cifrado no navegador" como proteção forte é grande e errada:

- **Não protege contra XSS.** Código injetado na página roda com a mesma origem e
  pede à Web Crypto que decifre. A chave ser não extraível impede o roubo *da
  chave*, não o uso dela.
- **Não protege contra extensões do navegador** com permissão no domínio.
- **Não protege contra um usuário logado com o dispositivo desbloqueado.** Se a
  sessão está viva, os dados estão à mão — é o mesmo nível de exposição da tela.
- **Não é criptografia com chave do usuário.** Não há senha derivando a chave
  (isso exigiria pedir a senha de novo, o que a fase não prevê). A chave está no
  mesmo dispositivo que os dados.
- **Não garante apagamento físico.** IndexedDB não promete sobrescrita; o SO e o
  navegador podem manter páginas do arquivo. Apagar a chave é a mitigação.
- **Não substitui a autorização do servidor.** Nada em `IndexedDB` concede acesso
  a nada. A autorização por vínculo continua sendo reverificada a cada requisição.
- **Não protege contra perícia com acesso físico ao disco desbloqueado.**

> A criptografia local aqui é uma **camada de higiene**: evita que dados clínicos
> fiquem legíveis em texto puro no dispositivo e reduz a exposição em cenários
> casuais. Ela **não** é uma garantia de confidencialidade e não deve ser
> apresentada como tal a ninguém — nem em documentação, nem na interface.

---

## 9. Algoritmo de sincronização

```
sincronizar(sessionId):
  se já sincronizando → retorna
  se não há conectividade confirmada → retorna

  para cada op da fila, em ordem de seq:
    se op.status ∈ {CONFLICT, FAILED} → PARA (fila interrompida)
    se op.status = APPLIED            → pula
    se agora < op.nextAttemptAt       → PARA (respeita o backoff)

    se op tem handle não resolvido:
      op.status ← BLOCKED ; PARA

    se alguma dependência não está APPLIED:
      op.status ← BLOCKED ; PARA

    op.status ← SENDING
    resolve handles → payload final
    envia com clientRequestId ESTÁVEL

    resposta 2xx:
      registra handle → idReal (se criação)
      op.status ← APPLIED
      atualiza o snapshot com o que o servidor devolveu

    erro de rede:
      op.status ← PENDING
      op.attempts++
      se attempts > 8 → FAILED ; PARA
      op.nextAttemptAt ← agora + backoff(attempts)
      PARA

    401 / 403:
      op.status ← FAILED (kind: unauthorized)
      PARA ; estado visual "Autenticação necessária"
      a fila é PRESERVADA para a mesma identidade

    404:
      op.status ← CONFLICT (kind: missing)
      PARA ; tela de decisão

    400 (erro de domínio):
      relê a entidade no servidor
      se o estado do servidor JÁ REFLETE a intenção da op:
        op.status ← APPLIED     (era um replay; nada a fazer)
      senão:
        op.status ← CONFLICT ; PARA ; tela de decisão

  se a fila esvaziou:
    recarrega o snapshot completo do servidor
    descarta handles
    estado visual ← "Sincronizado"
```

**Confirmação individual.** Cada operação é confirmada isoladamente; não existe
commit em lote. Uma operação aceita não pode ser desfeita por uma posterior falhar.

**Gatilhos.** Evento `online`; retorno de foco à janela; timer de backoff; ação
manual do cuidador ("Tentar sincronizar"). Nunca em intervalo fixo agressivo — o
palco do paciente tem prioridade.

**Operações já existentes no servidor.** O ledger `appliedRequests` (§3.4) responde
com o resultado registrado, e a operação vira `APPLIED` sem reaplicar. É o caminho
principal; a releitura do 400 é a rede de segurança para operações anteriores ao
ledger.

---

## 10. Matriz de conflitos

**Regra absoluta: nenhum conflito é resolvido silenciosamente.** Toda linha abaixo
termina numa tela em que o cuidador decide. O padrão nunca é "aplicar mesmo assim".

| # | Situação | Detecção | Comportamento |
| --- | --- | --- | --- |
| 1 | **Sessão concluída em outro dispositivo** | 400 `"sessão concluída…"` ou snapshot com `status: COMPLETED` | Fila **parada**. Tela: *"Esta conversa foi encerrada em outro dispositivo às HH:MM. O que você registrou aqui não entrou."* Opções: **ver o que ficou pendente** · **descartar** · **iniciar nova conversa e reaproveitar os textos como rascunho** (nunca como confirmação) |
| 2 | **Sessão pausada em outro dispositivo** | 400 `"sessão pausada"` | Tela: *"A conversa foi pausada em outro dispositivo."* Opções: **retomar e continuar a sincronizar** (enfileira `RESUME` antes do resto) · **descartar** |
| 3 | **Pergunta substituída** | 400 sobre **nível** (`OptionConversationNode`) em `REPLACED` — ver a Decisão 2 | Tela mostra a pergunta original **e** a substituta. Opções: **descartar minha ação** · **repetir sobre a nova versão** (cria operação nova, `clientRequestId` novo). Nunca aplica automaticamente sobre a substituta |
| 4 | **Resposta alterada** | `snapshotUpdatedAt` ≠ `updatedAt` do servidor **e** `provisionalResponse` divergente | Tela com **as duas**: *"Você registrou TALVEZ às 14:32 (sem conexão). O servidor tem SIM, registrado às 14:35."* Opções: **manter a do servidor** · **aplicar a minha** (vira `CHANGE_RESPONSE`, contabilizada como correção, com trilha). Nunca "a mais recente vence" |
| 5 | **Caminho interrompido** | 400 sobre `path` em `INTERRUPTED`/`RESTARTED` | Tela: *"Este caminho foi encerrado."* Opções: **descartar** · **reutilizar o conteúdo num caminho novo** (§25, cria rascunho) |
| 6 | **Interpretação substituída** | `statement` em `REPLACED` | Como o caso 3, com destaque para a **origem**: a tela diz explicitamente quem formulou cada texto |
| 7 | **Contexto alterado** | versão vigente do servidor ≠ a do snapshot | Tela lado a lado das duas versões. Opções: **manter a do servidor** · **gravar a minha como nova versão** (que é o comportamento normal do 4.8 — versionar, não sobrescrever) |
| 8 | **Paciente diferente** | `patientId` da fila ≠ paciente ativo | Sincronização **não acontece**. Chip: *"Há registros de outro paciente aguardando conexão."* A fila só sincroniza com o paciente dela selecionado. Nunca grava no paciente errado |
| 9 | **Acesso revogado** | 403 | Fila **parada e marcada**. Tela: *"Você não tem mais autorização para registrar nesta conversa. Nada foi enviado."* A fila é **preservada e ilegível para outro usuário** (AAD), e é descartada no logout. Não há opção de "forçar" |
| 10 | **Registro já existente** | ledger `appliedRequests` responde | **Não é conflito**: `APPLIED`, segue em frente, sem tela e sem duplicar |
| 11 | **Versão do servidor mais recente** | `updatedAt` do servidor > `snapshotUpdatedAt` **sem** divergência de conteúdo | Snapshot é atualizado e a operação prossegue. Se houver divergência de conteúdo, cai no caso 4 |
| 12 | **Operação duplicada** | mesmo `clientRequestId` | Ledger devolve o resultado anterior → `APPLIED`. Sem tela, sem segundo registro, sem segundo evento |
| 13 | **Dependência ausente** | `dependsOn` não `SYNCED` (o "handle não resolvido" original saiu com a Decisão 1) | `BLOCKED`, fila parada. Se a dependência acabou em `FAILED`/`CONFLICT`, a tela explica **a cadeia inteira**: *"Não foi possível registrar o nível; por isso a opção escolhida também não foi."* O cuidador decide sobre o conjunto, não sobre uma peça solta |

---

## 11. Estados visuais

Sete estados, **exclusivos do cuidador**:

| Estado | Texto | Quando |
| --- | --- | --- |
| Salvo localmente | "Salvo neste aparelho" | Operação enfileirada, sem conexão |
| Aguardando conexão | "Aguardando conexão · N registros" | Fila com pendências, offline |
| Sincronizando | "Enviando registros…" | `SENDING` |
| Sincronizado | "Tudo registrado" | Fila vazia + snapshot fresco. **Some sozinho em 3s** |
| Conflito encontrado | "Precisa da sua decisão" | Qualquer `CONFLICT`. **Não some sozinho** |
| Falha ao sincronizar | "Não conseguimos enviar N registros" | `FAILED` por esgotamento |
| Autenticação necessária | "Entre novamente para enviar o que ficou" | 401/403 |

**Como isso não polui o palco do paciente.** A regra já existe e é testada: a barra
de contexto (4.8) segue o cuidador por todas as telas dele e **some no instante em
que a tela passa a ser do paciente**. Quem responde por essa fronteira é
`pacienteEstaOlhando`, em `lib/option-conversation-screen.ts` — a mesma função que
escolhe qual tela o caminho mostra, provada por enumeração de todos os 57 pares
`NodeStatus` × `StatementStatus` em `scripts/test-option-conversation-screen.mjs`.

O chip de sincronização **usa exatamente essa função**, não uma segunda regra:

```ts
{!pacienteEstaOlhando(detail) && <SyncChip … />}
```

Duas cópias da regra divergiriam, e a que divergisse mostraria ao paciente algo que
só o cuidador deveria ver. Esse é o mesmo raciocínio, e o mesmo teste, do commit
`286a3f9`.

Regras adicionais:

- O chip vive na **moldura** do cuidador, junto da barra de contexto — nunca sobre
  as opções, nunca sobre a frase aguardando o SIM.
- **Nenhum som, nenhuma vibração, nenhum modal automático.** Um conflito espera; ele
  não interrompe uma conversa em curso.
- A tela de conflito **só abre por ação do cuidador**, a partir do chip.

---

## 12. Prevenção de duplicações

Quatro barreiras, em profundidade:

1. **`clientRequestId` estável por gesto.** Gerado uma vez, preservado por todas as
   retentativas. É a mudança de hábito mais importante em relação ao código atual.
2. **Deduplicação em voo no cliente** (`inflight`). Já existe; permanece.
3. **Ledger `appliedRequests`, na transação.** Mesma `clientRequestId` → resultado
   anterior devolvido, sem reaplicar, sem segundo evento de auditoria. Cobre G1 e G2.
4. **Máquina de estados.** Última linha: mesmo sem ledger, uma transição já aplicada
   é recusada. Cobre operações anteriores ao ledger.

E, do lado da leitura: **`recordReuse` movido para dentro da transação de criação**,
eliminando a janela de G1 na origem.

---

## 13. Riscos

| # | Risco | Gravidade | Mitigação |
| --- | --- | --- | --- |
| R1 | Dado clínico persistido em dispositivo compartilhado | **Alta** | Limpeza no logout e no 401 (caminho único, já existente) · TTL 7d/24h · AAD por `(userId, patientId)` · cifra |
| R2 | Interface exibir intenção como fala confirmada | **Crítica** | Tipos distintos; `PendingStatementView` não compila contra o portão de autoria · testes de tipo |
| R3 | Registro duplicado na trilha de auditoria | **Alta** | Ledger transacional + `recordReuse` para dentro da transação |
| R4 | `correctionCount` inflado por replay (`REMOVE_RESPONSE` de frase) | **Média** | Ledger; teste dedicado a este caso específico |
| R5 | Ordem invertida na sincronização | **Alta** | FIFO estrito por `seq`, fila para no primeiro bloqueio |
| R6 | Sincronizar sob a identidade errada | **Crítica** | `userId` gravado na operação; identidade conferida antes de cada envio; fila descartada em login de outro usuário |
| R7 | Gravar no paciente errado | **Crítica** | `patientId` na operação e na AAD; sincronização só com o paciente dela ativo; servidor reverifica o vínculo |
| R8 | Service Worker servir HTML velho após deploy | **Média** | `no-cache` para `/sw.js`; versionamento do cache; **nunca** cachear `/api/**` |
| R9 | Service Worker interferir na conversa por voz (ElevenLabs/WebRTC) | **Média** | SW ignora completamente `/api/**` e qualquer origem que não a própria; teste de regressão do Agent Helo |
| R10 | Cota de armazenamento estourada | **Baixa** | Teto por sessão; `navigator.storage.estimate()`; degradar para "só a fila, sem snapshot" com aviso |
| R11 | Relógio local errado contaminar a trilha | **Média** | `intendedAt` é metadado explícito; `createdAt` sempre do servidor |
| R12 | Complexidade nova quebrar o que já funciona | **Alta** | `RtqPersistence` mantém o contrato · máquinas de estados e portão de autoria intocados · as 13 suítes atuais rodam sem alteração como critério de aceite |
| R13 | Cuidador confiar demais no modo offline e conduzir uma conversa longa sem rede | **Média** | Estado visual permanente e honesto; teto de operações na fila; aviso ao aproximar do teto |

---

## 14. Limitações declaradas

O que a 4.9, mesmo completa, **não** vai entregar:

1. **Login offline.** Sem sessão prévia, nada acontece. Recarregar após o cookie
   expirar leva ao login, e a fila espera.
2. **Criação ou troca de paciente offline.** O vínculo é do servidor.
3. **IA offline.** Sugestões exigem a Anthropic.
4. **Voz offline.** ElevenLabs, TTS, voz clonada e Agent Helo exigem rede. **O palco
   do paciente perde a voz offline** — o modo continua funcionando por texto e gesto,
   e isso precisa estar claro para o cuidador.
5. **Trilha de auditoria completa offline.** A trilha só é legível online.
6. **Histórico de sessões anteriores offline.** Apenas a sessão em curso.
7. **Colaboração em tempo real entre dispositivos.** Não há listeners; a
   sincronização é sob demanda.
8. **Garantia de entrega.** Se o dispositivo for perdido, formatado ou tiver os
   dados do site apagados, a fila vai junto. **Offline não é backup.**
9. **Confidencialidade forte no dispositivo.** Ver §8.5.
10. **Resolução automática de conflitos.** Por decisão de produto, não por
    limitação técnica.

---

## 15. Plano de testes

**Domínio (puro, milissegundos, sem rede)** — `scripts/test-offline-queue.mjs`

- ordem FIFO preservada com dependências e bloqueios;
- resolução de handles reescreve **todas** as operações seguintes;
- handle não resolvido nunca vaza para o payload enviado (asserção sobre o corpo);
- backoff: sequência exata e teto de 8 tentativas;
- `CONFLICT` e `FAILED` param a fila; nada posterior é enviado;
- retomada após decisão continua do ponto exato;
- **`clientRequestId` idêntico em todas as retentativas** da mesma operação;
- fila com `userId` diferente do usuário atual não sincroniza;
- fila com `patientId` diferente do paciente ativo não sincroniza;
- expiração remove snapshot e chave; sensível expira em 24h, o resto em 7 dias.

**Tipos (compilação é o teste)** — `scripts/test-offline-authorship.mjs` + `tsc`

- `PendingStatementView` **não** é aceito por `toConfirmedPatientStatement` —
  verificado por um caso que **deve** falhar a compilação;
- nenhum caminho constrói `ConfirmedPatientStatement` a partir de dado local;
- `rotuloDeAutoria` só é alcançável a partir do snapshot.

**HTTP (dev server + emulador)** — `scripts/test-offline-idempotency.mjs`

- mesma `clientRequestId` reenviada em **cada** operação (criação e transição) →
  um registro, **um** evento de auditoria;
- `REMOVE_RESPONSE` de frase reenviada → `correctionCount` **não** incrementa duas
  vezes (regressão direta de G2/R4);
- `reuseNode`/`reuseStatement`/`reusePath` reenviadas → **um** `CONTENT_REUSED`
  (regressão de G1);
- operação com `clientRequestId` de outra sessão → recusada;
- operação após revogação do vínculo → 403, nada gravado;
- operação após expiração da sessão de autenticação → 401, nada gravado;
- `metadata.offlineQueued` e `metadata.intendedAt` gravados; `createdAt` **sempre**
  do servidor.

**Interface (Playwright, `context.setOffline(true)`)** — `tests/e2e/offline-continuidade.spec.ts`

- sessão em curso → offline → o app **não** quebra; a tela continua montada;
- offline → refresh → a sessão volta do snapshot, com o caminho e o breadcrumb;
- rascunho digitado sobrevive a offline + refresh;
- registrar uma seleção offline → chip "Salvo neste aparelho"; a frase **não**
  aparece como confirmada;
- voltar online → chip percorre "Enviando…" → "Tudo registrado"; o servidor tem
  **exatamente** os registros esperados, sem duplicata;
- **o chip nunca aparece quando `pacienteEstaOlhando` é verdadeiro** — nas opções
  apresentadas e na frase aguardando o SIM;
- conflito de sessão concluída em outro dispositivo → tela de decisão, fila parada;
- logout com fila pendente → aviso antes de descartar;
- logout limpa IndexedDB (verificado por `evaluate` no contexto da página).

**Regressão obrigatória (critério de aceite)**

As **13 suítes atuais** (793 asserções) e os **6 lotes Playwright** precisam passar
**sem nenhuma alteração nos testes**. Um teste existente que precise mudar é um
sinal de que a 4.9 mexeu em algo que ela não deveria ter tocado.

---

## 16. Estratégia de commits

Um commit por garantia verificável, cada um com sua prova. **Nenhum commit deixa a
árvore sem `tsc` + build + suítes.**

**4.9.1 — Fundação (sem escrita offline)**

1. `docs(4.9)`: esta auditoria (este commit).
2. `feat(4.9)`: `lib/offline/store.ts` — IndexedDB + AES-GCM + ciclo de vida da
   chave. Sem consumidor ainda. Prova: suíte de domínio.
3. `feat(4.9)`: limpeza offline dentro de `clearLocalMirrors()`. Prova: teste
   Playwright de logout e de 401.
4. `feat(4.9)`: snapshot de leitura — `sessionDetail`/`pathDetails` gravam e leem.
   Prova: refresh offline recupera a sessão.
5. `feat(4.9)`: `useConnectivity()` + chip, escondido por `pacienteEstaOlhando`.
   Prova: teste que o chip nunca aparece no palco do paciente.
6. `feat(4.9)`: manifest + Service Worker do app shell, ignorando `/api/**`.
   Prova: regressão do Agent Helo + refresh offline.

**4.9.2 — Idempotência do servidor (antes da fila, nunca depois)**

7. `fix(4.9)`: `recordReuse` para dentro da transação de criação (G1).
8. `feat(4.9)`: ledger `appliedRequests`, transacional, compartilhado (G2).
9. `feat(4.9)`: `clientRequestId` opcional nas rotas de transição.
10. `test(4.9)`: suíte de idempotência, incluindo a regressão de `REMOVE_RESPONSE`.

**4.9.3 — Fila e conflitos**

11. `feat(4.9)`: fila (ordem, dependências, handles, backoff) — sem interface.
12. `feat(4.9)`: escritas de `realtime-question-client.ts` passam pela fila.
13. `feat(4.9)`: sincronizador.
14. `feat(4.9)`: telas de conflito, uma decisão por vez.
15. `test(4.9)`: jornada integrada offline → online.
16. `docs(4.9)`: seção 4.9 no README.

Cada mensagem segue a convenção do repositório: **o que foi provado**, e não o que
foi escrito. Verificação explícita ao fim de cada uma.

---

## 17. Recomendação: **GO condicional**

**GO** para a arquitetura descrita, com quatro condições inegociáveis:

1. **A ordem é 4.9.1 → 4.9.2 → 4.9.3.** A idempotência do servidor entra **antes**
   da fila de escrita. Ligar uma fila de retentativas sobre um servidor que hoje
   duplica evento de auditoria no replay (G1) e infla `correctionCount` em
   `REMOVE_RESPONSE` (G2/R4) transformaria dois defeitos raros em defeitos de
   rotina — e em dados observacionais errados sobre um paciente.
2. **`lib/confirmed-patient-statement.ts`, as máquinas de estados e
   `lib/option-conversation-screen.ts` não são tocados.** Se a implementação
   precisar deles, o desenho saiu do trilho e a fase deve voltar à mesa.
3. **As 13 suítes e os 6 lotes atuais passam sem alteração nos testes.**
4. **A criptografia local nunca é apresentada como garantia de confidencialidade** —
   nem no README, nem na interface, nem em conversa com terceiros. §8.5 é parte da
   entrega.

**NO-GO permanente**, independentemente de aprovação:

- persistência offline do Firestore via SDK cliente (exigiria abrir
  `firestore.rules` e mover a autorização por paciente para o navegador);
- qualquer caminho que produza `ConfirmedPatientStatement` a partir de dado local;
- resolução automática de qualquer conflito da matriz da §10;
- token, cookie, segredo ou chave de API na fila ou em qualquer armazenamento
  local.

**Se for preciso escolher menos:** a **4.9.1 sozinha já entrega a maior parte do
valor** — o app não morre offline, a sessão sobrevive a um refresh sem rede, e o
cuidador sabe o que está acontecendo. A fila de escrita (4.9.3) é a parte cara e
arriscada. Entregar 4.9.1 e avaliar em uso real antes de decidir sobre a 4.9.3 é
uma opção legítima, e provavelmente a mais prudente.

---

*Auditoria encerrada. Nenhuma implementação foi feita. Aguardando aprovação formal
da arquitetura antes da Execução 2.*

---

# Decisões posteriores à auditoria

Registradas aqui, e não por edição do texto acima, porque o valor de um
documento de auditoria está em ser possível ver **o que se pensou antes** e
**o que a implementação ensinou depois**. Reescrever as seções originais
apagaria a segunda metade.

## Decisão 1 — o cliente cunha o id definitivo; handles não existem

**Substitui a §3.3.** Decidida em 5 de agosto de 2026, durante a Fase 4.9.3-B,
e autorizada explicitamente antes da implementação.

**O que muda.** As quatro rotas de criação (`turns`, `paths`, `nodes`,
`statements`) aceitam um id proposto pelo cliente. Quando ele vem, o servidor
valida formato, prefixo e tipo de recurso; valida que pertence ao
paciente/sessão/usuário autenticado; recusa reuso entre pacientes, sessões ou
usuários; recusa sobrescrever registro existente; e trata colisão real como
conflito explícito — nunca como atualização silenciosa. Quando não vem, o
comportamento anterior é preservado na íntegra: o servidor cunha o id.

**Por que o desenho original caiu.** A §3.3 foi escrita antes da execução 2.
Quando a Fase 4.9.3-B começou, a 4.9.2 já havia entregue — testada, em uso — a
fila que grava `createdEntityId` no momento do gesto do cuidador, e as
referências entre caminho, nível e frase criados sem conexão já apontavam para
esses ids. Introduzir handles naquele ponto significaria: (a) desfazer código
provado, (b) acrescentar uma tabela de correlação e um passo de reescrita da
fila — dois lugares novos onde uma referência clínica pode se perder — para
(c) chegar ao mesmo resultado observável. O ganho seria conceitual; o risco,
real.

**O que NÃO muda, e é o ponto central.** Autoridade continua sendo do servidor.
O cliente propõe a **identidade** do registro; autenticação, autorização,
versão, timestamps, estado da sessão e todas as validações de domínio seguem
exclusivamente no servidor. E a proteção contra duplicação continua sendo o
`clientRequestId` — não o id. Repetir a mesma chave devolve o mesmo resultado
lógico; repetir a mesma chave com payload diferente devolve conflito (409);
resposta perdida depois da persistência nunca gera um segundo registro.

**Provado por:** `scripts/test-offline-idempotency.mjs` (34 asserções, §7
cobre id aceito, retry com o mesmo id, payload divergente, colisão, prefixo
inválido, isolamento entre sessões/pacientes/usuários e referências entre
registros criados sem conexão) e `tests/e2e/offline-sync.spec.ts`.

## Decisão 2 — a linha 3 da matriz é sobre o **nível**, não sobre o turno

**Corrige a §10, linha 3.** Constatada em 6 de agosto de 2026, ao implementar
a matriz.

A linha 3 dizia "400 sobre turno `REPLACED`". **`RtqTurnStatus` não tem
`REPLACED`** — nunca teve. Os dez estados de um turno são `DRAFT`, `REVIEWED`,
`PRESENTED`, `AWAITING_RESPONSE`, `PROVISIONAL_RESPONSE`,
`RECONFIRMATION_PENDING`, `CONFIRMED`, `UNCERTAIN_GESTURE`, `NO_RESPONSE` e
`CANCELED`. Uma pergunta fechada não é substituída: ela é cancelada, ou
reapresentada no mesmo turno.

Quem tem `REPLACED` é o **nível** (`replacedByNodeId`) e a **frase**
(`replacedByStatementId`), pelo mecanismo de correção do §29. E é ali que a
situação descrita pela linha 3 realmente acontece: na conversa por opções, o
nível **é** a pergunta apresentada ao paciente.

O código foi implementado contra o produto, não contra o texto: o caso 3 é
detectado em `applyNodeAction`, o caso 6 em `applyStatementAction`. O nome do
código emitido continua `TURN_REPLACED` para não divergir da numeração da
matriz — mas ele nasce de um nó.

## Decisão 3 — o servidor NOMEIA o conflito; o cliente nunca lê a mensagem

**Acrescenta à §10.** Decidida em 6 de agosto de 2026, na Fase 4.9.3-C.

A matriz exige distinguir treze situações. Até a Fase B, toda recusa 4xx
virava um único `CONFLICT` com a frase *"O servidor recusou esta ação."* — o
que torna impossível oferecer decisão alguma: não dá para dizer *"esta
conversa foi encerrada em outro aparelho às 14:35"* sem saber que foi o caso 1,
nem sem ter o horário.

Três caminhos foram considerados:

| | Caminho | Por que não / por que sim |
| --- | --- | --- |
| a | Cliente classifica lendo a mensagem em português | **Recusado.** Acoplaria decisão clínica à redação de um erro: melhorar uma frase devolveria o produto, em silêncio, ao conflito genérico. Sem erro de compilação, sem teste vermelho — só um cuidador vendo a tela errada |
| b | Cliente relê o estado do servidor e compara | **Recusado.** Uma ida a mais à rede para descobrir o que a resposta que ele já tem em mãos poderia ter dito, e uma janela nova entre a recusa e a releitura |
| c | Servidor devolve um código legível por máquina | **Adotado** |

**Como ficou.** `RtqConflictError` carrega um `code` de vocabulário fechado
(nove valores) e apenas os `facts` que a tela de decisão precisa mostrar — o
documento inteiro nunca vai numa resposta de erro, porque quem foi recusado é,
por definição, quem talvez não devesse mais estar lendo aquele dado (é
literalmente o caso 9). O campo `error` em português segue **idêntico** ao que
sempre foi: nada que já consumia estas rotas precisa saber que o código existe.

**A regra que sobrevive ao desconhecido.** Recusa sem código não vira palpite e
não vira sucesso: vira `DESCONHECIDO`, que **também** para a fila e **também**
pede decisão do cuidador. Errar para o lado de perguntar é barato; errar para o
lado de aplicar sozinho, num prontuário, é irreversível.

**Provado por:** `scripts/test-offline-conflicts.mjs` (as treze linhas,
incluindo a prova de que uma frase que *parece* o caso 1 não é promovida a
caso 1 sem o código) e `scripts/test-conflict-codes.mjs` (contra o servidor de
verdade, provando que os códigos saem de lá e que a mensagem original foi
preservada).

## Decisão 4 — a fronteira entre o caso 4/7 e o caso 11 é o CONTEÚDO

**Detalha a §10, linhas 4, 7 e 11.** Decidida em 6 de agosto de 2026.

Os casos 4 (resposta alterada) e 7 (contexto alterado) dependem de detectar
que o servidor mudou embaixo. O mecanismo é o `baseVersion`: o `updatedAt` que
a entidade tinha quando o cuidador agiu. O campo existia na fila desde a
4.9.2 — **e nunca era enviado a lugar nenhum.** Agora vai no corpo de
`PATCH /turns` e `POST /session-context`.

**O que quase deu errado, e a regra que ficou.** A leitura ingênua seria
"`baseVersion` diferente ⇒ conflito". Ela está errada, e a §10 já dizia por
quê na linha 11: o servidor ter uma versão mais nova **não é conflito por si
só**. O cuidador pode ter reapresentado a pergunta noutro aparelho sem tocar
em resposta alguma; o contexto pode ter sido regravado igual.

Conflito é quando o **conteúdo** diverge:

| | Caso 4 | Caso 7 |
| --- | --- | --- |
| Compara | a resposta que a ação quer registrar × a que o servidor tem | os campos escritos pelo cuidador × os da versão vigente |
| Não é conflito se | o servidor não tem resposta, ou tem a mesma | o conteúdo é igual ao vigente |
| Sem `baseVersion` | segue como sempre | segue como sempre |

Tratar "mais novo" como conflito encheria a tela de decisões vazias — e o
cuidador aprenderia a clicar sem ler, que é pior do que não ter tela.

**Duas saídas, e o que elas fazem de verdade.** Ambas reenviam com
`baseVersion` limpo (senão a mesma recusa voltaria em laço) e chave de
idempotência nova (senão o servidor devolveria o resultado da tentativa
recusada).

- **Caso 4, "aplicar a minha":** `SELECT_RESPONSE` vira **`CHANGE_RESPONSE`**.
  Não é detalhe de implementação — é o que faz o servidor auditar isto como
  *correção* de uma resposta que já existia, e não como se fosse a primeira
  leitura do gesto. Correção declarada é auditável; sobrescrita silenciosa
  não.
- **Caso 7, "gravar como nova versão":** é o comportamento normal do 4.8.
  Gravar contexto sempre cria versão nova e nunca apaga a anterior; o que
  muda é qual passa a ser a vigente. Não há nada a conceder aqui.

**Provado por:** `scripts/test-conflict-codes.mjs` (os dois códigos saindo do
servidor real, **e** as duas asserções de fronteira: mesmo conteúdo com
`baseVersion` velho NÃO vira conflito), `scripts/test-offline-decisions.mjs`
(a troca para `CHANGE_RESPONSE`, `baseVersion` limpo, chave nova) e
`tests/e2e/offline-conflitos.spec.ts` (a tela mostrando as duas respostas,
com nenhuma aplicada sozinha).
