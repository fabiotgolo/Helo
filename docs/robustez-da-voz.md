# Robustez da voz — memória, prazos e recuperação

Fase 5.1B · fechamento

A 5.1A respondeu **quem pode fazer a voz do paciente falar**. Esta fase responde
uma pergunta diferente e menos glamourosa: **o que acontece quando dá errado**,
e o que sobra na memória depois.

Nada aqui enfraquece a 5.1A. A autoria, o SpeechGrant e o bloqueio das ações
`patientResponse` são base congelada — ver
[modelo-de-confianca-voz.md](modelo-de-confianca-voz.md).

---

## Os quatro defeitos

| | O que acontecia | O que acontece agora |
|---|---|---|
| **R-06** | Cada fala criava um `ObjectURL` e nenhum era revogado. O cache crescia enquanto a aba vivesse; trocar de paciente e sair não soltavam nada | Todo URL tem dono e quatro pontos de liberação. Cache com limite |
| **R-10** | `fetch` para a ElevenLabs sem prazo nenhum. Um provedor lento prendia o handler — e a instância, que é uma só | Prazo explícito em cada chamada, com categoria de falha distinta |
| **R-11** | Uma 503 marcava `elevenAvailable = false` **pelo resto da vida da aba**. Só recarregar a página trazia a voz de volta | Indisponibilidade com prazo. Recupera sozinha na fala seguinte |
| **R-13** (parte) | Um `requestAnimationFrame` media amplitude a 60 quadros por segundo em toda tela, com ou sem sessão | Nasce com a sessão, morre com ela |

---

## Arquitetura do cache

```
   speak() / prime()
         │
         ▼
  buscaAudioDaFala ──── acerto ────► AudioCache
  (speech-audio-source)                  │
         │  falta                        │ dono do ObjectURL
         ▼                               │ LRU · fixação · purga
   grant → /api/tts ──── Blob ───────────┘
```

| | |
|---|---|
| **Onde mora** | [`lib/voice/audio-cache.ts`](../lib/voice/audio-cache.ts) — fora do React, para ser dirigido por teste de domínio |
| **Chave** | `helo\|\|<texto>` ou `patient\|<id>\|<texto>` (de `audioCacheKey`) |
| **Limite** | **32 entradas**, LRU |
| **Despejo** | No `set`, enquanto houver excedente; sempre a usada há mais tempo |
| **Revogação** | Substituição · despejo · purga · desmontagem. **Nunca** enquanto toca |
| **Persistência** | Nenhuma. Nada de IndexedDB ou Cache API |

### Por que 32

O maior conjunto pré-aquecido de uma vez é o da Emergência: 5 frases padrão
mais as personalizadas do paciente — algo como 15 no pior caso realista. 32
mantém esse conjunto inteiro e ainda deixa 17 de margem para as falas da
plataforma e da conversa. Em bytes é pouco: uma frase curta em mp3 fica na casa
das dezenas de KB, então o teto está na ordem de 2 MB por aba.

**A tensão que o número não resolve.** Uma conversa longa pode gastar 32
entradas e despejar o áudio da Emergência que havia sido pré-aquecido — e o
pré-aquecimento existe justamente para a rede cair depois. O que segura essa
ponta é que entrar na Emergência **re-aquece**: o efeito depende das ações e do
paciente. Se a rede já estiver fora nesse momento, a frase cai no fallback
aprovado do navegador, que é o comportamento projetado para esse caso. Aumentar
o limite adiaria o problema sem eliminá-lo; a recuperação por re-aquecimento
elimina.

### Contagem de referências

Quando o servidor devolve um texto diferente do que a tela pediu — e ele manda,
pela 5.1A —, a **mesma** entrada é indexada sob duas chaves. Revogar na saída da
primeira deixaria a segunda apontando para um URL morto: o cache acertaria e o
áudio não tocaria. Por isso quem é revogado é o URL, quando a última chave que o
alcança sai.

### A fixação

A entrada que está tocando é `fixa`da e não é despejada. Se o limite for
atingido e a fixada for a única candidata, o cache **prefere passar do limite**
a revogar um áudio em reprodução — cortar a fala de alguém no meio é pior que
segurar uma entrada a mais por alguns segundos. A soltura mora em
`setSpeakingBoth(false)`, que é o caminho de saída de **toda** fala: concluída,
interrompida, bloqueada, com erro ou por exceção.

### Isolamento entre pacientes

Não é uma checagem — é a chave. Mesmo texto, pacientes diferentes, chaves
diferentes. Trocar de paciente chama `purgePatient()`, que remove o áudio de
paciente e preserva o da plataforma (que não é de ninguém em particular).

**Uma sutileza de ordem que custou um defeito.** O React roda os efeitos dos
**filhos antes** dos do provider de paciente. A Emergência pré-aquece o áudio no
próprio efeito; uma liberação incondicional no provider jogaria fora, logo em
seguida, exatamente o que a tela acabou de pedir. Duas consequências no código:

1. a liberação só acontece na **troca** (`anterior != null && anterior !== novo`),
   nunca na definição inicial;
2. a liberação **não** aborta o aquecimento em curso — ele pertence ao paciente
   **novo**. Quem recolhe o aquecimento obsoleto é o próprio `prime`, que
   confere o paciente ativo a cada volta.

---

## Cancelamento

`stop()` faz duas coisas, e as duas são necessárias:

| | O quê | Por quê |
|---|---|---|
| **Abortar** | `AbortController` derruba a requisição | Sem isso o servidor termina de sintetizar (e cobrar) um áudio que ninguém vai ouvir |
| **Invalidar** | A geração avança; `aindaVale()` passa a ser falso | O abort é uma corrida contra a rede. A invalidação é local e não pode perder |

Depois de **cada** `await` o resultado é reconferido. Uma resposta que chega
depois do cancelamento ainda **entra no cache** — o áudio é legítimo, foi
autorizado para aquele paciente e aquele texto, e guardá-lo é o que impede o
ObjectURL de ficar órfão. O que ela não faz é tocar.

`speak` e `prime` têm donos de cancelamento **separados**. Com um só, o
aquecimento em segundo plano sobrescreveria o da fala e o `stop()` seguinte
abortaria a requisição errada.

---

## Prazos (R-10)

| Chamada | Prazo | Forma |
|---|---|---|
| `/api/tts` → ElevenLabs | 15 s | Até os **cabeçalhos** |
| Token da conversa | 10 s | **Total** |
| Consulta de voz (Admin) | 8 s | **Total** |
| Síntese de frase (Functions) | 20 s | **Total** |
| Composição de música (Functions) | — | **Sem prazo**, ver abaixo |

### Por que o TTS é diferente

`AbortSignal.timeout` derruba a requisição inteira, corpo incluído. Para um JSON
curto é o que se quer. Para o TTS não: a resposta é o áudio, repassado ao
navegador enquanto chega. Um prazo total cortaria a voz do paciente no meio de
uma frase — trocaríamos uma espera por uma fala truncada, que é pior, porque
parece que a pessoa disse outra coisa.

**Limitação assumida:** um corpo que trava no meio da transmissão não é coberto.
Cobri-la exigiria um watchdog por chunk, e o preço de errar esse watchdog é
cortar a fala de alguém.

**Música sem prazo:** a composição demora minutos por natureza (até 300 segundos
de áudio). Um prazo mal calibrado abortaria uma geração legítima. Fica para uma
fase que meça a distribuição real de duração antes de escolher o número.

### Categorias

`timeout` · `network` · `unauthorized` · `rateLimited` · `serverError` ·
`rejected` · `badResponse`

A distinção existe para quem opera: **um timeout que se apresenta como 401 manda
procurar uma credencial que está perfeitamente boa.**

Ao cliente, a categoria vira status:

- **503** — `timeout`, `serverError`, `rateLimited`, `network`. Transitórios, e
  só eles abrem o prazo de espera do lado do navegador.
- **502** — `unauthorized`, `rejected`. O provedor está no ar e recusou.

---

## Recuperação (R-11)

```
disponivel  ──falha transitória──►  degradado (30 s)
     ▲                                    │
     └────── sucesso ◄──── tentativa permitida após o prazo
```

**Não há polling.** Nada tenta sozinho. Passado o prazo, a **próxima** fala que
alguém pedir passa; se funcionar, volta tudo ao normal; se falhar, começa um
novo prazo. O custo de sondar a recuperação é pago por uma ação que já ia
acontecer.

**O que não conta como indisponibilidade:** 400, 401, 403, 422 — e este é o
ponto. Essas falam sobre o **pedido**: um grant ausente, vencido ou de outro
paciente, uma voz não aprovada. Tratá-las como "ElevenLabs fora do ar"
desligaria a voz da aba por causa de uma autorização recusada, que é o
contrário do que a recusa quer dizer — ali o provedor está disponível e o
sistema está funcionando como projetado.

A indisponibilidade é reiniciada no logout: quem entra depois não herda o prazo
de espera de quem saiu.

---

## AudioContext

| Momento | O quê |
|---|---|
| Primeira fala | Criado junto com o elemento de áudio (`createMediaElementSource` é irrevogável — são um par) |
| Antes de tocar | `resume()`, aguardado |
| 5 s ocioso | `suspend()`, se nada estiver tocando |
| Desmontagem | `close()`, e as refs do par são zeradas para uma remontagem reconstruir |

Suspender no ocioso **não cria caminho de falha novo**: o navegador já suspende
contextos inativos por conta própria, e o caminho de volta (`resume` aguardado
antes do `play`) já existia e é exercitado a cada fala. O que mudou foi só a
hora — passou a ser nossa.

---

## rAF de medição

O laço que mede a amplitude do Agente rodava a 60 quadros por segundo desde a
montagem do provider até a aba fechar, medindo o áudio de uma sessão que na
maior parte do tempo não existe. O provider vive em toda a aplicação: era
trabalho contínuo em toda tela.

Agora o efeito depende do `status` do SDK e retorna cedo em `"disconnected"`. É
a dependência que garante um único laço vivo por vez — o React cancela o quadro
pendente e reinicia na transição.

Ao encerrar, a amplitude volta a **`null`**, e não a `0`: `getStageAmplitude`
(em `lib/helo-state.tsx`) só cai na amplitude da voz da **plataforma** quando
este valor é nulo. Deixar `0` congelaria o orbe mudo durante toda fala da
plataforma.

**Fora do escopo:** o laço de render 3D do `orb-stage` continua como está. Ele é
animação visual, não medição.

---

## Estado da fala

Ao final de **qualquer** caminho, o `finally` de `speak` roda e
`setSpeakingBoth(false)` zera junto: `speaking`, `activeSpeaker`,
`activeVoiceSource` e a fixação do cache. Um estado zerado pela metade é pior
que nenhum.

`stop()` é idempotente — incrementa a geração antes de tudo, então toda fala em
voo passa a não valer e as que já não valiam continuam sem valer.

`getAmplitude()` devolve `0` assim que `speakingRef` é falso, sem depender de
ninguém zerar nada.

---

## O defeito que só o navegador pegou

```ts
const fetchImpl = deps.fetchImpl ?? fetch;   // ❌
```

Guardado numa variável e chamado como `fetchImpl(...)`, o `this` do `fetch`
deixa de ser a `window` e o navegador recusa com **`Illegal invocation`**. Toda
fala do paciente morria antes de sair.

**O Node não se importa com o `this`.** As três suítes de domínio passavam
verdes. Quem pegou foi
[tests/e2e/voz-robustez.spec.ts](../tests/e2e/voz-robustez.spec.ts), rodando num
Chromium de verdade — e essa é a justificativa inteira para a camada de
navegador existir, dita por um caso concreto em vez de por princípio.

`test:audio:lifecycle` passou a exigir o `.bind` estruturalmente.

---

## Como isto é verificado

| Suíte | O que prova |
|---|---|
| `npm run test:audio:cache` | O cache se comporta: LRU, fixação, purga, contagem de referências, nenhum órfão |
| `npm run test:voice:cancel` | Cancelamento e recuperação, contra o código de produção com a rede simulada |
| `npm run test:voice:timeout` | Prazos, categorias de falha e ausência de vazamento em log |
| `npm run test:audio:lifecycle` | Que o **produto** usa esses módulos, nos pontos certos do ciclo de vida |
| `npm run test:ui:lotes -- voz-robustez` | O navegador de verdade: ObjectURL, logout, troca de paciente, abort |

`npm run test:5.1b` roda as quatro de domínio. Nenhuma chama a ElevenLabs.

---

## Pendências registradas

| O quê | Por que ficou |
|---|---|
| Corpo de resposta travado no meio da transmissão do TTS | Exigiria watchdog por chunk; errar o número corta a fala de alguém |
| Prazo na composição de música (Functions) | Demora minutos por natureza; falta medir a distribuição real antes de escolher |
| Corpo cru da ElevenLabs no log da geração de música | R-07 fora do recorte de TTS desta fase |
| Prévia de frase favorita | **Sem bypass de autoria** (auditada e medida no fechamento da 5.1B); o que segue aberto é a decisão de produto e a mensagem de erro que a tela mostra ao cuidador — ver [modelo-de-confianca-voz.md](modelo-de-confianca-voz.md) |
