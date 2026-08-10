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

Handlers Agent-executáveis com espera relevante, mapeados:

| Handler | Espera | Commit | Guarda |
|---|---|---|---|
| `activity.goToActivityMenu` | **modal, tempo humano** | `endRun` grava | ✅ `__aindaVale` |
| `activity.goToManageActivities` | idem | idem | ✅ (é `sensitive`, inalcançável — a guarda existe pelo caminho humano compartilhado) |
| `atividades.iniciar.*` | POST | `setView` | componente desmonta com a troca |
| `perguntas.*` | POST | estado local | idem |
| `helo.conectar` | WebRTC | sessão | guardas próprias da 5.1A |
| `routine.open.*`, `routine.backToMenu` | — | estado local | não há await |

A espera do modal é a única de tempo **humano** — segundos a minutos — e é a
única onde o commit é uma gravação. É lá que a guarda foi aplicada.

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
| Playwright `agent-lifecycle` | — | **8** (novo lote) |

Os aumentos em `invariants` (+2) e `inventory` (+1) são asserções novas sobre a
sequência de despacho, não afrouxamento: três tripwires dispararam quando a
sequência mudou de arquivo, e foram **reapontados para onde a propriedade
agora vive**, não removidos.

## 29. Performance

O contador só avança em mudança de valor de primitivo — a proteção não pode
repetir o defeito de churn da 5.3B. Medido na tela real: dez leituras
consecutivas, mesma geração. E na suíte: cem publicações idênticas, contador
parado.

## 30. Limitações residuais

1. **O lote `agent-lifecycle` roda em modo dev**, porque os dois ganchos de
   inspeção não existem em produção. A alternativa seria instrumentar o produto
   em produção — pior troca.
2. **O guarda cobre até o começo do efeito.** Um commit depois de um `await`
   interno depende de o handler perguntar; só o de espera humana o faz hoje.
   Os demais são cobertos pelo desmonte da tela, o que é uma proteção *de
   efeito colateral*, não declarada. Está listado no §7–8.
3. **A geração é por contexto de JS.** Uma recarga a reinicia — o que é seguro
   (a recarga é uma fronteira mais forte), mas significa que ela não distingue
   duas abas.
4. **O system prompt do painel não foi verificado.** Se ele instrui o Agent a
   insistir depois de um `CONTEXT_EXPIRED`, a experiência degrada — a segurança
   não.
5. **Sem suporte offline para o Agent**, por decisão: não era o escopo.

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
| 11 | Assíncrono vencido não comita | `__aindaVale()` antes do `endRun` do modal | `test:agent:context` | 49 ✓ |
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

## 31. Pendências da 5.4

- logs do Agent (A-09): `[HELO TOOL] interactWithHeloUI called` ainda imprime o
  objeto `parameters` no console do navegador;
- `Cache-Control` e rate limiting nos dois endpoints (A-10);
- remoção do caminho morto de override de voz e das 4 variáveis órfãs
  (A-07 / R-12);
- R-04 e R-07 (música);
- conferência do painel da ElevenLabs e, só então, remoção dos aliases legados.
