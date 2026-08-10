# Fase 5.3B — contexto mínimo e contrato de capacidades do Agent Helo

## 1. Objetivo

A 5.3A mediu o que o Helo mandava à ElevenLabs numa conversa por opções real:
as opções escritas pelo cuidador, a pergunta da sessão e o estado clínico —
**25 rótulos de texto visível, numa tela onde o Agent não tinha nenhuma ação
executável.** Era o R-09, e a auditoria o subiu de MÉDIO para ALTO por medição.

Esta fase troca a pergunta que o payload responde:

| | Pergunta que o payload respondia | Pergunta que ele responde agora |
|---|---|---|
| até a 5.3A | "o que está escrito nesta tela?" | — |
| a partir da 5.3B | — | "o que a Helo pode fazer aqui?" |

A regra que governou cada decisão: **a 5.3B pode aumentar COBERTURA; não pode
aumentar AUTORIDADE.**

## 2. Baseline da 5.3A

41 ações · navigation 7 · operational 12 · sensitive 12 · patientResponse 10 ·
19 executáveis · 22 recusadas · 9 rotas globais fora do registry · zero ações
sem classificação · zero risco CRÍTICO.

### O que a 5.3A apontou, e para onde foi

| Achado | Destino | Mudança | Risco de aumentar autoridade | Teste |
|---|---|---|---|---|
| A-01 R-09 (ALTO) | **5.3B** | payload vira contrato de capacidades | nenhum — o payload não decide nada | `test:agent:capabilities`, lote `agent-contexto` |
| A-02 Fase 4.9 invisível | **5.3B** | 6 ações novas, todas navigation/operational | avaliado ação por ação (§8) | `test:agent:invariants`, `test:agent:capabilities` |
| A-04 comentários incorretos | **5.3B** | corrigidos em 4 lugares | nenhum — o gate não mudou | `test:agent:inventory` |
| A-08 `availableActions` duplicado | **5.3B** | removido | nenhum | `test:agent:inventory` |
| A-15 duas classes conservadoras | **5.3B** | avaliadas e **mantidas** | nenhum, por decisão | `test:agent:invariants` |
| A-11 aliases de compatibilidade | **5.3B** | inventariados, não removidos | nenhum | §17 |
| A-03 R-08 roles | 5.3C/5.4 | só garantimos que não piorou | — | §16 |
| A-05 stale action na troca de rota | 5.3C | — | — | — |
| A-06 transcript atravessa telas | 5.3C | — | — | — |
| A-07 override de voz morto | 5.4 | — | — | — |
| A-09 logs, A-10 endpoints | 5.4 | — | — | — |

## 3. Modelo de autoridade — inalterado

| Classe | O Agent executa? | Mudou na 5.3B? |
|---|---|---|
| `navigation` | ✅ | não |
| `operational` | ✅ | não |
| `sensitive` | ❌ — chega à fronteira, não a ultrapassa | não |
| `patientResponse` | ❌ — nunca | não |
| sem classe | ❌ — fail-closed | não |

`isActionAllowedFor` não foi tocada. Nenhuma ação existente mudou de classe.
Não existe confirmação por voz, e `dialog.confirm` continua `sensitive`.

## 4. O contrato de capacidades

Fonte única: [`lib/helo-capabilities.ts`](../lib/helo-capabilities.ts). Função
**pura** — sem DOM, sem React, sem `window` — porque o payload é a fronteira
por onde o dado sai, e uma fronteira precisa ser exercitável sem navegador. A
suíte conduz esta função, não uma cópia.

```ts
interface HeloCapability {
  id: string;                       // o id estruturado, nunca o rótulo
  class: "navigation" | "operational";  // só as duas alcançáveis existem aqui
  label: string;
  aliases?: readonly string[];
  scope: "global" | "screen";
}
```

Uma capability é uma ação que o Agent pode executar **agora**. Ação bloqueada
não vira sugestão, não vira rótulo, não vira dica: vira número.

## 5. O payload anterior

```jsonc
{
  "ok": true,
  "currentPath": "/conversa/perguntas",
  "screen": "conversar",
  "patientId": 1754...,
  // ...screenContext.extra — a pergunta clínica e os rótulos de opção
  "globalRoutes": [ ... ],
  "localElements": [            // textContent de TODO button/a da tela
    { "actionId": "👍Dor no peitoPositivo", "label": "👍Dor no peitoPositivo" },
    { "actionId": "1.Onde está doendo agora?03:23◔ Em andamento…", "label": "…" }
  ],
  "availableActions": [ ... ],  // duplicata literal de globalRoutes + localElements
  "actions": [ ... ]            // registry inteiro, incluindo o bloqueado com rótulo
}
```

## 6. O payload novo

```jsonc
{
  "ok": true,
  "route": "/conversa/perguntas",
  "screen": "perguntas_conversa_por_opcoes",
  "capabilities": [
    { "id": "navigate-rotina", "class": "navigation", "label": "Ir para Rotina", "scope": "global" },
    { "id": "perguntas.sairDaConversaPorOpcoes", "class": "navigation",
      "label": "Sair da conversa por opções", "aliases": [...], "scope": "screen" }
  ],
  "humanOnly": { "patientResponse": 0, "sensitive": 0, "unclassified": 0, "disabled": 0 },
  "diagnostic": "debug.ping"
}
```

**Por que a contagem, e não a lista.** Sem nada, o Agent responderia "não
encontrei" a um pedido legítimo e o cuidador tentaria de novo com outras
palavras. Com a contagem ele diz a verdade — "há ações aqui que só uma pessoa
pode fazer" — sem que uma palavra da tela atravesse a fronteira.

**`route` vai sem query string.** `?section=…` é inofensivo hoje; a regra "o
caminho, e só o caminho" não depende de auditar cada parâmetro que apareça
amanhã.

## 7. A minimização do R-09

| Campo removido | O que carregava |
|---|---|
| `localElements` | o `textContent` de todo `button`/`a` — opções do paciente, perguntas da sessão, estado clínico |
| `availableActions` | duplicata literal do acima |
| `screenContext.extra` | `currentQuestion` (a pergunta do card / da atividade) e `currentOptions` (rótulos escritos pelo cuidador + frases de exemplo montadas a partir deles) |
| `patientId` | id interno do paciente; o servidor já sabe quem é |
| ações bloqueadas com rótulo | os 22 itens que o Agent nunca executa, cada um com seu texto |

Três vazamentos menores fechados junto, no caminho de **resposta**:

1. `agentDenialReason` interpolava o rótulo — e o rótulo de um item de
   Emergência é texto que o cuidador escreveu. Agora devolve a política.
2. `"A ação \"${label}\" está indisponível agora."` → `UNAVAILABLE` sem rótulo.
3. A mensagem do erro do handler voltava ao provedor. Ela é escrita para o
   cuidador e pode citar a tela; agora fica no console e o Agent recebe `FAILED`.

## 8. Ações incluídas e excluídas na cobertura da 4.9

Toda tela do subsistema de perguntas em tempo real foi avaliada. Critério de
entrada: existe ação humana equivalente, não cria capacidade nova, é
navigation/operational, não responde pelo paciente, não conclui o que a
política manda um humano concluir, tem registro e desmonte definidos, e é
testável sem provedor.

| Controle | Classificação | Entrou? | Por quê |
|---|---|---|---|
| Controles do paciente (abrir) | navigation | ✅ | abre um painel; os comandos dentro dele não estão registrados |
| Pausar sessão | operational | ✅ | reversível, é o que o cuidador pediria por voz |
| Retomar sessão | operational | ✅ | inverso do anterior |
| Conversa por opções (abrir) | operational | ✅ | troca de modo, não decide nada |
| Registrar o que entendi (abrir) | operational | ✅ | **abrir** a tela; escrever e confirmar continuam do cuidador |
| Sair da conversa por opções | navigation | ✅ | volta, sem descartar |
| Continuar / Apresentar ao paciente | operational | ❌ | empurram a pergunta do cuidador em direção ao paciente — quem decide que ela está pronta é quem a escreveu |
| Encerrar sessão | sensitive | ❌ | política mantida |
| Reiniciar conversa | — | ❌ | descarta o caminho percorrido pelo paciente |
| Retomar item do histórico | — | ❌ | os rótulos são conteúdo clínico; anunciá-los recriaria o R-09 pela porta dos fundos |
| Editar contexto da sessão | — | ❌ | destino cheio de texto clínico, valor baixo |
| As opções apresentadas | patientResponse | ❌ | nunca |

Total: **47 ações** (41 + 6). Distribuição: navigation **9**, operational
**16**, sensitive **12**, patientResponse **10**. **25 executáveis** pelo Agent.

## 9. Rotas globais

Auditadas antes de qualquer mudança e **mantidas fechadas**: 9 destinos
literais, sem handler, sem URL vinda do modelo, sem `javascript:`, sem query.
Não foram migradas para o registry — o contrato apresentado ao Agent é que
ficou uniforme: elas aparecem como capabilities `navigation` de escopo
`global`.

`/admin` continua **fora** da tabela. `/dashboard` e `/ajustes` continuam
dentro, como já estavam: a autorização real acontece em
`POST /api/helo/client-tools` (`requirePatientAccess` + permissão da área), e a
capability não a contorna. A política não foi alterada por preferência.

## 10. Conteúdo dinâmico

O modelo seguro da 5.3A foi preservado: **id estruturado + rótulo mínimo**.

| Dado dinâmico que ainda sai | Por quê | Sem ele |
|---|---|---|
| título da atividade (`atividades.iniciar.*`) | é o que permite "Abra Fisioterapia" | o Agent não teria como escolher entre atividades |
| pergunta do card da Rotina (`routine.open.*`) | é o rótulo da ação; catálogo **fixo** de produto (`lib/routine.ts`), não dado do paciente | idem |
| rótulo do item de Emergência | **não sai** — é `sensitive`, logo não é capability | — |
| opção da conversa por opções | **não sai** — é `patientResponse` | — |
| pergunta/opções de atividade | **não sai** — saíam pelo `extra`, que foi removido | — |

Nome é dado, nunca autoridade. Testado com rótulos que imitam identificadores
internos e destinos: `dialog.confirm`, `patientResponse`, `SIM`, `NÃO`,
`/admin`, `javascript:alert(1)`, `navigate-dashboard`. Todos continuam
`operational` de escopo `screen`, com o id estruturado intacto.

## 11. Aliases

Continuam vindo do produto, curados por ação. Não elevam privilégio: o gate
decide pela **classe da ação encontrada**, e o alias só participa de QUAL ação
foi encontrada. `test:agent:gate` (53) exercita 52 formas de pedido — alias,
emoji, idioma, id remontado, gesto solto no payload — e todas continuam
recusadas quando a ação é bloqueada.

## 12. Parâmetros

Nenhuma tool aceita seletor, `href`, URL, HTML ou JavaScript. `actionId` é
livre por construção — e é exatamente por isso que a decisão é da classe da
ação resolvida, nunca do texto pedido. `payload` chega a `action.run`; as ações
que o leem (`conversa.opcao.*`, `atividades.resposta.*`) são todas
`patientResponse` e inalcançáveis.

A validação de `area`, `section` e `permission` no servidor continua contra
tabelas fechadas. **Não migramos schemas** que já eram seguros: a fase
priorizou o que estava exposto.

## 13. Códigos de resultado

O Agent passou a receber um código estável, e nunca o texto da tela:

`SUCCESS` · `NOT_FOUND` · `UNAVAILABLE` · `FORBIDDEN` · `FORBIDDEN_BY_POLICY`
(com `requiresHumanAction`) · `INVALID_PARAMETER` · `FAILED`

`toolSuccess` é espalhado **antes** dos campos do contrato: uma dica de narração
declarada numa tela não pode sobrescrever o código de resultado.

## 14. `toolSuccess`

Auditadas as 15 ocorrências. Consumidor único: o caminho do Agent, depois do
gate — logo, numa ação bloqueada é código morto.

| Situação | Ações | Decisão |
|---|---|---|
| morto (classe bloqueada) | `emergencia.item.*`, `routine.answer.*.*`, `atividades.resposta.*.*`, `conversa.repetirMensagemPaciente`, `atividades.frases.ouvir`, `dialog.confirm`, `dialog.cancel`, `activity.goToManageActivities`, `atividades.encerrar` | **removido** |
| vivo (Agent alcança) | `routine.open.*`, `routine.backToMenu`, `atividades.iniciar.*`, `atividades.frases.abrir/fechar/anterior/proxima`, `activity.goToActivityMenu`, e as 6 novas da 4.9 | mantido, sem `result:` (agora é do contrato) e sem `activityTitle` (o título já é o rótulo da capability) |

Prendido por teste: nenhuma ação `sensitive` ou `patientResponse` pode voltar a
declarar `toolSuccess`.

## 15. Comentários corrigidos

Quatro afirmavam autoridade que não existe:

| Arquivo | Dizia | Diz |
|---|---|---|
| `app/(palco)/emergencia/page.tsx` | "o toque do Agent também é confirmação" | o Agent navega até a Emergência e explica; disparar é da pessoa |
| `app/(palco)/rotina/page.tsx` | "acionar por tool executa o MESMO handler do clique" | as respostas são `patientResponse`; o Agent abre o card e volta |
| `components/activity-player.tsx` | "o Agente também executa" | `sensitive`: ele para na fronteira |
| `components/activity-player.tsx` (opções) | idem | `patientResponse`, registrada para o clique humano |

Um código que se descreve mais permissivo do que é engana na direção perigosa:
leva a proteger de novo o que já está protegido, e a não olhar o que não está.

## 16. R-08 — não piorou

Não foi refatorado (é da 5.3C/5.4). Verificado que a mudança não o agrava:
transcript não entra no contexto de capacidades, texto digitado para a Helo não
vira rótulo de ação, e o ditado da 5.2 continua completamente separado.

## 17. Compatibilidade com nomes antigos

| Nome local | Alias legado | Onde é aceito | Por que existe | Remover sem o painel? |
|---|---|---|---|---|
| `getCurrentHeloActions` | `getVisibleHeloActions` | `clientTools` | o painel declara o segundo | **não** |
| `interactWithHeloUI` | `interactWithVisibleHeloUI`, `executeHeloAction` | `clientTools` | idem | **não** |
| `generate_and_play_music` | `generate_music` | `clientTools` | sessões antigas do painel | **não** |
| `actionId` | `action`, `id`, `name`, `label`, `target`, `command` | `interactWithUI` | a declaração da tool no painel não é conhecida | **não** |
| `targetArea` | `area`, `target`, `name` | `navigateHeloArea` | idem | **não** |

Todos concentrados em `clientTools` e no topo de `interactWithUI` — isolados,
documentados, e cobertos pelas suítes. **Nenhum foi removido:** não sabemos o
que o painel usa, e remover às cegas quebraria a integração em produção.

## 18. Contrato externo necessário para validação posterior

A 5.3B não inventou nada disto. Para fechar a outra metade do contrato,
precisamos exportar do painel (ou de `GET /v1/convai/agents/{id}`):

| Item | Onde estaria | Por que precisamos | A que contrato local corresponde |
|---|---|---|---|
| definição das tools (nomes + schemas) | Agent → Tools | remover 5 aliases de nome e 7 de parâmetro | as chaves de `clientTools` e o topo de `interactWithUI` |
| `description` de cada tool | idem | é o que ensina o modelo a chamar; hoje não sabemos o que ela diz sobre o payload | o novo shape de `capabilities` |
| system prompt | Agent → Prompt | pode instruir a pedir ações que não existem mais (`localElements`) | `route` / `screen` / `capabilities` / `humanOnly` |
| regras de tool calling | Agent → Advanced | saber se `humanOnly` é interpretado | o contrato de recusa |
| Knowledge Base | Agent → KB | pode conter dado clínico que não passa por aqui | política de privacidade |
| First Message | Agent → Widget | usa `{{heloPatientGreeting}}` | `dynamicVariables` |
| modelo, voz, idioma | Agent → Voice/LLM | R-12 e a voz oficial | `resolveVoiceOverride` (caminho morto) |

### Mudanças que talvez sejam necessárias no dashboard

O payload mudou de forma. Se o system prompt descreve os campos antigos
(`localElements`, `availableActions`, `actions`), ele precisará ser atualizado
para `capabilities` / `humanOnly`. **Não alteramos o painel** e não presumimos
que seja editável por API. Os nomes das tools e dos parâmetros continuam
aceitos como antes — a compatibilidade foi preservada de propósito para que
esta mudança não dependa de um deploy no painel.

## 19. Medição antes × depois

Mesmas telas da 5.3A, mesmo método, servidor e banco descartáveis, sem
provedor. "Antes" = rótulos de texto da tela que `localElements` enviava.

| Tela | Antes: rótulos de texto | Depois: capabilities | locais | humanOnly | payload | conteúdo clínico depois |
|---|---:|---:|---:|---|---:|---|
| menu `/` | 17 | 9 | 0 | — | 979 B | **0** |
| `/helo` | 16 | 11 | 2 | sensitive 1 | 1.185 B | **0** |
| `/rotina` (menu) | 30 | 24 | 15 | — | 2.489 B | **0** |
| `/rotina` (card aberto) | 19 | 10 | 1 | patientResponse 3 | 1.229 B | **0** |
| `/emergencia` | 20 | 9 | **0** | sensitive 5 | 995 B | **0** |
| `/atividades` | 15 | 9 | 0 | — | 995 B | **0** |
| `/conversa` (intro) | 18 | 9 | 0 | disabled 1 | 992 B | **0** |
| `/conversa/perguntas` | 34 | 13 | **4** | — | 1.797 B | **0** |
| **conversa por opções** | **25** | **12** | **3** | — | 1.603 B | **0** |

As duas linhas que resumem a fase:

- **`/emergencia`**: 20 rótulos (incluindo as frases de socorro escritas pelo
  cuidador) → **zero**. A tela continua alcançável por navegação e continua
  sem nenhuma ação executável pelo Agent.
- **conversa por opções**: 25 rótulos com o conteúdo clínico → **zero**, e a
  tela deixou de ser um vazio de capacidade: passou de 0 para 3 ações locais.

Prova direta do marcador: um texto `SEGREDO_CLINICO_R09_X7` foi escrito no
título do nível, nas três opções e na frase final. Ele **está na tela** e **não
está no payload** — asserido nos dois sentidos, para que o teste não passe por
não ter medido nada.

## 20. Testes

| Suíte | Antes | Depois | O que a mudança acrescentou |
|---|---:|---:|---|
| `test:agent:gate` | 52 | **53** | o motivo da recusa não repete o rótulo da ação |
| `test:agent:invariants` | 21 | **21** | +6 ações no catálogo; a checagem do DOM foi **invertida** |
| `test:agent:inventory` | 19 | **41** | o contrato do payload, `toolSuccess` morto, respostas sem rótulo |
| `test:agent:capabilities` | — | **47** | novo: a fronteira inteira, sobre a função pura |
| `test:agent:lifecycle` | 33 | 33 | — |
| `test:agent:teardown` | 12 | 12 | — |
| `test:dictation:coordination` | 111 | 111 | — |
| Playwright `agent-contexto` | — | **7** | novo lote: a fronteira na tela real |

## 20b. Uma regressão que a fase introduziu, e como ela foi fechada

A primeira execução dos lotes afetados deu **53 aprovados e 2 falhos**: os dois
testes de breadcrumb de `conversa-por-opcoes-navigation` estouraram o teto de
90 s. Reproduziu isolado — não era ruído.

A causa foi medida, não deduzida. Revertendo **apenas** `session.tsx` para
`40aa9b8`, o lote voltou a 6/6; com a versão nova, 4/6. Bissecando dentro do
arquivo, o culpado era uma linha: `useRegisterHeloUIActions(heloAcoes)`.

O mecanismo: o `useMemo` das seis ações dependia de `sessionAct`,
`abrirControles`, `startOptionConversation` e `leaveOptionConversation` — todos
`useCallback` que dependem de `persist`, que muda de identidade a cada render.
O memo era, na prática, um memo que nunca acertava: reconstruía as seis ações
com todos os aliases em **todo render**, e o efeito de registro fazia
`delete`+`set` junto. Numa conversa por opções, esta é a tela mais quente do
produto.

A correção põe os handlers atrás de um ref atualizado por efeito e deixa o memo
depender só de primitivos — o estado real da tela. O ref é lido **no momento da
execução**, nunca durante o render, então o Agent sempre aciona o handler
atual.

Medido depois: o lote isolado passou de **07:26 com 2 falhos** para **03:53
verde** — mais rápido, inclusive, que os 04:08 do controle sem a fase.

O que isso deixa registrado: registrar ações num componente quente tem custo, e
o custo é do memo, não do registry. Uma tela nova que registre ações deve
depender de primitivos.

## 21. Limitações residuais

1. **O lote `agent-contexto` roda em modo dev**, porque lê o payload pelo hook
   `window.__heloAgentContext`, que não existe em produção. A alternativa seria
   instrumentar o produto em produção — pior troca.
2. **O system prompt do painel não foi verificado.** Se ele descreve os campos
   antigos, o Agent pode pedir o que não existe mais. O código responde
   `NOT_FOUND`; a experiência degrada até o painel ser atualizado.
3. **`humanOnly` é uma contagem, não uma explicação.** O Agent sabe que há
   ações humanas, não quais. É a troca deliberada da fase.
4. **Títulos de atividade e perguntas da Rotina continuam saindo** como rótulo
   de capability. É o mínimo para a seleção por voz funcionar.
5. **Duas ações puramente de navegação continuam `sensitive`**
   (`atividades.gerenciar`, `activity.goToManageActivities`). Conservador por
   decisão; custa cobertura, não segurança.
6. O log `[HELO TOOL] interactWithHeloUI called` ainda imprime o objeto
   `parameters` no console do navegador (A-09, 5.4). É console local, não sai
   para o provedor.

## 22. Pendências

**5.3C** — token de geração/contexto na descoberta (A-05); invalidação de
contexto na navegação com sessão persistente (A-06); decisão sobre sessão sem
registro (A-12); cobertura de interface de conectar/encerrar com SDK simulado
(A-14); validação integrada do Agent com STT, TTS, emergência, offline e troca
de paciente.

**5.4** — R-08 (roles do transcript); logs do Agent (A-09); `Cache-Control` e
rate limiting nos dois endpoints (A-10); remoção do caminho morto de override
de voz e das 4 variáveis órfãs (A-07/R-12); privacidade residual do que resta
saindo depois desta minimização.
