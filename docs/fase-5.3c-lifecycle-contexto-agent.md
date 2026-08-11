# Fase 5.3C — contexto vivo, ações vencidas e autoria do Agent Helo

## 1. Resumo executivo

A 5.3A auditou o Agent. A 5.3B fechou o R-09 e estruturou o contrato de
capacidades. Faltava a dimensão do tempo.

O Agent descobre o que pode fazer e executa **depois**. Entre as duas coisas
passam a rede até a ElevenLabs, o modelo decidindo, a client tool voltando e —
dentro do próprio Helo — um round-trip de autorização ao servidor. Nesse
intervalo o cuidador pode ter trocado de paciente, saído da tela, encerrado a
sessão ou saído da conta.

Até a 5.3B a única proteção contra isso era **incidental**: o registry esvazia
no desmonte, a ação some e o dispatcher devolve `NOT_FOUND`. Isso cobre a
mudança de tela, e só. Não cobria a janela em que a ação **ainda está
registrada** e a autoridade **já mudou**.

A regra desta fase, escrita no código:

> **AUTORIZAÇÃO ANTIGA NÃO É AUTORIZAÇÃO ATUAL.**

Fechou também o **R-08** localmente: a role do provedor deixou de ser usada
como prova de autoria, e a entrada do microfone deixou de ser chamada de fala
do paciente.

**Nenhuma ação nova foi criada. Nenhuma classificação mudou.** 47 ações,
25 executáveis — exatamente a distribuição da 5.3B.

**Antes do fechamento, a fase foi auditada contra si mesma.** A primeira versão
do §7–8 afirmava que apenas o handler de espera humana cometia depois de um
`await` contextual, e que os demais eram cobertos pelo desmonte da tela. A
auditoria das 25 ações executáveis, ação por ação, mostrou que essa segunda
metade era falsa: a troca de paciente **não desmonta** `/conversa`, `/rotina`
nem `/atividades`. Eram **quatro** caminhos, não um. Os três que faltavam —
L1 `conversa.comecar`, L2 `routine.open.*`, L3 `atividades.iniciar.*` — foram
fechados com o mecanismo que já existia, e provados com a resposta do servidor
segurada e a troca de paciente no meio.

## 2. Baseline da 5.3B

47 ações · navigation 9 · operational 16 · sensitive 12 · patientResponse 10 ·
25 executáveis · 9 rotas globais em tabela fechada · R-09 fechado · R-08 aberto.

## 3. O modelo de contexto

Quatro campos, todos **primitivos**, todos identidades que já existiam no
produto — nenhuma foi inventada para esta fase:

| Campo | De onde vem | Por que é fronteira |
|---|---|---|
| `rota` | `usePathname()`, sem query | as ações são da tela |
| `pacienteId` | `usePatient()` | um efeito no paciente errado é o pior caso |
| `sessaoId` | a tela de perguntas em tempo real | mesma pessoa, conversas diferentes |
| `usuarioId` | espelho local `helo.user` | quem está autenticado |

O `usuarioId` sai do espelho que `clearLocalMirrors()` apaga no logout. Ele é
um **detector de mudança**, não uma credencial: a autorização real continua
sendo o cookie, conferido pelo servidor a cada `authorizeTool`.

Dois publicadores, um contexto: o provider escreve rota/paciente/usuário; a
tela clínica escreve a sessão. Nenhum dos dois precisa conhecer o outro, e a
ordem em que montam não importa.

## 4. Generation, e por que essa forma

[`lib/helo-agent-context.ts`](../lib/helo-agent-context.ts) — um contador
monotônico. Quem vai executar **captura** a geração (o *lease*) e a **confere**
no último instante antes do efeito.

Três decisões, e o motivo de cada uma:

1. **Não é criptográfico.** Não protege contra um atacante — protege contra o
   tempo. Um `randomUUID` custaria mais e não provaria nada a mais.
2. **Não viaja até a ElevenLabs.** Nada no contrato externo muda, e a segurança
   não fica dependendo de o modelo devolver corretamente um valor que mandamos
   para ele. A vinculação é uma closure local: o dispatcher captura, o
   dispatcher confere.
3. **Nunca é reemitida.** Mesmo princípio da concessão do microfone (5.2B): um
   identificador reciclado ressuscitaria uma autorização morta.

A sequência de decisão saiu do componente para
[`lib/helo-agent-dispatch.ts`](../lib/helo-agent-dispatch.ts) — mesmo movimento
que `openAgentSession` na 5.1A, e pelo mesmo motivo: **o defeito mora numa
sequência**, e enquanto ela viver dentro do React a única forma de testá-la é
reescrevê-la no teste. Um teste que reescreve o código prova que a cópia está
correta.

```
1. resolver a ação no registry VIVO
2. gate de classe (R-02)        ← patientResponse e sensitive param aqui
3. a ação está habilitada?
4. autorizar no servidor        ← round-trip: centenas de ms
5. o LEASE ainda vale?          ← a correção da 5.3C
6. a ação AINDA é a mesma?      ← cobre remount, modal fechado, lista recarregada
7. só então: o efeito
```

O passo 5 é o que faltava. O passo 6 não é redundante: a geração cobre rota,
paciente, sessão e usuário; não cobre uma tela que desmontou por outro motivo.

## 5. O que invalida

| Evento | Invalida? | Como |
|---|---|---|
| troca de rota (client-side) | ✅ | geração avança |
| troca de paciente | ✅ | geração avança |
| troca de sessão clínica | ✅ | geração avança |
| logout | ✅ | `clearLocalMirrors` + navegação de página inteira |
| desmontagem do provider | ✅ | `encerraContextoDoAgent()` |
| ação sai do registry | ✅ | passo 6 |
| remount da tela (mesmo id, instância nova) | ✅ | passo 6 — identidade, não id |
| recarga de página | ✅ | fronteira **mais forte**: todo o contexto JS morre |

## 6. O que **não** invalida

| Evento | Invalida? | Por quê |
|---|---|---|
| render | ❌ | a comparação é por valor de primitivo |
| array de ações recriado | ❌ | idem |
| callback com referência nova | ❌ | idem |
| publicar o mesmo contexto de novo | ❌ | `defineContextoDoAgent` devolve `false` |

Isto não é detalhe: é a lição da regressão de desempenho da 5.3B escrita como
código. Cem publicações idênticas não movem o contador — provado na suíte, e
medido na tela real (dez leituras seguidas, mesma geração).

## 7–8. Pré-execução e o commit depois do `await`

O dispatcher cobre da chegada do pedido até o **começo** do efeito. O que
acontece depois de um `await` **dentro** do handler só o handler alcança — por
isso ele recebe `__aindaVale()` no payload.

### A primeira versão desta seção estava incompleta

Ela afirmava que só o handler de espera humana tinha commit contextual depois
de um `await`, e que os demais eram cobertos pelo desmonte da tela. A auditoria
final das **25 ações executáveis pelo Agent**, feita antes da aprovação da
fase, mostrou que a segunda metade da frase era falsa em três casos: a troca de
paciente **não desmonta** `/conversa`, `/rotina` nem `/atividades`, e a
continuação antiga chega depois do efeito de reset — e vence.

São **quatro** caminhos com commit contextual pós-`await`, não um.

| # | Handler | Espera | O que comete depois | Guarda |
|---|---|---|---|---|
| — | `activity.goToActivityMenu` | modal, tempo **humano** | `endRun` grava | ✅ desde a 5.3C |
| **L1** | `conversa.comecar` | POST `/api/sessions` | `logEvent` **persistido** + TTS | ✅ `guardaDeContexto` |
| **L2** | `routine.open.*` | `ensureSession()` | `logEvent` **persistido** | ✅ `guardaDeContexto` |
| **L3** | `atividades.iniciar.*` | POST `/api/activities/runs` | `setView` **abre o player** | ✅ `guardaDeContexto` |

As demais 21 ações não têm janela: 16 não têm `await` no handler; 4 (`perguntas.pausar`,
`perguntas.retomar`, `perguntas.conversaPorOpcoes`, `perguntas.controlesDoPaciente`)
esperam uma escrita que **é** o commit, autorizada pelo dispatcher no instante
anterior, e o que vem depois é estado local que morre com a remontagem;
`helo.solicitarMicrofone` espera `getUserMedia` e depois só desliga as trilhas
que ela mesma abriu. `helo.conectar` revalida por conta própria desde a 5.1A.

### A guarda, e o que ela deliberadamente não faz

`guardaDeContexto(payload)` — em `lib/helo-agent-context.ts`, ao lado do lease.
Não é um mecanismo novo: é a **mesma geração**. Quando o pedido veio do Agent
ela reaproveita o verificador que o dispatcher injetou (o lease do instante em
que a tool chegou, mais antigo e portanto mais exigente); quando veio do dedo
de alguém, captura o lease de agora. **A corrida é a mesma para os dois**,
porque quem a abre é o tempo de rede, não a origem do pedido — e por isso os
três handlers ficaram protegidos nos dois caminhos.

O que ela **não** faz é desfazer. Um efeito remoto já legitimamente commitado
antes da mudança permanece: a sessão de A e a execução de A foram criadas com
autorização válida, e apagá-las seria inventar um rollback que o produto não
tem. O que a guarda bloqueia é a **continuação** — o registro, a fala, a
apresentação.

### Quais fronteiras invalidam cada um dos três

A resposta é a mesma para os três, e é essa a razão de não haver exceção por
tela: a guarda é o contexto inteiro, não um campo escolhido a dedo.

| Fronteira | L1 | L2 | L3 | por quê |
|---|:--:|:--:|:--:|---|
| troca de rota | ✅ | ✅ | ✅ | `rota` é um dos quatro primitivos |
| troca de paciente | ✅ | ✅ | ✅ | `pacienteId` — é a fronteira que motivou tudo |
| troca de sessão clínica | ✅ | ✅ | ✅ | `sessaoId`; nas três telas ele é sempre `null` (só as perguntas em tempo real o publicam), então na prática nenhuma delas muda de sessão sem antes mudar de rota |
| logout | ✅ | ✅ | ✅ | `usuarioId` cai para `null`; e o logout do produto ainda leva a página inteira, que é uma fronteira mais forte |

Uma tela nova não precisa declarar nada: a geração já cobre as quatro. Foi por
isso que a correção não criou tratamento por tela — o mecanismo genérico
resolvia, e criar exceções teria sido inventar um segundo lugar onde a regra
pode divergir.

### Um defeito irmão, de causa diferente, encontrado ao provar L2

`/rotina` guardava a sessão numa **referência**, e a referência atravessava a
troca de paciente. Com o contexto **já válido em B**, `ensureSession()` devolvia
na hora a sessão de A, e o registro seguinte casava a sessão de A com o paciente
B. Nenhuma guarda de lease pega isso: não há espera onde o mundo mude — o mundo
já mudou, e o que ficou foi a lembrança. A correção é esquecer a sessão quando o
paciente troca (`app/(palco)/rotina/page.tsx`), e a prova é a requisição: abrir
um card depois da troca precisa **criar uma sessão nova**.

O mesmo padrão existia em `/conversa`, e era pior. Está fechado — §7c.

## 7c. A conversa pertence a UMA pessoa

Trocar de paciente no meio de uma conversa guiada deixava tudo na tela. A
auditoria, estado por estado, do que atravessava a troca:

| Estado | Atravessava? | O que significava |
|---|:--:|---|
| `sessionId` | **sim** | os eventos seguintes caíam na sessão de A |
| `phase`, `nodeId`, `batch`, `history` | **sim** | a pergunta de A continuava na tela de B |
| `ctx` | **sim** | o contexto acumulado de A (com quem falar, o quê) |
| `confirm` | **sim** | a frase composta de A, exibida como citação |
| `aiOptions` | **sim** | sugestões formuladas a partir do PERFIL de A |
| `marks`, `paused`, `starting`, `startError` | sim | estado de condução de A |
| `pathLog`, `rejectedLog`, `shownAt` (refs) | **sim** | o caminho de A, que alimenta a IA |
| `confirmedPhrase` (ref) | **sim** | **o pior**: `{texto, messageId}` da mensagem JÁ confirmada de A — e `conversa.repetirMensagemPaciente` a faria soar **na voz do paciente** com B na tela |
| `people` | não | já havia efeito em `[patientId]` |

Nenhum deles dependia de `patientId`. A tela inteira era de A e não sabia.

### A política

> **Ao trocar o paciente ativo, `/conversa` começa em contexto limpo.**

Implementada com a **chave de remontagem**, não com uma lista de campos para
zerar — uma lista é onde se esquece um, e foram doze. O React descarta o estado
inteiro de uma vez e a tela volta ao **seu próprio** estado inicial: nenhuma UI
nova, nenhum redirecionamento.

A chave conta **trocas**, não o paciente. Uma chave derivada de `patientId`
remontaria a tela também na carga direta da rota, quando o paciente fica
conhecido depois do primeiro render — e essa remontagem faria o Agent receber
`CONTEXT_EXPIRED` (corretamente: a ação teria mesmo saído do registry) por um
pedido legítimo. Contando trocas, a primeira vez não é uma troca.

### O que acontece com o que já existia

**A sessão de A não é encerrada, nem apagada, nem marcada como concluída.** Ela
nasceu autorizada e permanece dela, como qualquer sessão aberta e não concluída
— o mesmo que já acontecia ao sair da tela. Trocar de paciente não é concluir
uma conversa, e inventar esse lifecycle aqui seria decidir por quem cuida.
Medido: depois de A → B → A, o servidor tem duas sessões de A e uma de B, cada
uma com o seu dono.

**Voltar para A também é um começo limpo.** O produto não tem retomada de
conversa, e esta correção não inventou uma: o requisito é isolamento, não uma
funcionalidade nova.

### O que a remontagem não alcança

Uma promessa já em voo. A closure dela não morre com o componente, e três
lugares desta tela falam ou apresentam depois de esperar:

| Onde | Espera | Guarda |
|---|---|---|
| `onConfirmGesture` → `saveMessage().then()` | POST `/api/messages` | não tenta falar na voz do paciente |
| `trySuggestions` | POST `/api/suggest` | não apresenta nem anuncia sugestões feitas para outra pessoa |
| `uncertain` → `setTimeout(…, 400)` | temporizador | a pergunta de A não soa depois da troca |

A mesma `guardaDeContexto` de L1, L2 e L3. Nenhuma arquitetura nova.

### Defesa em profundidade, medida

Ao instrumentar o teste, o navegador revelou uma proteção que já existia:
`lib/useSpeech.ts` **recusa** uma fala com `speakerRole: "patient"` cujo
`patientId` não seja o ativo. Ela funcionava — sem a guarda nova, a fala tardia
era tentada e bloqueada ali.

As duas camadas são diferentes e as duas importam: a de cima impede a
**tentativa**, a de baixo impede o **som**. O teste distingue as duas de
propósito e afirma que a de baixo **não precisou entrar em ação** — se um dia
precisar, é sinal de que a de cima falhou.

### Uma precondição que faltava aos testes do Agent

A regressão completa acusou `agent-lifecycle` §1 duas vezes — e o lote passava
**6 de 6** isolado. O rastro deu a resposta sem margem para palpite:

```
{"ok":false,"error":"Paciente ativo não selecionado"}
```

`authorizeTool` exige um paciente ativo antes de qualquer coisa, e a tela da
Rotina aparece **antes** disso: o cabeçalho e os cards não dependem do
paciente. O teste disparava a tool no vão entre as duas coisas. A recusa estava
certa; a precondição do teste é que estava errada — e só sob carga o vão ficava
largo o bastante.

Os dois specs passaram a esperar o seletor de pacientes do cabeçalho, que só
renderiza depois de `/api/patients` responder, estritamente **depois** de o
provider ter lido o paciente ativo. Nada foi afrouxado: passou-se a esperar a
condição que o produto já exige. A mesma fragilidade latente existia nos três
testes novos de `/rotina`, e foi corrigida junto.

### Um churn que custava caro ao Agent

`registryActions` desta tela dependia de `displayOptions`, que era um array
**novo a cada render**. O Action Registry inteiro renascia continuamente, e o
dispatcher — que depois de autorizar no servidor confere se a ação ainda é *a
mesma* — devolvia `CONTEXT_EXPIRED` para pedidos legítimos sempre que qualquer
render caísse dentro do round-trip (a chegada da rede de pessoas, por exemplo).
A recusa estava certa; errado era a tela mudar de identidade sem ter mudado de
nada.

`displayOptions` passou a ser memoizado e a ação de começar ganhou memo próprio
— ela não depende de nada da conversa. É a lição de churn da 5.3B outra vez, e
aqui o custo não era desempenho: era confiabilidade do Agent. Medido no lote: o
controle positivo de L1 caiu de **17,1 s para 2,4 s**.

## 9–13. As fronteiras, uma a uma

**Rota** — ação da tela anterior recusada; medido com navegação client-side
real, pela própria tool do Agent. **Paciente** — troca durante o round-trip:
zero efeito no paciente antigo, zero no novo. **Sessão** — troca com o mesmo
paciente invalida. **Logout** — nenhuma capacidade local sobra, e um pedido
antigo não ressuscita nada. **Reconnect** — nasce do contexto atual: o lease é
capturado por chamada, nunca guardado entre sessões.

**A navegação que a própria ação causa continua legítima.** Validar vem
*antes* do efeito; depois que a ação válida navega, a rota nova é consequência
dela — não motivo para desfazê-la.

## 14. Agent persistente

A conversa sobrevive à navegação quando o assistente persistente está ligado.
**A autoridade não.** Medido: cinco navegações client-side seguidas, cada uma
com geração nova, e a cada passo as ações da tela anterior recusadas.

O transcript pode lembrar que a conversa passou pela Rotina; isso não permite
executar uma ação da Rotina depois que o cuidador está em Conversar.

## 15–18. Microfone, STT, TTS, Emergência

Nada foi alterado. A posse única do microfone (5.2B), a separação do ditado
(5.2), a prioridade de áudio (5.1B) e a Emergência continuam como estavam —
revalidados por `test:dictation:coordination` (111) e pela recusa de
`emergencia.item.*` medida na tela real.

## 19–20. Offline, visibilidade

Não foi implementado suporte offline para o Agent, e não era o escopo. O
comportamento atual: a queda de rede derruba a sessão pelo `onDisconnect` do
SDK, o teardown libera o microfone, e uma reconexão posterior captura o
contexto de então. Uma ação de contexto vencido continua recusada depois do
retorno, porque o lease é conferido no momento da execução, não no da
descoberta.

## 21. Chamada duplicada

Medido com duas chamadas concorrentes à mesma ação de abrir um card: nenhum
efeito duplo observável. Não foi criada deduplicação global — abrir um card é
idempotente, e as ações operacionais restantes ou são idempotentes ou têm
guarda própria (`connect()` tem reentrância desde a 5.1A).

## 22–24. R-08 — fechado localmente

O SDK oferece duas roles: `user` e `agent`. Não inventamos roles que ele não
tem, e **não sobrescrevemos** o dado externo.
[`lib/helo-authorship.ts`](../lib/helo-authorship.ts) acrescenta uma camada
local ao lado dela:

| Origem real | `providerRole` | `source` (Helo) | É fala do paciente? |
|---|---|---|---|
| voz no microfone da sessão | `user` | `caregiverVoice` | **não** |
| campo "Mensagem para a Helo" | `user` | `caregiverText` | **não** |
| gesto do paciente relatado pelo cuidador | `user` | `patientGestureReport` | **não** — é uma observação *sobre* ele |
| instrução interna de leitura | `user` | `systemInstruction` | **não** |
| a Helo | `agent` | `agent` | **não** |

Quatro chamadas espalhadas a `sendUserMessage` viraram **uma porta**:
`enviaAoAgent(source, conteúdo)`. A origem é argumento obrigatório.

O comentário que chamava a entrada do microfone de *"patient speech"* foi
corrigido — e o log que dizia isso também. Quem fala ao microfone daquela
sessão é o cuidador: ele abriu a conversa, na tela dele, com o dispositivo que
escolheu.

**Autoria não é autoridade.** Nenhuma origem torna uma ação executável: a
decisão continua sendo só do gate, sobre a classe.

**Transcript:** não é persistido em lugar nenhum, não executa ação nenhuma, e
não aparece em log. O que o turno recebido faz é zerar o contador de silêncio.

## 25. Prefixos legados

Os prefixos em português continuam saindo no texto — o system prompt do painel
não foi auditado e pode depender deles. Eles vivem **isolados** em
`helo-authorship.ts`, e a semântica interna não depende deles: apagá-los não
mudaria uma linha de decisão dentro do Helo. É esse o critério de fechamento
local do R-08.

## 26. CONFIGURAÇÃO EXTERNA NÃO VERIFICADA

| Item | Risco se divergir | Contrato local esperado | Conferir no painel? |
|---|---|---|---|
| nomes das tools | o Agent chama um nome que não existe | 8 nomes registrados, incluindo 5 aliases legados | **sim** |
| nomes dos parâmetros | `actionId` não chega | 7 nomes aceitos | **sim** |
| system prompt | pode descrever o payload antigo (`localElements`) | `route`/`screen`/`capabilities`/`humanOnly` | **sim** |
| interpretação dos prefixos de origem | o Agent pode confundir observação com fala do paciente | `source` local resolve isso do lado do Helo | **sim** |
| `description` das tools | pode instruir a pedir o impossível | contrato de capacidades da 5.3B | **sim** |
| regras de tool calling | `humanOnly` pode ser ignorado | contagem, não lista | **sim** |
| Knowledge Base | pode conter dado clínico fora deste caminho | — | **sim** |
| modelo, voz, idioma, First Message | R-12 e a voz oficial | `dynamicVariables` | **sim** |

**Nenhum alias legado foi removido.** Não sabemos o que o painel usa, e remover
às cegas quebraria a integração em produção.

## 27–28. Testes

| Suíte | Antes | Depois |
|---|---:|---:|
| `test:agent:gate` | 53 | **53** |
| `test:agent:invariants` | 21 | **23** |
| `test:agent:inventory` | 41 | **42** |
| `test:agent:capabilities` | 47 | **47** |
| `test:agent:context` | — | **49** (novo) |
| `test:agent:authorship` | — | **36** (novo) |
| `test:agent:lifecycle` | 33 | **33** |
| `test:agent:teardown` | 12 | **12** |
| `test:dictation:coordination` | 111 | **111** |
| `test:authorship` | 53 | **53** |
| `test:voice:grant` | 32 | **32** |
| `test:e2e-sync` | 34 | **34** |
| `test:eleven-guard` | 46 | **46** |
| `test:agent:stale` | — | **53** (novo, L1/L2/L3) |
| Playwright `agent-lifecycle` | — | **8** (novo lote) |
| Playwright `agent-async-stale` | — | **12** (novo lote: L1/L2/L3 + `/conversa`) |

Os aumentos em `invariants` (+2) e `inventory` (+1) são asserções novas sobre a
sequência de despacho, não afrouxamento: três tripwires dispararam quando a
sequência mudou de arquivo, e foram **reapontados para onde a propriedade
agora vive**, não removidos.

### Como o lote novo é determinístico

Nenhum dos nove testes tenta ganhar a corrida na sorte. A resposta do servidor
é interceptada e **segurada**: a requisição sai, o servidor responde de
verdade, e a entrega ao handler fica presa até o teste soltá-la. A sequência é
sempre a mesma — o handler começa, a resposta fica pendente, o contexto muda, a
resposta é liberada, e só então a asserção. Nenhum `sleep` faz um teste passar.

Cada caso negativo tem o **controle positivo** ao lado: mesma espera, sem
trocar nada. Sem ele, uma correção que simplesmente matasse as três
funcionalidades também passaria em todas as asserções negativas.

E a suíte foi verificada contra si mesma: com a guarda **neutralizada**, os
quatro casos negativos falham e os quatro controles positivos passam. Ela é
sensível ao defeito, não à sua ausência.

## 29. Performance

O contador só avança em mudança de valor de primitivo — a proteção não pode
repetir o defeito de churn da 5.3B. Medido na tela real: dez leituras
consecutivas, mesma geração. E na suíte: cem publicações idênticas, contador
parado.

## 30. Limitações residuais

1. **O lote `agent-lifecycle` roda em modo dev**, porque os dois ganchos de
   inspeção não existem em produção. A alternativa seria instrumentar o produto
   em produção — pior troca.
2. ~~**O guarda cobre até o começo do efeito.** Um commit depois de um `await`
   interno depende de o handler perguntar; só o de espera humana o faz hoje.~~
   **FECHADO.** A auditoria das 25 mostrou que a segunda metade da afirmação
   original — "os demais são cobertos pelo desmonte da tela" — era falsa em três
   casos. L1, L2 e L3 foram corrigidos; os quatro caminhos com commit contextual
   pós-`await` estão listados no §7–8, todos com guarda declarada. O estado de
   tela que sobrevivia à troca de paciente em `/conversa` — doze campos,
   incluindo a frase já confirmada — foi fechado no §7c.
3. **A geração é por contexto de JS.** Uma recarga a reinicia — o que é seguro
   (a recarga é uma fronteira mais forte), mas significa que ela não distingue
   duas abas.
4. **O system prompt do painel não foi verificado.** Se ele instrui o Agent a
   insistir depois de um `CONTEXT_EXPIRED`, a experiência degrada — a segurança
   não.
5. **Sem suporte offline para o Agent**, por decisão: não era o escopo.

## 30a. Um defeito preexistente que a regressão final revelou

A regressão completa da 5.3C fechou em 259/260. O falho era
`voz-ditado.spec.ts › o texto ditado sobrevive ao refresh` — e **não era desta
fase**.

### O que foi medido, e não suposto

| Ponto da árvore | Falhas (caso isolado) |
|---|---|
| 5.3C | **1 / 10** |
| 5.3B (`2395339`, worktree limpa) | 1 / 5 |
| **5.2C (`c01eea3`, worktree limpa)** | **1 / 10** |

Mesma taxa no fim da 5.2C — o ponto onde a regressão 245/245 verde foi
registrada. A 5.3C não alterou a frequência nem o comportamento.

Duas instrumentações temporárias deram a causa:

- envolvendo `IDBObjectStore.prototype.put`, a gravação do rascunho **era
  disparada em 6 de 6 execuções**, na store `rascunhos`, antes da recarga —
  inclusive nas que falhavam;
- instrumentando a hidratação, a execução que falha recebe `{}`.

Entre "gravação disparada" e "gravação guardada" existe uma transação, e a
recarga a interrompia. **Não era corrida de escrita: era a transação não
commitada.**

### Por que apareceu agora

O ditado escreve o campo inteiro de uma vez e o teste recarrega logo depois. O
teclado leva mais tempo para chegar ao mesmo ponto. O `voz-ditado` não causou o
defeito — ele o alcançou primeiro.

### A correção (autorizada como bloqueador de fechamento)

`lib/offline/use-offline-session.ts`, no mecanismo **compartilhado** de
rascunho — o mesmo para texto digitado e para `VOICE_TRANSCRIPTION`:

| | Antes | Agora |
|---|---|---|
| primeira alteração | esperava 300 ms num `setTimeout` | vai ao disco **imediatamente** |
| alterações seguintes | reiniciavam o temporizador | coalescidas: uma em voo, uma pendente |
| ordem | nenhuma garantia | sequência monotônica por chave |
| saída da página | nada | `pagehide` / `visibilitychange` escoam a cauda |

Os quatro estados passaram a ser distintos: **pendente**, **em voo**, **não
confirmada**, **confirmada**.

A descarga na saída é **segunda linha de defesa, não a correção**: nenhum
navegador promete concluir uma transação começada durante o teardown. A
correção é não existir mais um intervalo em que o texto só vive na memória.

### Custo e prova

77 teclas em 14,5 s → **2 escritas** (0,03 por tecla). O debounce anterior
produziria 1; a segunda é exatamente a durabilidade comprada.

- caso original: **20 execuções isoladas, 0 falhas** (antes: 1 em 10);
- `voz-ditado` completo: **5 × 36 = 180/180**;
- suíte causal nova `rascunho-persistencia`: **10/10**, incluindo os casos que
  precisam continuar apagando (limpar o campo, outro paciente, novo login);
- offline: armazenamento 49, projeção 103, origem 48, fila 105, conflitos 111,
  decisões 72, sync-endpoints 27, idempotência 34 — todas verdes.

Nenhum teste ganhou espera artificial entre a alteração e a recarga: é essa
janela que eles existem para exercitar.

### O segundo falho da regressão

`sem conexão o ditado some` também falhou uma vez na regressão completa, e
**não reproduziu** em nenhuma das ~60 execuções da investigação. Não afirmo que
tenha a mesma causa. Ficou registrado, e a regressão final o reexecuta.

## 30b. A matriz de confiança da Fase 5.3

Cada linha responde a uma pergunta: **por que acreditamos que é verdade?**

| # | Invariante | Prova | Suíte | Resultado |
|---|---|---|---|---|
| 1 | O Agent não executa `patientResponse` | o gate decide pela CLASSE, não pelo texto; 52 formas de pedido — alias, emoji, idioma, id remontado, gesto no payload — todas recusadas | `test:agent:gate` | 53 ✓ |
| 2 | O Agent não executa `sensitive` | mesma decisão; inclui `dialog.confirm`, logo ele não confirma a própria confirmação | `test:agent:gate`; `agent-lifecycle` §5 | 53 ✓ · 8 ✓ |
| 3 | O DOM não concede autoridade | a descoberta não lê `button/a`, não lê `textContent`, não lê campo de formulário | `test:agent:inventory` | 42 ✓ |
| 4 | R-09 continua fechado | marcador clínico escrito em 4 lugares da tela; ausente do payload, asserido nos dois sentidos | `agent-contexto` §4 | 7 ✓ |
| 5 | A capacidade depende do contexto atual | o payload é montado do registry vivo a cada chamada | `test:agent:capabilities`; `agent-lifecycle` §3 | 47 ✓ · 8 ✓ |
| 6 | Rota vencida falha fechado | troca de rota durante o round-trip → `CONTEXT_EXPIRED`, handler não chamado | `test:agent:context` | 49 ✓ |
| 7 | Paciente vencido falha fechado | troca de paciente durante o round-trip → zero efeito em A e em B | `test:agent:context` | 49 ✓ |
| 8 | Sessão vencida falha fechado | troca de sessão com o mesmo paciente invalida | `test:agent:context` | 49 ✓ |
| 9 | Logout invalida | contexto encerrado; nenhuma capacidade local; pedido antigo não ressuscita | `test:agent:context`; `agent-lifecycle` §7 | 49 ✓ · 8 ✓ |
| 10 | Reconnect nasce do contexto atual | o lease é capturado por chamada, nunca guardado entre sessões | `test:agent:context`; `test:agent:lifecycle` | 49 · 33 ✓ |
| 11 | **Assíncrono vencido não comita — nos QUATRO caminhos** | os 4 handlers com commit contextual pós-`await` conferem a guarda antes do efeito; auditados um a um contra as 25 executáveis, e a ordem (captura → conferência → efeito) é verificada estruturalmente | `test:agent:stale`; `test:agent:context` | 53 ✓ · 49 ✓ |
| 11a | L1 — a conversa de A não começa em B | resposta de `/api/sessions` **segurada**, troca de paciente no meio, resposta liberada: zero `logEvent`, zero TTS, a tela não sai da fase de introdução | `agent-async-stale` §5 | 9 ✓ |
| 11b | L2 — o card de A não registra em B | idem com `ensureSession()`: zero `logEvent` | `agent-async-stale` §7 | 9 ✓ |
| 11c | L3 — a atividade de A não abre em B | idem com `/api/activities/runs`: o player não abre, a lista de B continua sendo a de B — pelo pedido do Agent **e** pelo clique do cuidador | `agent-async-stale` §1, §3 | 9 ✓ |
| 11d | A correção não matou as três funcionalidades | controle positivo ao lado de cada caso: mesma espera, sem trocar nada — a conversa começa e registra, o card registra, o player abre | `agent-async-stale` §2, §6, §8 | 9 ✓ |
| 11e | Os testes reprovam sem a correção | com a guarda neutralizada, os 4 casos negativos falham e os 4 controles positivos passam — a suíte é sensível ao defeito, não à sua ausência | controle negativo executado | 4 ✗ / 5 ✓ |
| 11f | A sessão de rotina não atravessa a troca de paciente | o defeito irmão (referência, não `await`): abrir um card depois da troca **cria uma sessão nova**, contado na requisição | `agent-async-stale` §9; `test:agent:stale` | 12 ✓ · 53 ✓ |
| 11g | **A conversa de A não fica na tela de B** | conversa em andamento, troca real pelo seletor: a tela volta ao estado inicial, o nome é o de B, a pergunta e o contexto de A somem, nenhuma mensagem é criada, nenhuma fala do paciente é tentada — e B começa a conversa dele com sessão **nova** | `agent-async-stale` §10 | 12 ✓ |
| 11h | A gravação de A que chega depois não faz a voz do paciente soar | a resposta de `/api/messages` é segurada, o paciente troca, a resposta é liberada: a continuação **nem tenta** falar — e a recusa de fundo em `useSpeech` não precisou entrar em ação | `agent-async-stale` §11 | 12 ✓ |
| 11i | Voltar ao primeiro paciente não mistura os dois | A → B → A: começo limpo dos dois lados, e no servidor duas sessões de A e uma de B, cada uma com o seu dono | `agent-async-stale` §12 | 12 ✓ |
| 11j | Os testes de `/conversa` reprovam sem a correção | com a chave neutralizada os três falham; com só a guarda da fala neutralizada, o §11 falha sozinho — as duas peças são medidas separadamente | controle negativo executado | 3 ✗ · 1 ✗ |
| 12 | O Agent persistente atualiza capacidades | 5 navegações client-side; ação de cada tela anterior recusada | `agent-lifecycle` §3 | 8 ✓ |
| 13 | O transcript não concede autoridade | não é persistido, não executa ação, não aparece em log | `test:agent:authorship` | 36 ✓ |
| 14 | `providerRole` não define autoria | `role: user` → `source: caregiverVoice`, com a role preservada | `test:agent:authorship` | 36 ✓ |
| 15 | Voz do cuidador não é fala do paciente | `ehFalaDoPaciente` é falso para as cinco origens | `test:agent:authorship` | 36 ✓ |
| 16 | Texto do cuidador não é fala do paciente | idem; "responda SIM" continua `caregiverText` e a ação continua recusada | `test:agent:authorship` | 36 ✓ |
| 17 | O microfone tem um dono só | concessão indivisível, id monotônico, liberação atrasada é no-op | `test:dictation:coordination` | 111 ✓ |
| 18 | O Agent não conflita com o ditado | bloqueio nos dois sentidos, inclusive durante a transcrição em voo | `test:dictation:coordination` | 111 ✓ |
| 19 | A Emergência mantém prioridade | `emergencia.item.*` é `sensitive` e recusada na tela real; a supressão de áudio segue da 5.1B | `agent-lifecycle` §5 | 8 ✓ |
| 20 | As rotas globais continuam fechadas | 9 entradas, sem handler, path literal; `/admin` e `javascript:` recusados | `test:agent:inventory`; `agent-lifecycle` §4 | 42 ✓ · 8 ✓ |
| 21 | Conteúdo dinâmico não eleva autoridade | rótulos `dialog.confirm`, `SIM`, `/admin`, `javascript:` continuam `operational` com id estruturado | `test:agent:capabilities` | 47 ✓ |
| 22 | Chamada duplicada não duplica efeito inseguro | duas chamadas concorrentes: um card aberto, não dois | `agent-lifecycle` §8 | 8 ✓ |
| 23 | O registry não churna por render | 100 publicações idênticas, contador parado; 10 leituras na tela real, mesma geração | `test:agent:context`; `agent-lifecycle` §1 | 49 ✓ · 8 ✓ |
| 24 | Nenhuma chamada real à ElevenLabs | a guarda neutraliza a chave antes de o processo nascer; as client tools são funções locais | `test:eleven-guard` | 46 ✓ |
| 25 | A autoridade não aumentou | 47 ações, distribuição intacta: navigation 9 + operational 16 = **25** executáveis, sensitive 12, patientResponse 10 | `test:agent:invariants` | 23 ✓ |
| 26 | A guarda não duplica lógica | um só leitor de `__aindaVale` (`leaseDoPayload`), uma só guarda (`guardaDeContexto`); nenhum dos quatro handlers reimplementa a leitura | `test:agent:stale` | 53 ✓ |
| 27 | A guarda não recusa por nada | 100 republicações idênticas do mesmo contexto e ela continua valendo; render não é mudança de autoridade | `test:agent:stale` | 53 ✓ |

### A propriedade que a matriz sustenta

**ASYNC STALE → ZERO COMMIT CONTEXTUAL.** As 25 ações executáveis pelo Agent,
somadas:

| | quantas | por que é seguro |
|---|---|---|
| sem `await` no handler | **15** | não existe janela |
| `await` com efeito posterior local ou autocontido | **5** | estado do componente, que morre com a remontagem; ou trilhas que a própria ação abriu |
| commit contextual depois do `await`, **revalidado** | **5** | `activity.goToActivityMenu` e L1/L2/L3 pela guarda de lease; `helo.conectar` pela sua própria, da 5.1A |
| **lacuna real** | **0** | — |

E o isolamento entre pacientes, que é a outra metade do critério: nenhuma das
três telas com estado de conversa — `/conversa`, `/rotina`, `/atividades` —
apresenta ou executa contexto de A depois que o paciente ativo passou a ser B.

## 31. Pendências da 5.4

- logs do Agent (A-09): `[HELO TOOL] interactWithHeloUI called` ainda imprime o
  objeto `parameters` no console do navegador;
- `Cache-Control` e rate limiting nos dois endpoints (A-10);
- remoção do caminho morto de override de voz e das 4 variáveis órfãs
  (A-07 / R-12);
- R-04 e R-07 (música);
- conferência do painel da ElevenLabs e, só então, remoção dos aliases legados.
