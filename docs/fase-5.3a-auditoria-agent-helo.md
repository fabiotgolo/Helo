# Fase 5.3A — auditoria do Agent Helo e inventário dos comandos existentes

Esta fase não implementou nada. Ela responde a uma pergunta que até aqui só
tinha resposta na memória de quem escreveu o código: **o que o Agent Helo já
consegue fazer, o que a ElevenLabs já sabe sobre a tela, e o que o Agent tem
autoridade para executar.** As três coisas são diferentes, e o documento as
mantém separadas do começo ao fim.

Base auditada: `HEAD c01eea3`, árvore limpa, tags `ponto-seguranca-fase-5.2` e
`ponto-seguranca-fase-5.2c` no HEAD.

---

## 1. Resumo executivo

O Agent Helo existe, está integrado e opera a plataforma por voz hoje. A
arquitetura é sólida no ponto que mais importa: **a autoridade do Agent é
decidida pela CLASSE da ação, não pelo texto do pedido** — e isso continua de
pé sob todas as formas de pedido que um LLM produz.

Cinco conclusões, cada uma com a evidência no corpo do documento:

1. **O gate do R-02 não tem furo alcançável.** Existem exatamente dois pontos
   no código que executam um handler de tela a pedido do Agent, e os dois
   consultam `isActionAllowedFor` — incluindo a delegação escondida na
   navegação para Atividades. Ação sem classe é recusada (fail-closed).
   `test:agent:gate` 52 ✓, `test:agent:invariants` 21 ✓,
   `test:agent:inventory` 19 ✓.
2. **`patientResponse` é inalcançável, e `sensitive` também.** Das 41 ações
   registradas, o Agent executa 19. As outras 22 ele VÊ, com o motivo da
   recusa — inclusive `dialog.confirm`, o que responde a pergunta do §8: o
   Agent não pode confirmar a própria confirmação.
3. **R-09 continua aberto e é mais grave do que a 5.0 registrou.** Medido em
   tela real: numa conversa por opções, `getCurrentHeloActions` enviaria à
   ElevenLabs as opções escritas pelo cuidador e a pergunta da sessão — **25
   rótulos de texto visível, e ZERO ações executáveis nessa tela**. Ver §12.
4. **A maior tela do produto é invisível ao Agent.** Todo o subsistema de
   perguntas em tempo real e conversa por opções (Fase 4.9) não registra uma
   única ação. Ele é, ao mesmo tempo, a tela de maior exposição de contexto e a
   de menor capacidade. Ver §6.
5. **R-08 e R-12 continuam abertos, exatamente como descritos na 5.0.** O
   transcript do provedor não distingue autores, e o override de voz do Agent
   é caminho morto — agora ainda mais morto, porque a chamada que o desabilita
   virou literal dentro de `agent-session-lifecycle.ts`.

Nenhum achado exigiu interromper a auditoria para corrigir. O achado do §12
encosta na fronteira do §1 do prompt ("vazamento claro de conteúdo clínico
desnecessário ao provider") e por isso está reportado **antes de qualquer
correção**, sem correção aplicada.

---

## 2. Arquitetura atual

```
cuidador
  │ fala no microfone (ou digita em "Mensagem para a Helo")
  ▼
@elevenlabs/react  useConversation  ── WebRTC ──▶  Agent na ElevenLabs
  ▲                                                      │
  │                                    interpreta a intenção com o
  │                                    system prompt + tool definitions
  │                                    que vivem NO PAINEL (§3)
  │                                                      │
  │                                          chama uma client tool
  │                                                      ▼
  └──── resultado (JSON string) ◀── clientTools do helo-agent-provider
                                                         │
                            ┌────────────────────────────┤
                            ▼                            ▼
                 rota global (tabela fechada)   Action Registry
                 router.push(path)              resolveRequestedUIAction
                            │                            │
                            │                    ┌───────▼────────┐
                            │                    │ GATE DE ORIGEM │  ◀── a decisão
                            │                    │ actionClass    │
                            │                    └───────┬────────┘
                            │                            │ navigation|operational
                            │                            ▼
                            │                 POST /api/helo/client-tools
                            │                 (sessão + acesso ao paciente)
                            │                            ▼
                            └────────────────────▶ action.run() — o MESMO
                                                   handler do clique manual
```

Os dez pontos do §3 do prompt:

| # | Pergunta | Resposta | Evidência |
|---|---|---|---|
| 1 | quem abre a sessão | `connect()`, disparado pelo botão "Conectar com Helo" ou pela ação `helo.conectar` | `helo-agent-provider.tsx:1689` |
| 2 | quem solicita o token | o próprio cliente, para `POST /api/helo/conversation-token`; o servidor fala com a ElevenLabs | `helo-agent-provider.tsx:1733` |
| 3 | quem inicia o WebRTC | `openAgentSession` → `startConversation` → `startSession` do SDK, `connectionType: "webrtc"` | `lib/voice/agent-session-lifecycle.ts:147` |
| 4 | quem registra as client tools | o objeto `clientTools` passado a `useConversation` | `helo-agent-provider.tsx:905,1191` |
| 5 | quem fornece as ações disponíveis | `listHeloUIActions("agent")`, lido do Action Registry vivo | `lib/helo-action-registry.ts:136` |
| 6 | quem executa | `action.run({...payload, __source: "agent"})`, o mesmo handler do clique | `helo-agent-provider.tsx:1040` |
| 7 | como o resultado volta | string JSON devolvida pela client tool (`toolResult`) | `helo-agent-provider.tsx:1044` |
| 8 | como sobrevive à navegação | o provider está no layout RAIZ; a sessão só morre ao sair de `/helo` quando a persistência está desligada | `app/layout.tsx:57`; `helo-agent-provider.tsx:1492` |
| 9 | como termina | `end()` → `sdkSession.release()`; também em `beforeunload`, desmonte, erro e queda | `helo-agent-provider.tsx:1336,1514` |
| 10 | troca de paciente | encerra a sessão e avisa o cuidador | `helo-agent-provider.tsx:1503` |

---

## 3. Fronteira: repositório × ElevenLabs externa

**Versionado aqui** (auditável):

| Item | Onde |
|---|---|
| id do Agent | `ELEVENLABS_HELO_AGENT_ID` (env) |
| implementação das client tools | `helo-agent-provider.tsx:905-1171` |
| dynamic variables enviadas | `conversation-token/route.ts:27-56` |
| override de voz (caminho morto) | `conversation-token/route.ts:63-78` |
| Action Registry, classes e gate | `lib/helo-action-registry.ts` |
| autorização por tool | `app/api/helo/client-tools/route.ts` |
| ciclo de vida do WebRTC | `lib/voice/agent-session-lifecycle.ts` |

**CONFIGURAÇÃO EXTERNA NÃO VERIFICADA NESTA AUDITORIA** — nada disto existe no
repositório, nem em forma de arquivo, nem de schema, nem de export:

- system prompt do Agent;
- definição das tools (nomes, `description`, parâmetros, schemas);
- regras de tool calling e de quando chamar cada uma;
- Knowledge Base;
- modelo de LLM, modelo de TTS/STT;
- voz oficial do Agent;
- idioma configurado;
- First Message;
- comportamento conversacional (turn-taking, interrupções, `skip_turn`).

Para completar essa metade seria preciso obter, do painel ou da API
`/v1/convai/agents/{id}`: o objeto de configuração do Agent, a lista de tools
com suas `description` e schemas, e a Knowledge Base. **Não inferimos nada
disso.** Três pistas de que o painel diverge do código estão registradas no
próprio código e valem como sintoma:

- o provider registra `getCurrentHeloActions` **e** `getVisibleHeloActions`
  para o mesmo handler, e `interactWithHeloUI` / `interactWithVisibleHeloUI` /
  `executeHeloAction` também — porque o painel usa outros nomes
  (`helo-agent-provider.tsx:1162-1170`);
- `interactWithUI` aceita o id em sete nomes de parâmetro diferentes
  (`actionId`, `action`, `id`, `name`, `label`, `target`, `command`) — porque a
  declaração da tool no painel não é conhecida (`:965-972`);
- existe um `generate_music` mantido como "alias temporário para sessões que
  ainda usam o nome anterior no painel" (`:1146`).

Essa tolerância é uma dívida de acoplamento: o código compensa não saber o
contrato. Item da 5.3B.

---

## 4. Inventário completo das actions

41 ações registradas, reconstruídas do código atual (não da lista da 5.1A).
Nenhuma delas é registrada por `querySelector` ou clique simulado: toda ação
carrega o mesmo handler do toque manual.

Legenda das colunas: **A** = o Agent executa · **H** = humano executa pela UI ·
**rota** = muda de rota · **mem** = altera estado só em memória · **persist** =
escreve no servidor · **TTS** = pode disparar áudio · **voz-pac** = pode
resultar em fala na voz do paciente · **conf** = exige confirmação humana.

### `/helo` — `helo-agent-provider.tsx:1867`

| actionId | classe | A | H | rota | mem | persist | TTS | voz-pac | conf |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `helo.conectar` | operational | ✅ | ✅ | | ✅ | ✅ (log) | | | |
| `helo.solicitarMicrofone` | operational | ✅ | ✅ | | | | | | |
| `helo.encerrar` | sensitive | ❌ | ✅ | | ✅ | ✅ (log) | | | |
| `gesto.confirmar` | patientResponse | ❌ | ✅ | | ✅ | ✅ | | | |
| `gesto.reformular` | patientResponse | ❌ | ✅ | | ✅ | ✅ | | | |
| `gesto.recusar` | patientResponse | ❌ | ✅ | | ✅ | ✅ | | | |

Pré-condições: as três de gesto só existem com a conversa conectada;
`helo.conectar` só quando desconectado.

### `/rotina` — `app/(palco)/rotina/page.tsx:255`

| actionId | classe | A | H | efeito |
|---|---|:-:|:-:|---|
| `routine.open.*` (15 cards) | operational | ✅ | ✅ | abre o card; **não fala nada** |
| `routine.answer.*.*` (3 por card) | patientResponse | ❌ | ✅ | registra a resposta e **faz a voz do paciente soar** |
| `routine.backToMenu` | navigation | ✅ | ✅ | volta ao menu, interrompe a fala |

### `/emergencia` — `app/(palco)/emergencia/page.tsx:222`

| actionId | classe | A | H | efeito |
|---|---|:-:|:-:|---|
| `emergencia.item.*` (5) | sensitive | ❌ | ✅ | registro silencioso + **voz do paciente com prioridade máxima** |
| `emergencia.editar.*` | sensitive | ❌ | ✅ | navega para edição; exige `editEmergency` |

### `/conversa` (conversa guiada) — `app/(palco)/conversa/page.tsx:613`

| actionId | classe | A | H | efeito |
|---|---|:-:|:-:|---|
| `conversa.comecar` | operational | ✅ | ✅ | inicia a sessão |
| `conversa.repetir` | operational | ✅ | ✅ | repete a pergunta da Helo |
| `conversa.repetirMensagemPaciente` | patientResponse | ❌ | ✅ | **repete na voz do paciente** |
| `conversa.continuar` | operational | ✅ | ✅ | volta ao nó inicial |
| `conversa.pausar` / `conversa.retomar` | operational | ✅ | ✅ | pausa/retoma |
| `conversa.voltar` | navigation | ✅ | ✅ | volta um passo |
| `conversa.encerrar` | sensitive | ❌ | ✅ | encerra e vai para Home |
| `conversa.gestoIncerto` | patientResponse | ❌ | ✅ | registra observação sobre a resposta |
| `conversa.opcao.*` | patientResponse | ❌ | ✅ | escolhe a opção → frase na voz do paciente |
| `gesto.confirmar` / `.reformular` / `.recusar` | patientResponse | ❌ | ✅ | idem `/helo` |

### `/atividades` — `app/(palco)/atividades/page.tsx:155`

| actionId | classe | A | H | permissão |
|---|---|:-:|:-:|---|
| `atividades.iniciar.*` | operational | ✅ | ✅ | `runActivities` |
| `atividades.criar` | sensitive | ❌ | ✅ | `createActivities` |
| `atividades.editar.*` | sensitive | ❌ | ✅ | `editActivities` |
| `atividades.gerenciar` | sensitive | ❌ | ✅ | — |
| `atividades.voltarLista` | navigation | ✅ | ✅ | — |
| `atividades.frases.abrir` | operational | ✅ | ✅ | — |
| `atividades.frases.fechar` | navigation | ✅ | ✅ | — |

### Player de atividade — `components/activity-player.tsx:666`

| actionId | classe | A | H | efeito |
|---|---|:-:|:-:|---|
| `activity.goToActivityMenu` | navigation | ✅ | ✅ | passa pelo modal de conclusão |
| `activity.goToManageActivities` | sensitive | ❌ | ✅ | idem, para o gerenciamento |
| `atividades.anterior` / `.proxima` | operational | ✅ | ✅ | navega itens |
| `atividades.concluir` | sensitive | ❌ | ✅ | conclui a sessão |
| `atividades.encerrar` | sensitive | ❌ | ✅ | fecha a atividade |
| `atividades.resposta.*.*` | patientResponse | ❌ | ✅ | resposta do paciente; pode falar na voz dele |
| `atividades.resposta.pergunta` | patientResponse | ❌ | ✅ | idem, pergunta sem opções |

### Modal de frases — `components/phrases-to-listen-modal.tsx:120`

| actionId | classe | A | H | efeito |
|---|---|:-:|:-:|---|
| `atividades.frases.ouvir` | patientResponse | ❌ | ✅ | **toca a frase na voz do paciente** |
| `atividades.frases.anterior` / `.proxima` | navigation | ✅ | ✅ | troca de frase |

### Modal de confirmação — `components/helo-dialog.tsx:191`

| actionId | classe | A | H | efeito |
|---|---|:-:|:-:|---|
| `dialog.confirm` | sensitive | ❌ | ✅ | resolve a confirmação com `true` |
| `dialog.cancel` | sensitive | ❌ | ✅ | resolve com `false` |

### Rotas globais — não são ações do registry

Nove entradas em `GLOBAL_HELO_ROUTES` (`helo-agent-provider.tsx:116`). Não têm
`actionClass` porque não há ação a classificar: cada uma é um `path` literal de
uma tabela fechada, e o dispatcher as atende **antes** do registry — o único
caminho do Agent que não passa pelo gate de classe. Isso é seguro por
construção (nenhuma carrega handler), e `test:agent:inventory` passou a
verificar exatamente essa propriedade, para que continue verdade.

Alvos: `/`, `/helo`, `/conversa`, `/rotina`, `/emergencia`, `/atividades`,
`/mensagem`, `/ajustes`, `/dashboard`.

---

## 5. Classificação

| Classe | Quantidade | O Agent executa? |
|---|---:|---|
| `navigation` | 7 | ✅ |
| `operational` | 12 | ✅ |
| `sensitive` | 12 | ❌ — pode chegar até a fronteira |
| `patientResponse` | 10 | ❌ — nunca |
| **total** | **41** | **19 executáveis** |

Auditadas todas contra as quatro perguntas do §6 do prompt. Resultado:

- **ação sem `actionClass`:** nenhuma. `test:agent:invariants` verifica ação por
  ação; `test:agent:inventory` passou a verificar que **nenhum arquivo novo**
  registra ações fora do alcance dessa verificação — era um buraco real, porque
  a lista de arquivos ali é fixa.
- **classe desconhecida:** nenhuma. Toda `actionClass` declarada é um literal
  das quatro; nenhuma é calculada (verificado no fonte, não por convenção).
- **classificação aparentemente errada:** nenhuma no sentido de perigosa. Duas
  são conservadoras demais e limitam o produto, não a segurança — §5.1.
- **handler mais poderoso que a classe sugere:** nenhum encontrado. O caso mais
  próximo é `navigateToArea("atividades")`, que parece navegação e na verdade
  **executa um handler de tela** — e por isso consulta o gate antes
  (`:890`). Está correto; é o tipo de caminho que costuma escapar.

### 5.1 Ambiguidades registradas (nenhuma é falha de segurança)

| Item | O que é | Por que incomoda |
|---|---|---|
| `activity.goToManageActivities` | `sensitive`, mas o handler só faz `router.push` | O comentário logo acima diz "o Agente também executa" — e ele não executa. Comentário obsoleto sobre a própria classe. |
| `atividades.gerenciar` | `sensitive`, mesmo caso | Navegar para a tela de gerenciamento não muda dado. Fail-closed, mas custa uma capacidade. |
| `toolSuccess` em ações bloqueadas | `emergencia.item.*`, `routine.answer.*.*`, `atividades.resposta.*.*`, `conversa.repetirMensagemPaciente`, `atividades.frases.ouvir` declaram `toolSuccess` | `toolSuccess` só é lido no caminho do Agent, que nunca alcança essas ações. É **código morto** — e, pior, código morto que documenta um comportamento ("acionar por tool executa o MESMO handler do clique") que **não acontece mais** desde a 5.1A. |

Esse último item merece o destaque: o comentário em
`app/(palco)/emergencia/page.tsx:232` afirma que o Agent pode acionar a
emergência. Ele não pode. Quem ler o código para saber o que o Agent faz é
induzido ao erro **na direção mais perigosa possível** — acreditar que o
sistema é mais permissivo do que é leva a proteger de novo o que já está
protegido, e a não proteger o que não está.

---

## 6. Mapa de telas

Medido em execução real (servidor descartável, banco descartável, sem provedor;
os números vêm de `getCurrentHeloActions` lido na própria página):

| Tela / rota | Ações registradas | Executáveis pelo Agent | Rótulos enviados ao provedor | Agent alcança a tela? | Lacuna |
|---|---:|---:|---:|---|---|
| Menu `/` | 0 | 0 | 17 | ✅ rota global | menu sem ações; só navegação |
| `/helo` | 3 | 2 | 16 | ✅ | — |
| `/rotina` (menu) | 15 | 15 | 30 | ✅ | — |
| `/rotina` (card aberto) | 4 | 1 | 19 | ✅ | correta: as 3 respostas são do paciente |
| `/emergencia` | 5 | **0** | 20 | ✅ navega, não aciona | por decisão |
| `/atividades` | 0¹ | 0 | 15 | ✅ | ¹ zero por PERMISSÃO do usuário semeado, não por falta de registro |
| `/conversa` (intro) | 1 | 1 | 18 | ✅ | — |
| `/conversa/perguntas` | **0** | **0** | **34** | ✅ navega, não faz nada | **a lacuna principal** |
| conversa por opções | **0** | **0** | **25** | ✅ navega, não faz nada | **idem, com conteúdo clínico** |
| `/mensagem` | 0 | 0 | — | ✅ rota global | sem ações |
| `/ajustes` | 0 | 0 | — | ✅ + `openPatientSettings(section)` | sem ações internas |
| `/dashboard` | 0 | 0 | — | ✅ rota global | sem ações |
| `/atividades/gerenciar` | 0 | 0 | — | ❌ sem rota global | inalcançável por voz |
| `/admin`, `/feedback`, `/login` | 0 | 0 | — | ❌ | fora do escopo do Agent |

**Voltar funciona?** Sim, e por caminhos declarados: `routine.backToMenu`,
`conversa.voltar`, `atividades.voltarLista`, `activity.goToActivityMenu`,
`atividades.frases.fechar`. Não há dependência de histórico do navegador.

**Ação órfã?** Nenhuma: toda ação anunciada existe no registry da tela montada,
e `test:agent:invariants` verifica que todo `actionId` anunciado corresponde a
uma ação classificada.

### A lacuna principal

O subsistema de **perguntas em tempo real e conversa por opções** — a Fase 4.9,
o maior conjunto de telas do produto — não chama `useRegisterHeloUIActions` em
lugar nenhum. Verificado por varredura: os oito arquivos que registram ações
são os listados no §4, e nenhum deles pertence a `components/realtime-questions/`.

Consequência dupla, e as duas metades importam:

- o Agent **não consegue fazer nada** ali: nem apresentar um nível, nem
  registrar interpretação, nem navegar entre degraus;
- e mesmo assim aquela tela é a que **mais texto envia ao provedor**.

---

## 7. Client tools

Oito nomes registrados, para seis handlers (dois pares de alias, mais um
terceiro nome para o dispatcher):

| Tool | O que faz | Parâmetros aceitos | Validação |
|---|---|---|---|
| `navigateHeloArea` | navega para uma área | `targetArea`/`area`/`target`/`name` | resolução tolerante contra tabela fechada; nada casa → erro |
| `openPatientSettings` | abre uma seção de Ajustes | `section` | tem de ser uma das 5 seções |
| `openRoutineMode` / `openEmergencyMode` / `openActivitiesMode` | atalhos de área | — | — |
| `showGestureChoices` | destaca a barra de gestos por 8 s | — | **não aciona gesto nenhum** |
| `getCurrentHeloActions` / `getVisibleHeloActions` | descoberta | — | leitura pura |
| `interactWithHeloUI` / `interactWithVisibleHeloUI` / `executeHeloAction` | execução | `actionId` (7 nomes), `payload` | resolve no registry → **gate** → autoriza no servidor |
| `checkUserSilence` | controla lembretes de silêncio | — | máx. 3, com espera crescente |
| `generate_and_play_music` / `generate_music` / `play_existing_music` | música | prompt, gênero, duração / data, período | fora do escopo desta fase (R-04/R-07 seguem na 5.4) |

**Parâmetros amplos que poderiam virar executor genérico** — procurados
explicitamente, conforme o §12 do prompt:

| Risco | Existe? | Por quê |
|---|---|---|
| `selector` / XPath / coordenada | ❌ | nenhuma tool aceita seletor de DOM |
| `href` / URL livre | ❌ | rotas vêm de `HELO_AREA_ROUTES` e `GLOBAL_HELO_ROUTES`, tabelas fechadas |
| `patientId` vindo do Agent | ❌ | o cliente envia o paciente ATIVO; o servidor exige vínculo (`requirePatientAccess`) |
| `permission` vindo do Agent | ⚠️ aceito, mas **só aperta** | a rota valida que é uma permissão conhecida e a usa para exigir MAIS; nenhuma escrita real depende dela |
| `actionId` arbitrário | ✅ aceito, e é o ponto | é justamente por isso que o gate decide pela classe da ação encontrada, não pelo texto pedido |
| JSON livre em `payload` | ✅ aceito | vai para `action.run(payload)`; as ações que leem payload (`conversa.opcao.*`, `atividades.resposta.*`) são todas `patientResponse` e inalcançáveis |

O endpoint `POST /api/helo/client-tools` (`route.ts:27`) **não altera dado
nenhum**: valida sessão, ação (tabela fechada de 7), área, seção e permissão, e
devolve `{ok:true}`. É autorização, não execução. Depois da ida ao servidor o
cliente reconfere que o paciente ativo não mudou (`:867`) — uma verificação
que a maioria dos códigos esquece.

---

## 8. Ciclo de vida do Action Registry

```
tela monta → useMemo(actions) → useEffect: groups.set(symbol, actions)
           → o Agent enxerga
tela desmonta → cleanup: groups.delete(symbol)
```

Chave por `Symbol` **por instância de componente** (`lib/helo-action-registry.ts:408`),
não por id de tela. Consequências auditadas:

| Risco do §13 | Situação |
|---|---|
| ação duplicada | Possível entre grupos (ex.: `gesto.confirmar` existe em `/helo` e em `/conversa`), mas nunca simultânea: são telas diferentes |
| ID duplicado com classes diferentes | **Impossível hoje** — verificado ação por ação por `test:agent:invariants`, que existe por causa de um defeito real desse tipo |
| registro antigo sobrevivendo | Não: o desmonte apaga o grupo |
| `unregister` ausente | Não: o cleanup do efeito é o unregister |
| closure com estado antigo | O array é memoizado com as dependências reais da tela; um `useMemo` com dependência faltando é o risco residual, não verificado automaticamente |
| troca de rota | O grupo some com o desmonte |
| troca de paciente | A sessão do Agent é encerrada (§10) |
| handler async atrasado | **Sem invalidação** — ver §11 |

Uma lacuna real: **não existe token de geração/contexto**. Uma chamada de tool
não carrega nada que a amarre à rota em que a descoberta aconteceu. Hoje isso
não produz execução indevida porque o registry esvazia no desmonte — a ação
simplesmente deixa de ser encontrada. Mas a proteção é *incidental*, não
declarada. Item da 5.3C.

---

## 9. `patientResponse` — a fronteira absoluta

Reauditada no código atual, não confiando na 5.1A.

**A prova estrutural:** `isActionAllowedFor` (`lib/helo-action-registry.ts:110`)
retorna `false` para `origin === "agent"` quando a classe é `patientResponse`
**ou quando não há classe**. É a única função que decide, e ela não olha texto.

**Cobertura do mapeamento pedido:**

| Superfície | Ação | Classe | Alcançável pelo Agent |
|---|---|---|---|
| SIM / TALVEZ / NÃO na Rotina | `routine.answer.*.*` | patientResponse | ❌ |
| SIM / TALVEZ / NÃO em `/helo` | `gesto.*` | patientResponse | ❌ |
| SIM / TALVEZ / NÃO na conversa guiada | `gesto.*` | patientResponse | ❌ |
| Resposta de atividade | `atividades.resposta.*.*` | patientResponse | ❌ |
| Resposta sem opções | `atividades.resposta.pergunta` | patientResponse | ❌ |
| Confirmação de mensagem | `gesto.confirmar` (fase `confirm`) | patientResponse | ❌ |
| Frase do paciente (repetir) | `conversa.repetirMensagemPaciente` | patientResponse | ❌ |
| Frase do paciente (ouvir) | `atividades.frases.ouvir` | patientResponse | ❌ |
| Escolha em conversa por opções | `conversa.opcao.*` | patientResponse | ❌ |
| Gesto incerto | `conversa.gestoIncerto` | patientResponse | ❌ |
| Emergência (fala do paciente) | `emergencia.item.*` | sensitive | ❌ |

**Caminhos laterais procurados, um a um:**

| Caminho lateral | Existe? | Evidência |
|---|---|---|
| ação operacional que chama `patientResponse` por dentro | ❌ | `navigateToArea("atividades")` delega para `activity.goToActivityMenu` e **reconsulta o gate** (`:890`); é a única delegação |
| clique genérico no DOM | ❌ | nenhuma tool aceita seletor; `localElements` é só leitura e não resolve para execução |
| `dialog.confirm` genérico | ❌ | classificado `sensitive`; o Agent não confirma nada, nem por alias "sim" |
| handler chamado sem passar pelo gate | ❌ | só há dois `.run({` no provider, e ambos após o gate — verificado por `test:agent:inventory` |
| alias de ação | ❌ | alias resolve QUAL ação; a classe é da ação, não do alias — 52 casos em `test:agent:gate` |
| ação antiga fora do registry | ❌ | `resolveRequestedUIAction` só olha `groups`, preenchido por telas montadas |
| navegação seguida de execução automática | ❌ | `router.push` não dispara handler; a única exceção é a delegação acima, com gate |
| gesto solto dentro do payload | ❌ | `resolveRequestedUIActionIn` reconstrói candidatos a partir de emoji, sinônimo e campo livre — **de propósito**, para que o pedido chegue à ação certa e seja recusado com o motivo certo |

Nenhum teste foi feito clicando SIM/TALVEZ/NÃO com Agent real, conforme o §7.

---

## 10. Ações sensíveis

12 ações. Para todas, a resposta às perguntas do §8 é a mesma:

| Pergunta | Resposta |
|---|---|
| o Agent executa diretamente? | **não** — o gate recusa antes de `action.run` |
| abre a confirmação? | não; o Agent nem chega ao handler |
| apenas prepara a ação? | ele **navega até a tela** onde a ação está e explica ao cuidador |
| quem confirma? | a pessoa, tocando na tela |
| o Agent pode confirmar a própria confirmação? | **não** — `dialog.confirm` é `sensitive` |
| `dialog.confirm` pode ser chamado pelo Agent? | **não** |
| existe confirmação por voz? | **não existe** |
| existe confirmação automática? | **não** |

O motivo devolvido ao Agent é honesto e não o convida a insistir:
`"…precisa de confirmação de uma pessoa na tela. Posso abrir o caminho, mas não
posso concluir."` (`lib/helo-action-registry.ts:125`).

Uma nota de produto, não de segurança: a Emergência é `sensitive`, então o
Agent **não** aciona uma frase de socorro. O comentário no fonte diz o
contrário (§5.1). A política em si não foi alterada nesta fase.

---

## 11. Ação assíncrona atrasada e troca de rota

| Cenário | Comportamento atual | Risco |
|---|---|---|
| Agent pede ação → cuidador troca de rota → o modelo pede a ação de novo | a ação não está mais no registry: "Ação não encontrada na tela atual." | nenhum |
| Agent pede ação → `authorizeTool` vai ao servidor → **paciente muda** durante o round-trip | recusado: `patientIdRef.current === activePatientId` é reconferido depois da resposta (`:867`) | **coberto** |
| Agent pede ação → `authorizeTool` vai ao servidor → **rota muda** durante o round-trip | **não há verificação equivalente**: o handler já resolvido é executado | ⚠️ o handler pertence a uma tela que o cuidador deixou; se for de navegação, ele é levado de volta |
| `action.run()` async resolve depois do desmonte | `setState` em componente desmontado é no-op no React 19; efeitos de rede já disparados seguem | ⚠️ sem abort |
| resultado da ação volta ao Agent depois da mudança | volta, sem qualquer marcação de que o contexto mudou | ⚠️ |

Nenhum desses caminhos permite agir **pelo paciente** — todos passam pelo gate.
São inconsistências de contexto, não de autoridade. Item da 5.3C.

---

## 12. Contexto enviado ao provedor, e R-09

### O shape real do payload

`getCurrentHeloActions` devolve exatamente isto
(`helo-agent-provider.tsx:945-958`):

```jsonc
{
  "ok": true,
  "currentPath": "/conversa/perguntas",
  "screen": "conversar",
  "patientId": 1754...,             // id interno do paciente
  // ...screenContext.extra — hoje duas telas publicam:
  //   Rotina  → { "currentQuestion": "<a pergunta do card aberto>" }
  //   Player  → { "currentQuestion": "<a pergunta da atividade>",
  //               "currentOptions": [ { "option": "<rótulo escrito pelo cuidador>",
  //                                     "commands": [ ... ] } ] }
  "globalRoutes": [ { "actionId": "navigate-home", "label": "Ir para Home", "path": "/" }, ... ],
  "localElements": [                // TODO button/a da tela, pelo textContent
    { "actionId": "<id do elemento ou o próprio texto>", "label": "<textContent>", "path": "<se for link>" }
  ],
  "availableActions": [ ...globalRoutes, ...localElements ],   // duplicata
  "actions": [
    { "actionId": "debug.ping", ... },
    ...globalRoutes,
    ...uiActions                    // do registry, com agentExecutable e o motivo
  ]
}
```

### A medição

Numa conversa por opções com conteúdo real, criada por um cuidador, os
`localElements` que sairiam para a ElevenLabs incluem — literalmente, como
medido:

```
"👍Dor no peitoPositivo"
"✋Enjoo e tonturaPalma aberta"
"✊Falta de ar à noiteMão fechada"
"1.Onde está doendo agora?03:23◔ Em andamentoConversa por opções1 nívelRetomar este item"
```

São as opções que o paciente vai ler, a pergunta que o cuidador escreveu e o
estado da sessão clínica. Nessa tela o Agent tem **zero** ações executáveis.

### Classificação dado a dado (§15)

| Dado enviado | Classificação | Justificativa |
|---|---|---|
| `actionId` do registry | **necessário** | é o que a execução usa |
| `actionClass`, `agentExecutable`, `agentBlockedReason` | **necessário** | o Agent precisa saber o que pode e por que não |
| `label` da ação do registry | **útil** | ajuda o modelo a casar linguagem natural com a ação |
| `aliases` | **útil** | mesma função, explicitamente curados |
| `currentPath`, `screen` | **necessário** | orienta a navegação |
| `globalRoutes` | **necessário** | é o menu de destinos |
| `patientId` (id numérico interno) | **útil, não necessário** | o servidor já sabe o paciente ativo; o Agent não usa o id para nada |
| `screenContext.extra.currentQuestion` | **potencialmente sensível** | é a pergunta clínica (Rotina ou atividade), em texto |
| `screenContext.extra.currentOptions` | **útil, e sensível** | rótulos escritos pelo cuidador; aqui, diferente de `localElements`, o texto **serve** para o Agent casar o pedido com a ação — e as ações correspondentes são todas `patientResponse`, que ele não pode executar |
| `localElements` | **desnecessário e potencialmente sensível** | texto visível de toda a tela; não resolve execução nenhuma |
| `availableActions` | **desnecessário** | duplicata literal de `globalRoutes + localElements` |

`localElements` não serve para executar: o dispatcher resolve o pedido **no
registry**, e um rótulo local sem ação correspondente devolve "Ação não
encontrada". Ele existe como ajuda de contexto ao modelo — e paga por isso com
o texto clínico da tela.

### Proposta de minimização para a 5.3B

1. remover `availableActions` (duplicata pura, custo zero);
2. remover `localElements`, ou reduzi-lo a elementos com `id` declarado pela
   aplicação — nunca `textContent`;
3. substituir `patientId` por um marcador opaco de sessão, ou omitir;
4. tratar `screenContext.extra` como campo governado: cada chave nova precisa
   passar por revisão (o tripwire de `test:agent:inventory` já força isso);
5. manter `actions` como está — é o contexto que de fato sustenta a capacidade.

---

## 13. Dados identificáveis

| Dado | Chega à ElevenLabs? | Por onde |
|---|---|---|
| `patientName`, `preferredName` | **sim** | dynamic variables (`conversation-token/route.ts:38-45`) |
| saudação personalizada | **sim** | `heloPatientGreeting` |
| rótulos dos gestos configurados | sim | dynamic variables |
| estilo de comunicação | sim | dynamic variable |
| `activePatientId` (id interno) | **sim** | dynamic variable + payload de descoberta |
| papel do operador | sim | `currentOperatorRole` |
| nome do cuidador, e-mail | **não** | — |
| diagnóstico, prontuário, documentos | **não** | nunca lidos |
| histórico de sessões | **não** | — |
| respostas anteriores do paciente | **não** | — |
| **textos clínicos da tela atual** | **sim** | `localElements` — §12 |
| mensagens confirmadas | **não** diretamente | mas o texto pode aparecer como rótulo de botão |
| URLs internas | sim (caminhos, sem query) | `currentPath`, `globalRoutes` |

A distinção que o §16 pede está preservada em um sentido e violada em outro: o
Agent recebe legitimamente o que o **cuidador diz ou escreve para ele** — essa é
a conversa. Mas ele também recebe **a tela inteira**, que ninguém escolheu
enviar. É a mesma fronteira do §12, vista pelo lado do dado.

---

## 14. Transcript e roles — R-08

O Helo não define roles: ele **injeta turnos** na role `user` do SDK. Nada do
transcript é persistido — verificado por varredura: não há gravação de
transcript em nenhum store, log ou coleção.

| Origem real | Role na ElevenLabs | Role no Helo | Persiste? | Pode executar action? | Pode ser fala do paciente? |
|---|---|---|---|---|---|
| voz do cuidador no microfone | `user` | — (não nomeia) | ❌ | sim, via interpretação do modelo | ❌ |
| gesto tocado na tela (`markGesture`) | `user` | `sendUserMessage(GESTURE_SEMANTIC_MESSAGES)` | ❌ (o EVENTO é logado, o turno não) | sim | ❌ é um **relato** do gesto |
| "Mensagem para a Helo" (digitada) | `user` | prefixada com "Mensagem escrita pelo acompanhante:" | ❌ (a observação vai ao dashboard) | sim | ❌ |
| pergunta de atividade a ser lida | `user` | "Leia agora para o paciente…" | ❌ | sim | ❌ (a Helo lê, na voz dela) |
| observação contextual do cuidador | `contextual_update` | "Observação do acompanhante em tempo real:" | ❌ | não cria turno | ❌ |
| fala da Helo | `ai` | — | ❌ | — | ❌ |
| **transcrição do ditado (5.2)** | **nunca chega** | — | — | — | — |

**R-08 confirmado, ainda aberto.** Quatro origens humanas diferentes — voz,
gesto, texto digitado, instrução de leitura — chegam ao provedor com a mesma
role `user`. A separação hoje é feita por **prefixo em linguagem natural**, que
é convenção, não estrutura. O comentário em `:1224` chega a chamar a role `user`
de "patient speech" (`reminder state reset by patient speech`), o que é
factualmente errado: quem fala ao microfone da sessão Helo é o cuidador.

Nenhum caminho permite que essa confusão vire fala ou consentimento do paciente
— isso é barrado pelo gate, não pela role. Mas a nomenclatura é uma armadilha
para quem for mexer aqui depois. MÉDIO.

---

## 15. Agent × STT (5.2)

Separação verificada, canal por canal:

| Verificação | Resultado | Evidência |
|---|---|---|
| transcrição do ditado entra no Agent? | **não** | `use-dictation.ts` escreve por `onChange` do campo; nenhuma referência a `sendUserMessage`/`sendContextualUpdate` |
| transcript do Agent vira `VOICE_TRANSCRIPTION`? | **não** | `VOICE_TRANSCRIPTION` só é produzido pelo caminho do ditado |
| posse do microfone impede captura simultânea | **sim, nos dois sentidos** | Agent: `use-dictation.ts:436`; ditado: `helo-agent-provider.tsx:1704` |
| `DICTATION_PROCESSING` bloqueia o Agent | **sim** | `isDictationActive()` cobre a transcrição em voo |
| Agent ativo bloqueia o ditado | **sim** | `agenteDetemMicrofone()` → aviso ao cuidador |
| áudio da Helo tocando bloqueia o ditado | **sim** | `isHeloAudioPlaying()` — impediria transcrever a própria Helo |
| teardown devolve a posse | **sim** | derivado do estado real, não marcado por handler (`:1439-1452`) |

`test:dictation:coordination` 111 ✓ sustenta a arbitragem.

---

## 16. Agent × TTS

Prioridade medida no código, da mais alta para a mais baixa:

1. **voz do paciente / emergência** — `beginPatientVoiceOverride` chama os
   supressores registrados; o volume do Agent vai a zero e volta ao fim
   (`helo-agent-provider.tsx:1463`);
2. **Agent Helo conectando ou conectado** — bloqueia e interrompe toda voz
   automática da plataforma (`setAgentConversationActive`, `:1439`);
3. **frase gravada tocando** — muta o microfone do SDK para o áudio não voltar
   pela entrada (`PHRASE_AUDIO_EVENT`, `:1295`);
4. **música gerada** — suspende o microfone enquanto toca;
5. **voz assistente da plataforma** — cede a todas as anteriores.

Navegação durante a fala: `routine.backToMenu` e `conversa.repetir` chamam
`stop()`. Nenhuma prioridade foi alterada nesta fase.

---

## 17. Microfone do Agent

Auditado contra a lista do §20. A 5.1A e a 5.2B já endureceram quase tudo:

| Momento | Comportamento | Estado |
|---|---|---|
| aquisição | posse **tomada**, não verificada, antes de qualquer `await` | ✅ |
| `CONNECTING` → `ACTIVE` | mesma concessão, `avancaMicrofone` | ✅ |
| falha antes do WebRTC | `catch` do `connect` → `releaseSdkSession` | ✅ |
| falha depois do WebRTC | `release({force:true})` — a correção do R-05 | ✅ |
| reconexão por troca de voz | reaproveita a concessão; o cuidador nunca solta o dispositivo | ✅ |
| desmonte / logout | efeito de limpeza devolve a concessão | ✅ |
| troca de paciente | encerra e devolve | ✅ |
| navegação | com persistência, mantém; sem, encerra | ✅ |
| queda do SDK | `markClosed` evita `endSession` em recurso morto | ✅ |

**Lacuna residual:** `startLoggedSession` pode falhar e a sessão **segue aberta
sem registro** — está anotado no próprio código
(`agent-session-lifecycle.ts:126`) como decisão de produto pendente, não
descuido. Continua pendente.

---

## 18. Persistência do Agent

| Pergunta | Resposta |
|---|---|
| onde o estado é configurado | Ajustes → `helo_persistent_assistant_enabled`, por paciente; padrão **ligado** (`lib/defaults.ts:103`) |
| como o provider sobrevive | ele está no **layout raiz** (`app/layout.tsx:57`) — sobrevive a toda navegação client-side |
| quais rotas desmontam | nenhuma; o PAINEL só renderiza em `/helo` (portal para `#helo-agent-stage`), fora dali fica a barra flutuante |
| quando a sessão termina | botão Encerrar, `beforeunload`, desmonte, troca de paciente, ou sair de `/helo` com persistência **desligada** |
| paciente pode mudar com a sessão aberta | pode ser tentado — e a sessão é encerrada com aviso |
| contexto/ações são atualizados na hora | **sim**: o registry reflete a tela montada, e a descoberta é lida a cada chamada |
| transcript antigo permanece relevante | **sim, e ninguém o invalida** — a conversa continua com todo o histórico da navegação anterior |
| ação antiga pode continuar disponível | não: sai do registry no desmonte |

O ponto para a 5.3C é o penúltimo. Com persistência ligada, o cuidador
atravessa Rotina → Atividades → Emergência com **uma única conversa**, e o
modelo carrega o contexto inteiro do trajeto. As ações mudam; a memória da
conversa, não. Não há `contextual_update` avisando "a tela mudou".

---

## 19. Troca de paciente

| Aspecto | Comportamento |
|---|---|
| o Agent encerra? | **sim** — `end()` e aviso: "A conversa foi encerrada porque o paciente ativo foi alterado" (`:1503`) |
| durante a ABERTURA | `openAgentSession` compara o paciente pedido com o atual logo após `markOpen` e mata a sessão órfã (`agent-session-lifecycle.ts:176`) |
| durante uma tool em voo | `authorizeTool` reconfere o paciente ativo depois da resposta do servidor (`:867`) |
| token muda? | sim: cada conexão pede um token novo, com o `patientId` validado por vínculo |
| dynamic vars mudam? | sim, são montadas por sessão |
| registry limpa? | sim, no desmonte das telas |
| transcript anterior permanece? | **não**: a conversa é encerrada, e a próxima começa nova |
| client tools carregam patientId antigo? | **não**: leem `patientIdRef.current` no momento da chamada |

Três barreiras independentes, em três momentos diferentes. É o ponto mais bem
resolvido de toda a integração.

---

## 20. Endpoints

### `POST /api/helo/conversation-token`

| Aspecto | Situação |
|---|---|
| autenticação | `requirePatientAccess` — sessão obrigatória |
| autorização | vínculo ativo com o paciente; o `patientId` do cliente **não é confiado** |
| escopo do token | conversa da ElevenLabs; não dá acesso à API nem à conta |
| duração | definida pela ElevenLabs; não controlada aqui |
| `Cache-Control` | ⚠️ **ausente na resposta** — o `no-store` está na chamada AO provedor, não na resposta AO cliente |
| erro | categoria preservada; timeout **nunca** vira 401 |
| timeout | `PRAZOS_ELEVENLABS.conversationToken` (R-10, fechado na 5.1B) |
| resposta crua do provedor | não repassada; só o campo `token` |
| rate limiting | **inexistente** |

### `POST /api/helo/client-tools`

| Aspecto | Situação |
|---|---|
| autenticação | `requirePatientAccess` |
| acesso ao paciente | validado, com permissão adicional quando declarada |
| payload | 4 campos, todos validados contra tabelas fechadas |
| dados devolvidos | `{ok:true}` — nada mais |
| ação permitida | 7 nomes; `getCurrentHeloActions` nem passa por aqui |
| erros | mensagem genérica, sem eco do corpo |
| logs | nenhum |
| contexto obsoleto | **não verificado no servidor** — o cliente reconfere o paciente depois |
| rate limiting | **inexistente** |

Nenhum endpoint legado equivalente foi encontrado.

---

## 21. Logs

Só os do Agent. Nada de refatoração global; R-07 (música) segue para a 5.4.

| Log | Onde | Conteúdo | Avaliação |
|---|---|---|---|
| `[HELO TOOL] interactWithHeloUI called` | navegador, `:973` | `rawId` **e o objeto `parameters` inteiro** | ⚠️ o payload pode conter rótulo de opção clínica |
| `[HELO NAV] requested area` | navegador | texto pedido pelo Agent | baixo |
| `[HELO TOOL] registered client tools` | navegador | só os nomes | ok |
| `[HELO TOOL] ação bloqueada` | navegador | actionId + classe | ok, e útil |
| `[HELO AUDIO] agent error` | navegador | mensagem + contexto do SDK | baixo |
| `[HELO AGENT] voice override` | **servidor**, `conversation-token:115` | três booleanos e a preferência | ok — nenhum id de voz |
| `[HELO ROUTINE] actions registered` | navegador | contagem | ok |
| `[HELO SILENCE] …` | navegador | contadores | ok |

Nenhum log imprime token, chave, nome do paciente ou transcript. O único que
merece atenção é o primeiro, e nenhum deles é gateado por `NODE_ENV`.

---

## 22. Segredos e tokens

| Verificação | Resultado |
|---|---|
| `ELEVENLABS_API_KEY` chega ao navegador? | **não** — só em rotas de servidor; nenhuma variável `NEXT_PUBLIC_*` a expõe |
| o token de conversa é temporário? | sim, emitido por sessão pela ElevenLabs |
| o endpoint exige autenticação? | sim |
| acesso ao paciente é validado? | sim, antes de qualquer chamada ao provedor |
| o token aparece em log? | **não** |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (órfã na 5.0) | não existe mais no código |

Nenhum vazamento de segredo encontrado.

---

## 23. Voz do Agent — R-12

Duas coisas distintas, e o documento as separa:

- **voz do PACIENTE** — clonada, protegida por `SpeechGrant` (5.1A);
- **voz do AGENT Helo** — configurada **no painel da ElevenLabs**.

O override por sessão existe no servidor (`resolveVoiceOverride`,
`conversation-token:63`), atrás de `ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED`.
**Ele nunca é usado.** `openAgentSession` chama `requestToken(true)` — literal,
nas duas chamadas (`agent-session-lifecycle.ts:161,168`), o que força
`disableVoiceOverride`, logo `voiceId = null`, logo `voiceOverrideApplied =
false`. E como o retry só acontece `if (token.voiceOverrideApplied)`, **o retry
também é inalcançável**.

R-12 confirmado, ainda aberto, e mais enterrado do que na 5.0: o que era um
argumento no provider virou um literal dentro do módulo de ciclo de vida.
O motivo está documentado ali (`:158`): o LiveKit derruba o socket quando
recebe override remoto. A decisão está certa; o código morto é que deveria
sair — junto com as quatro variáveis de ambiente que ninguém lê.

---

## 24. A tela da sessão Helo

| Controle | Classificação | Observação |
|---|---|---|
| "Conectar com Helo" | **AGENT CONTROL** | também é `helo.conectar` (operational) |
| "Encerrar conversa" / "Encerrar Helo" | AGENT CONTROL | `helo.encerrar` é `sensitive`: só a pessoa encerra |
| "Helo ouvindo / falando / aguardando" | **STATUS** | derivado do SDK |
| indicador de conexão (verde/amarelo/vermelho) | STATUS | do RTT real |
| seleção de microfone + "Atualizar" | **CAREGIVER CONTROL** | preferência persistida em `localStorage` |
| "Microfone captando" + medidor | STATUS | |
| botão de mute do Agent | CAREGIVER CONTROL | zera a saída **e** o microfone |
| **SIM / TALVEZ / NÃO** | **PATIENT RESPONSE** | o cuidador RELATA o gesto; o Agent nunca os pressiona |
| "Mensagem para a Helo" + Enviar | CAREGIVER CONTROL | §25 |
| "debug.ping" | **DEBUG/CONFIG** | atalho de diagnóstico da tool; não toca no registry |

Estar na mesma tela não mistura autoridade: os três botões de gesto são os
únicos `patientResponse` ali, e são inalcançáveis pelo Agent por classe — não
por posição, nem por rótulo, nem por não estarem anunciados (eles **estão**
anunciados, com o motivo da recusa).

---

## 25. O campo "Mensagem para a Helo"

| Pergunta | Resposta |
|---|---|
| para onde vai | duas vias: `sendContextualUpdate` (contexto) e `sendUserMessage` (pede resposta em voz); e um `POST /api/patients/{id}/observations` para o dashboard |
| role usada | `user`, prefixada com `Mensagem escrita pelo acompanhante:` |
| pode disparar tools? | **sim** — é uma entrada de conversa como outra qualquer |
| equivale à fala do cuidador? | **sim**, e é assim que deve ser |
| pode conter SIM/TALVEZ/NÃO? | pode conter as palavras. **Não produz resposta do paciente**: o caminho para isso é `action.run` de uma `patientResponse`, e o gate o fecha |
| voz × texto: diferença de segurança? | **nenhuma**, e é o correto — as duas são o cuidador orientando o Agent |

A regra conceitual do §31 está satisfeita: as duas orientam o Agent, e nenhuma
das duas representa a resposta do paciente.

---

## 26. Testes existentes

| Suíte | Qtd. | O que prova | O que **não** prova |
|---|---:|---|---|
| `test:agent:gate` | 52 | o gate recusa `patientResponse` sob toda forma de pedido (alias, emoji, idioma, id remontado, gesto no payload) | que o conjunto de ações auditado é o conjunto real da tela |
| `test:agent:invariants` | 21 | toda ação tem uma classe, uma só, literal, e bate com um catálogo declarado | nada sobre arquivos fora da lista fixa — **fechado agora por `test:agent:inventory`** |
| `test:agent:lifecycle` | 33 | a ordem de abertura, a troca de paciente no meio, o retry, o teardown em cada falha | comportamento do SDK real |
| `test:agent:teardown` | 12 | o recurso externo fecha mesmo sem registro de sessão | — |
| `test:agent:inventory` **(novo)** | 19 | o perímetro: nenhuma tela registra fora do alcance, rotas globais são só destino, o payload ao provedor é uma lista declarada | nada sobre a configuração do painel |
| `test:dictation:coordination` | 111 | arbitragem do microfone, teardown, respostas atrasadas | — |
| `test:voice:grant` / `:callsites` | 32 / 14 | a voz do paciente exige autorização do servidor | — |
| `test:music:authorization` | — | autenticação de `generateMusic` (R-03) | R-04/R-07 |
| Playwright | 245 | as jornadas do produto | **nada do Agent**: não há spec de sessão Helo |

**Lacuna de teste:** não existe cobertura de interface para a sessão do Agent —
nem conectar, nem encerrar, nem a barra de status persistente. É consequência
direta de o Agent depender de WebRTC e de um provedor externo, e não uma
omissão descuidada; mas significa que o painel `/helo` só é exercitado à mão.

---

## 27. Matriz de riscos

| # | Sev. | Achado | Evidência |
|---|---|---|---|
| **A-01** | **ALTO** | `getCurrentHeloActions` envia à ElevenLabs o `textContent` de todo `button`/`a` da tela — medido carregando opções clínicas e a pergunta da sessão, numa tela onde o Agent não tem ação nenhuma. É o R-09 da 5.0, com severidade elevada por medição. | `helo-agent-provider.tsx:928-941`; §12 |
| **A-02** | **MÉDIO** | Todo o subsistema de perguntas em tempo real / conversa por opções (4.9) não registra ação nenhuma: máxima exposição de contexto, capacidade zero. | varredura de `useRegisterHeloUIActions`; §6 |
| **A-03** | **MÉDIO** | R-08: quatro origens humanas distintas chegam ao provedor como role `user`, separadas só por prefixo em texto. Um comentário do código chama isso de "patient speech". | `:1221-1225, 1602, 1648, 1848`; §14 |
| **A-04** | **MÉDIO** | Comentários afirmam que o Agent aciona Emergência, respostas da Rotina e `goToManageActivities` — ele não aciona nenhuma. `toolSuccess` nessas ações é código morto que documenta um comportamento inexistente. | `emergencia/page.tsx:232`; `rotina/page.tsx:277`; `activity-player.tsx:702` |
| **A-05** | **MÉDIO** | Sem invalidação de contexto para tool em voo na troca de ROTA (a de PACIENTE é verificada). Handler de tela abandonada ainda executa. | `:1034-1046`; §11 |
| **A-06** | **MÉDIO** | Com persistência ligada, uma conversa atravessa todas as telas carregando o transcript inteiro; nada avisa o modelo de que o contexto mudou. | §18 |
| **A-07** | **BAIXO** | R-12: override de voz do Agent é caminho morto — agora com a desativação literal no módulo de ciclo de vida; 4 variáveis de ambiente órfãs. | `agent-session-lifecycle.ts:161,168`; §23 |
| **A-08** | **BAIXO** | `availableActions` é duplicata literal de `globalRoutes + localElements` no payload. | `:953-956` |
| **A-09** | **BAIXO** | `[HELO TOOL] interactWithHeloUI called` loga o objeto `parameters` inteiro no console, sem gate de ambiente. | `:973` |
| **A-10** | **BAIXO** | Sem `Cache-Control` na resposta de `conversation-token`; sem rate limiting em nenhum dos dois endpoints. | §20 |
| **A-11** | **BAIXO** | Cinco nomes de tool e sete nomes de parâmetro mantidos como compatibilidade porque o contrato do painel não é conhecido. | `:1146-1170, 965-972` |
| **A-12** | **INFO** | `startLoggedSession` falhando deixa a sessão aberta sem registro — decisão de produto pendente, anotada no código. | `agent-session-lifecycle.ts:126` |
| **A-13** | **INFO** | `/atividades/gerenciar` não tem rota global: inalcançável por voz. | §6 |
| **A-14** | **INFO** | Nenhuma cobertura de interface para a sessão do Agent. | §26 |
| **A-15** | **INFO** | Duas ações puramente de navegação (`atividades.gerenciar`, `activity.goToManageActivities`) classificadas `sensitive` — conservador, custa capacidade. | §5.1 |

**Nenhum achado CRÍTICO.** Não foi encontrado caminho pelo qual o Agent
responda pelo paciente, produza fala do paciente, execute `patientResponse`,
contorne confirmação humana, cruze pacientes ou vaze segredo.

---

## 28. Proposta para a 5.3B

Escopo: registry, classificação, contexto mínimo, cobertura funcional.

1. **A-01 — minimizar o contexto enviado ao provedor.** Remover
   `availableActions`; remover ou restringir `localElements`; decidir sobre
   `patientId`. É a mudança de maior efeito e de menor risco de toda a lista.
2. **A-02 — registrar as ações da Fase 4.9.** Apresentar nível, navegar
   degraus, abrir/fechar a conversa por opções, registrar interpretação.
   Classificação esperada: as escolhas do paciente são `patientResponse`; a
   apresentação e a navegação são `operational`/`navigation`.
3. **A-04 — corrigir os comentários e remover o `toolSuccess` morto.** Um
   arquivo que descreve o Agent como mais permissivo do que ele é custa caro na
   próxima leitura.
4. **A-15 — reavaliar as duas classificações conservadoras**, com decisão
   explícita registrada.
5. **A-11 — obter e versionar o contrato do painel** (nomes de tool, schemas de
   parâmetro), e então remover os aliases de compatibilidade.
6. **A-13 — decidir** se o gerenciamento de atividades entra no alcance do
   Agent.

## 29. Proposta para a 5.3C

Escopo: ciclo de vida, concorrência, ações obsoletas, validação integrada.

1. **A-05 — token de contexto/geração** na descoberta, devolvido na execução:
   uma tool cujo contexto expirou é recusada com motivo, em vez de executar um
   handler de tela abandonada.
2. **A-06 — invalidação de contexto na navegação** com sessão persistente:
   `sendContextualUpdate` dizendo que a tela mudou, e o que passou a estar
   disponível.
3. **A-12 — decidir** o que fazer quando a sessão de produto não registra.
4. **A-14 — cobertura de interface** para conectar/encerrar/persistir, com o
   SDK simulado — sem provedor real.
5. Validação integrada do Agent com STT, TTS, emergência, offline e troca de
   paciente, no mesmo formato da 5.2C.

## 30. Itens para a 5.4

1. **A-09** — logs do Agent: parar de imprimir o payload cru, e revisar o gate
   de ambiente. Junto com R-07 (URL de música no console), que já era da 5.4.
2. **A-10** — `Cache-Control` e rate limiting nos dois endpoints do Agent.
3. **A-07** — remover o caminho morto de override de voz e as variáveis órfãs.
4. Revisão de privacidade residual do que resta sendo enviado ao provedor
   depois da minimização da 5.3B.

**NÃO FAZER:** nada nesta auditoria justifica mexer no gate, na classificação
de `patientResponse`, no `SpeechGrant`, na Fase 4.9 estruturalmente, nem na
arquitetura da 5.2.
