# Ditado do cuidador (Fases 5.2A e 5.2B)

> **Speech-to-text dictation is implemented but production-disabled while the
> Helo ElevenLabs workspace does not support Zero Retention Mode.**

O cuidador pode preencher quatro campos de texto falando em vez de digitando.
É tudo o que esta fase faz. Ela **não** cria um canal de resposta do paciente,
não dá voz a ele, não interpreta intenção e não aciona nada sozinho.

A regra que organiza o resto do documento:

```
voz do cuidador → transcrição → rascunho → revisão humana
→ ação manual explícita → fluxo normal já existente
```

A **5.2A** construiu esse caminho. A **5.2B** não acrescentou capacidade
nenhuma: ela endureceu o que existia contra concorrência, ciclo de vida,
respostas atrasadas, perda de rede, perda de dispositivo e conteúdo forjado.
As seções marcadas *(5.2B)* descrevem o que mudou e por quê.

---

## 1. Estado em produção

| | |
|---|---|
| Workspace ElevenLabs | **Grant Tier 2** |
| Zero Retention Mode | recurso **Enterprise** — indisponível no plano atual |
| `HELO_VOICE_DICTATION_ENABLED` em produção | **`false`**, e deve permanecer |
| Consequência | o botão de ditar não existe na tela; nenhum áudio sai do aparelho |

A ElevenLabs confirmou que requisições com `enable_logging=false` não são
aceitas no plano atual. Isso não é uma incógnita a ser descoberta em produção:
é a razão de a fase entregar o recurso pronto e desligado.

**Retenção normal não é fallback permitido.** Não existe variável para
desligar a exigência, não existe segunda tentativa sem ela, e ligar o ditado
num ambiente sem retenção zero confirmada é uma decisão que precisa ser
tomada por alguém, não herdada de um `catch`.

Para habilitar no futuro, os dois precisam ser verdadeiros ao mesmo tempo:

1. o workspace suporta retenção zero, **confirmado**;
2. `HELO_VOICE_DICTATION_ENABLED=true` no ambiente.

---

## 2. Arquitetura, e por que não a outra

```
navegador                          servidor Helo                 ElevenLabs
─────────                          ─────────────                 ──────────
getUserMedia + MediaRecorder
  ↓ Blob em memória
POST /api/voice/dictation  ──────► autentica
  x-helo-patient-id                requirePatientAccess
                                   flag                          POST /v1/speech-to-text
                                   MIME + bytes          ──────►   ?enable_logging=false
                                   prazo 30s             ◄──────  { text }
  ◄────────────────────────────── { transcript }
texto no campo (rascunho)
```

O SDK instalado (`@elevenlabs/client` 1.15) traz `useScribe`, que abre um
WebSocket do navegador direto para a ElevenLabs, com parciais ao vivo. **Não é
o que usamos**, e o motivo não é preferência: nesse desenho o Helo sai do
caminho, e sair do caminho significa não conseguir exigir autenticação, nem
teto de bytes, nem retenção zero — que o `ScribeHookOptions` sequer expõe.

O preço é não ter transcrição parcial. Está assumido conscientemente: o estado
`PROCESSING` cobre a espera, e para uma frase de duas linhas o ganho de ver
palavras aparecendo não paga uma conexão direta de áudio clínico a um terceiro.

### O que sai, o que chega, o que fica

| | |
|---|---|
| Sai do navegador | o Blob de áudio, o `patientId` (em cabeçalho) |
| Chega ao servidor | o mesmo Blob, em memória, dentro do handler |
| Chega à ElevenLabs | o áudio, `model_id=scribe_v2`, `language_code=por` |
| **Nunca** chega à ElevenLabs | `patientId`, nomes, `sessionId`, diagnóstico, contexto, grant, metadado clínico |
| Fica em algum lugar | **nada de áudio** — só o texto, e só na política de rascunho que o campo já tinha |

---

## 3. Áudio bruto: onde ele não está

Não é persistido em Firestore, IndexedDB, `localStorage`, `sessionStorage`,
Cache API, Firebase Storage, `OfflineOperation` nem arquivo temporário. Não
vira `ObjectURL` — não há o que reproduzir, porque o cuidador acabou de falar.

Depois da captura: trilhas do `MediaStream` paradas, `MediaRecorder` solto,
pedaços e Blob sem dono, referências limpas. Um refresh nunca restaura áudio
nem o estado `LISTENING`.

O teardown roda em **toda** saída: parar, cancelar, erro, teto de 60s,
desmontar, trocar de paciente, trocar de sessão e logout.

---

## 4. Limites

| O quê | Valor | Onde | Por quê |
|---|---|---|---|
| Duração de uma captura | 60 s | `DURACAO_MAXIMA_MS` | 60 s ≈ 150 palavras ≈ 900 caracteres; o maior campo aceita 500, então o relógio nunca corta uma pergunta legítima — ele existe para o microfone esquecido aberto |
| Tamanho aceito no servidor | 2 MiB | `TAMANHO_MAXIMO_BYTES` | 60 s a 32 kbps ≈ 240 KB; Safari, que ignora o bitrate pedido, ≈ 480 KB. Quatro vezes o pior caso, e independente do cronômetro — que vive no navegador |
| Prazo da chamada ao provedor | 30 s | `PRAZO_TRANSCRICAO_MS` | prazo **total**, não até os cabeçalhos: a resposta é um JSON curto lido inteiro no servidor. O oposto do TTS, que transmite |
| Formatos aceitos | `audio/webm`, `audio/ogg`, `audio/mp4` | `TIPOS_DE_AUDIO_ACEITOS` | exatamente o que Chrome/Edge, Firefox e Safari produzem. `codecs=` é aceito; qualquer outro parâmetro reprova; o `filename` nunca é consultado |
| Tamanho de uma transcrição | 4 000 caracteres | `TAMANHO_MAXIMO_TRANSCRICAO` *(5.2B)* | 60 s de fala ≈ 900 caracteres. Acima do teto a resposta não é truncada, é recusada — texto clínico cortado no meio é pior que ausente |

### Negociação de formato e conferência de conteúdo *(5.2B)*

O formato é escolhido por `MediaRecorder.isTypeSupported`, mas o `Blob` é
montado com o `mimeType` que o gravador **realmente** produziu: pedir um formato
não é o mesmo que recebê-lo, e o Safari costuma ignorar o pedido. Rotular um MP4
como `audio/webm` faria o próprio Helo ser recusado pelo próprio Helo, agora que
o servidor confere a assinatura.

E o servidor confere. A 5.2A acreditava no `Content-Type` declarado no
multipart — campo de texto escrito pelo cliente. Um cliente que não seja o Helo
escreve `audio/webm` e envia o que quiser, e o que ele enviar sairia para a
ElevenLabs com a chave do Helo. Agora lemos doze bytes
([`lib/voice/audio-container.ts`](../lib/voice/audio-container.ts)):

| Contêiner | Assinatura | Onde |
|---|---|---|
| WebM / Matroska | `1A 45 DF A3` (EBML) | byte 0 |
| Ogg | `4F 67 67 53` (`OggS`) | byte 0 |
| MP4 / ISO-BMFF | `66 74 79 70` (`ftyp`) | byte 4 |

Declaração e assinatura têm de **concordar**. Um WebM legítimo declarado como
`audio/mp4` não é um navegador confuso: é alguém procurando de qual dos dois
lados o Helo decide. Não é um parser de mídia e não deve virar um — não lemos
duração, faixas nem codec, nada que exija percorrer o arquivo.

Ao atingir o teto de tempo a captura encerra, o que foi gravado é transcrito e
o cuidador é avisado. Descartar puniria quem falou demais perdendo tudo.

---

## 5. Os quatro campos

| Campo | Onde | Limite |
|---|---|---|
| Pergunta livre (escrever e editar) | `ComposeScreen` | 500 |
| Interpretação do cuidador | `InterpretationEditor` | 500 |
| Frase da mensagem em construção | `StatementEditor` | 500 |
| Título/pergunta do nível | `NodeEditor` | 300 |

Fora, deliberadamente: rótulos de opção e frase final da opção (campos curtos
numa lista repetida — um microfone por linha encheria a tela), contexto da
sessão, seletor de pessoas, e tudo o que a fase já exclui (login, senhas,
busca, administração, nomes, configurações, respostas do paciente, conflitos,
comandos do Agent).

**A transcrição entra pelo mesmo `onChange` que o teclado usa.** Daí para
baixo, um texto falado e um digitado são indistinguíveis para o resto do
produto — e é isso que garante que o botão de submissão continue sendo o único
gatilho funcional.

A transcrição **acrescenta** ao que já está no campo em vez de substituir.
Substituir apagaria, sem aviso, o que o cuidador digitou antes de falar, num
momento em que ele está olhando para o paciente e não para a tela. Transcrição
vazia não encosta no campo: "não entendi" não pode virar "apagou o que você
escreveu".

**E o que não cabe não entra** *(5.2B)*. A 5.2A cortava no `maxLength` e
avisava. Cortar produz uma frase que termina no meio, apresentada a alguém que
só pode responder SIM ou NÃO — e o corte só aparece depois de o botão
"Continuar" já ter sido apertado, porque quem ditou estava olhando para o
paciente. Agora o campo fica exatamente como estava e o cuidador é avisado:
ele encurta, apaga o que não quer, ou dita em duas partes.

---

## 6. `VOICE_TRANSCRIPTION`

Ativado em **um** lugar: `ConversationQuestionTurn.questionSource`, na pergunta
livre. É o único ponto do domínio onde o enum existe, com `originalText` já
modelado para receber a transcrição antes da revisão.

Os outros três campos não têm campo de procedência no modelo, e **nenhum foi
criado** — inventar proveniência em três coleções para uniformizar estruturas
seria mexer em muito mais do que a fase pede.

A origem descreve **como o texto entrou**. Não significa autoria do paciente,
confirmação, consentimento, maior confiança nem menor necessidade de revisão.

```
originalText  = as transcrições BRUTAS, em ordem, unidas por espaço
reviewedText  = o que o cuidador submeteu depois de reler
```

### O sentido exato de `VOICE_TRANSCRIPTION` *(5.2B)*

A 5.2A marcava como ditada qualquer pergunta em que uma transcrição tivesse
entrado, e guardava em `originalText` o campo inteiro depois da voz. Parece
razoável até o caso mais comum aparecer: o cuidador digita `"Dona Ana,"`,
percebe que é mais rápido falar o resto, e dita. A pergunta inteira ia para o
prontuário como transcrição de voz, incluindo as palavras que a pessoa escreveu
com as mãos — uma afirmação falsa num registro clínico, e do tipo que ninguém
confere depois.

A 5.2B fixa o sentido:

> `VOICE_TRANSCRIPTION` = **esta pergunta nasceu de uma transcrição**.
> Não: "em algum momento houve voz neste campo".

| Caso | Resultado |
|---|---|
| campo vazio, primeiro conteúdo por voz | `VOICE_TRANSCRIPTION`, `originalText` = transcrição bruta |
| já havia texto digitado quando a voz chegou | `MANUAL_TEXT`, para sempre — e sem `originalText` |
| nasceu por voz, depois foi editada à mão | continua voz; `originalText` não muda |
| nasceu por voz, outro ditado antes de submeter | `originalText` ganha a nova transcrição bruta |
| campo esvaziado | procedência apagada; a próxima entrada decide de novo |

`originalText` guarda só o que a voz produziu. As edições manuais ficam no
`reviewedText`, e a diferença entre os dois **é** o registro de que houve
revisão — misturar os dois faria o campo mentir exatamente onde ele existe para
não mentir.

Não guardamos cronologia de teclas. Isto é tudo que o produto precisa saber.

`assertTurnInvariants` recusa `originalText` numa pergunta com origem
`MANUAL_TEXT`: sem isso o campo viraria espaço livre para guardar qualquer
coisa como "o que foi dito".

### Offline

Uma pergunta ditada **com** rede e submetida **sem** rede preserva a origem: a
operação enfileirada carrega `questionSource` e `originalText`, e
`construirTurno` deixou de fixar `MANUAL_TEXT`. Uma origem desconhecida na fila
(schema antigo, gravação truncada) cai para o padrão em vez de reprovar a
invariante e travar a sincronização inteira do cuidador.

### Refresh

O marcador de origem **não** é persistido junto do rascunho. Depois de um
refresh o texto volta, mas nada garante que ele ainda seja o que a voz
produziu — e afirmar procedência a mais é pior que afirmar a menos. Uma
pergunta restaurada é registrada como digitada. É uma limitação assumida, na
direção segura.

---

## 7. A fronteira com o Agent Helo e com o TTS

### Um único dono do microfone *(5.2B)*

A 5.2A arbitrava com dois booleans consultados de longe, e isso tem um defeito
estrutural. `connect()` do Agent consultava "o ditado está ativo?", ouvia não, e
saía para pedir o token e negociar o WebRTC; só segundos depois marcava a
própria ocupação. Nesse intervalo o ditado consultava "o Agent está ativo?",
ouvia não, e abria o microfone. Os dois com razão, os dois dentro.

A 5.2B substituiu a consulta por uma **posse tomada**, em
[`lib/voice/mic-ownership.ts`](../lib/voice/mic-ownership.ts):

```
NONE
DICTATION_REQUESTING · DICTATION_LISTENING · DICTATION_PROCESSING
AGENT_CONNECTING     · AGENT_ACTIVE
```

`adquireMicrofone` é síncrona e indivisível: ou devolve uma concessão, ou
devolve `null`. Não há estado intermediário observável, então dois cliques
simultâneos são necessariamente sequenciais e o segundo encontra o microfone
tomado. Os dois lados adquirem no **primeiro** instante — o ditado antes do
diálogo de permissão, o Agent antes de pedir o token.

`DICTATION_PROCESSING` conta como ocupação apesar de o microfone já estar
fechado: existe uma transcrição em voo que ainda pode escrever num campo, e o
Agent não pode entrar antes disso terminar. Caso contrário o cuidador estaria
conversando com a Helo quando um texto aparecesse sozinho na tela, vindo de um
áudio gravado antes.

### A concessão tem identidade

O defeito simétrico da 5.2A era mais silencioso: `setDictationActive(false)` era
global, e qualquer saída atrasada — resposta de rede antiga, `onstop` de um
gravador esquecido, desmontagem de um campo já abandonado — soltava o dono
**atual**, que podia ser outra pessoa.

Agora cada concessão carrega um `id` que nunca se repete, e liberar exige
apresentá-lo. Uma concessão vencida é aceita, não faz nada e devolve `false`.
O cenário canônico, testado: A adquire → A libera → B adquire → o release
atrasado de A chega → **B continua dono**.

### Agent × ditado, as regras

| Situação | Resultado |
|---|---|
| Agent `CONNECTING` | ditado recusado |
| Agent `ACTIVE` | ditado recusado |
| ditado `REQUESTING` / `LISTENING` / `PROCESSING` | Agent recusado |
| falha ao iniciar, desconexão, erro, desmontagem | posse devolvida |
| callback atrasada de qualquer um dos lados | não solta o dono novo |

O Agent **não** derruba o ditado sozinho, e o ditado **não** derruba o Agent.
Quem chegou primeiro fica; o segundo lê *"Encerre a conversa com a Helo antes
de usar o ditado."* — ou o simétrico — e decide.

A devolução do lado do Agent é **derivada do estado real**
(`starting || restarting || connecting || connected`), não marcada em cada
handler: encerrar, cair, falhar ao conectar e errar no meio da conversa são
caminhos diferentes que chegam todos ao mesmo lugar. Uma posse presa seria um
ditado que não abre mais, sem explicação nenhuma na tela.

### Emergência do paciente durante o ditado *(5.2B)*

O caso extremo da regra acima, e o único em que a captura é interrompida por
alguém que não é o cuidador. A emergência tem prioridade máxima no produto: um
botão de emergência que pudesse ser bloqueado por um campo de texto não seria um
botão de emergência.

Ela **cancela** o ditado — não o "para". A distinção decide se um pedaço de
áudio clínico sai do aparelho:

```
parar pela mão do cuidador  → "terminei de falar" → monta o Blob e transcreve
interrupção por emergência  → "isto aqui acabou"  → descarta tudo
```

Meia frase gravada não é uma pergunta. O que acontece, em ordem:

1. `beginPatientVoiceOverride()` chama `stopAllDictation()` **antes** de liberar
   o áudio da emergência;
2. cada captura montada recebe `cancela` → `encerra`;
3. `encerra` marca `encerrada = true` **antes** de `gravador.stop()`;
4. o `onstop` chega depois — assíncrono, como no `MediaRecorder` real — encontra
   a guarda `vigente` falsa e sai sem montar Blob e sem chamar `envia`;
5. requisição abortada, trilhas paradas, pedaços soltos, posse devolvida;
6. nenhum `POST /api/voice/dictation`, nenhum transcript, nenhuma proveniência
   alterada — o campo fica exatamente como o cuidador o deixou;
7. o áudio da emergência então toca.

Se a bandeira subisse **depois** do `stop()`, o próprio teardown produziria um
upload. É a ordem que garante o resultado, e é ela que os testes prendem.

### TTS × captura *(5.2B)*

O microfone aberto capta o que estiver soando na sala, inclusive a Helo. O caso
que dói é a voz clonada do **paciente** tocando enquanto o cuidador começa a
ditar: o transcript sairia com a fala dele dentro, num campo que o cuidador vai
revisar como texto próprio.

Duas regras, nas duas direções:

- **Áudio da Helo tocando → o microfone não abre.** A fala em curso **não** é
  interrompida; o cuidador é convidado a esperar. Não existe fila: a intenção
  de ditar não fica guardada para disparar sozinha depois.
- **Capturando → nenhuma fala automática começa.** `canPlatformSpeak()` devolve
  `dictation_capturing`, e falas negadas continuam sendo **descartadas**, como
  todas as outras negativas desse gate.

A exceção é a **emergência do paciente**, que tem prioridade máxima no produto e
não pode ser bloqueada por um campo de texto. Ela **encerra** a captura — áudio
descartado, nada enviado — em vez de tocar por cima dela. É o oposto de deixar
as duas coisas coexistirem: a voz do paciente nunca entra num transcript.

Quem está soando é registrado por instância (`setPlatformSpeaking`), não
contado: um `stop()` chamado duas vezes deixaria um contador preso e o ditado
nunca mais abriria.

### O que o transcript continua não podendo fazer

O transcript **não** entra na conversa do Agent, não vira `role="user"`, não é
enviado a ele, não dispara client tool, não passa pelo action registry e não é
interpretado como comando. `lib/voice/mic-ownership.ts` arbitra dispositivo e
não conhece paciente, sessão nem texto.

**TTS.** Nenhuma relação. O ditado não pede `SpeechGrant`, não chama
`/api/tts`, não resolve `voiceId` e não produz voz de ninguém. `test:dictation:authorship`
verifica termo a termo que os módulos do ditado não tocam nesses caminhos.

**Autoria.** `VOICE_TRANSCRIPTION` **jamais** produz `ConfirmedPatientStatement`.
Não por verificação: o portão de autoria só aceita
`OptionConversationFinalStatement`, e o tipo que carrega `questionSource` nem
é avaliável por ele. Um turno ditado forjado com `status: CONFIRMED`,
`confirmedResponse: "YES"` e texto apresentado não passa.

O caso crítico testado exaustivamente: o cuidador dita **"sim"**, **"talvez"**
ou **"não"**. As três viram texto no campo e nada mais — não chamam
`gesto.confirmar`, `gesto.reformular` nem `gesto.recusar`, não escolhem opção,
não respondem, não criam `patientResponse` nem `SpeechGrant`.

---

## 8. Offline

Sem conexão o botão desaparece e o campo de digitação continua idêntico. Nada
é capturado para enviar depois, nenhum áudio é armazenado, nenhuma
`OfflineOperation` de áudio existe. Se a conexão cair durante o processamento,
a captura encerra com segurança e o cuidador é informado — sem rascunho
inventado nem parcial sem identificação.

Depois que um transcript final virou texto no campo, ele passa a obedecer à
política de rascunhos da Fase 4.9, sem alteração nenhuma naquela arquitetura:
o texto sobrevive ao refresh, o áudio nunca, o estado `LISTENING` nunca.

---

## 9. Estados e erros

```
IDLE → REQUESTING_PERMISSION → LISTENING → PROCESSING → DRAFT_READY
                            ↘ PERMISSION_DENIED
                            ↘ ERROR
UNAVAILABLE  (recurso desligado, sem conexão, navegador sem gravação)
```

Categorias: `PERMISSION_DENIED`, `NO_DEVICE`, `DEVICE_LOST`, `UNSUPPORTED`,
`OFFLINE`, `BACKGROUNDED`, `MIC_OCUPADO`, `TIMEOUT`, `PROVIDER_UNAVAILABLE`,
`EMPTY_TRANSCRIPT`, `CANCELLED`, `UNKNOWN`.

### Saídas de captura acrescentadas na 5.2B

| Evento | O que acontece |
|---|---|
| aba escondida (`visibilitychange` → hidden) ou `pagehide` | captura cancelada, áudio parcial descartado, **nada enviado**; voltar não retoma |
| rede cai durante `LISTENING` | captura cancelada, áudio descartado, sem fila e sem envio posterior |
| rede cai durante `PROCESSING` | requisição abortada; a volta da rede **não** reenvia |
| trilha termina sozinha (aparelho arrancado) | captura cancelada — a 5.2A transcrevia o parcial, que devolve meia pergunta sem dizer que é meia |
| duplo clique | guarda **síncrona**: uma execução, um `getUserMedia`, um gravador, um POST |

Gravar em background é a forma mais direta de o Helo virar um aparelho de
escuta: o indicador do navegador fica numa aba que ninguém está olhando, e a
conversa que continua na sala não tem nada a ver com o campo de texto. Por isso
sumir da vista encerra, e voltar não retoma — recomeçar é decisão do cuidador.

O cuidador nunca lê stack, status HTTP, corpo da ElevenLabs, id interno,
token, "Enterprise", "retenção" ou nome de configuração. Quase toda mensagem
lembra que dá para digitar, porque é a informação que desbloqueia a pessoa.
`test:dictation:domain` verifica isso mensagem por mensagem.

---

## 10. Logs

Registrados: rótulo do ponto de uso, categoria da falha, status. Nunca: áudio,
transcript clínico, `FormData`, corpo devolvido pelo provedor, chave. Uma
recusa 4xx do provedor rende uma linha extra dizendo que a exigência de
retenção zero estava no pedido — para quem lê o log não confundir com uma
credencial errada.

---

## 11. Verificação

| Suíte | O que prova |
|---|---|
| `npm run test:dictation:domain` | limites, formatos, a transcrição no campo, mensagens sem jargão |
| `npm run test:dictation:retention` | a flag, a exigência de retenção zero em toda chamada, falha fechada sem retentativa, ausência de persistência de áudio, logs limpos |
| `npm run test:dictation:authorship` | transcript nasce rascunho, SIM/TALVEZ/NÃO são texto, `VOICE_TRANSCRIPTION` jamais vira fala confirmada, a origem sobrevive à transição offline |
| `npm run test:5.2a` | as três acima |
| `npm run test:dictation:coordination` | posse única e indivisível, release atrasado sem efeito, as oito regras Agent × ditado, 100 ciclos sem posse pendurada, e cada saída de captura da §5.2B presente no código |
| `npm run test:dictation:content` | assinatura de contêiner, coerência com o tipo declarado, tetos de tamanho, e resposta do provedor conferida como estrutura |
| `npm run test:dictation:provenance` | os cinco casos de proveniência mista, a origem atravessando o caminho offline, e a invariante que recusa `originalText` em pergunta digitada |
| `npm run test:5.2b` | as três acima |
| `npm run test:dictation:endpoint` | o endpoint por fora, contra um provedor de mentira local: autorização antes do corpo, 415/413/400, 429/500/403, uma única chamada por gravação, `Cache-Control: no-store` |
| `npm run test:eleven-guard` | a guarda que impede uma suíte de subir um servidor com a chave real da ElevenLabs |
| lote `voz-ditado` | 36 jornadas de navegador com provedor e microfone simulados — incluindo duplo clique, Agent conectando, áudio tocando, resposta atrasada, aba escondida, rede caindo durante a gravação |

### Como subir um servidor para as suítes HTTP *(5.2B)*

Use o launcher, nunca um `next dev` digitado à mão:

```
npm run dev:teste -- --porta 3510 --banco suite-http
npm run dev:teste -- --porta 3540 --banco dit --ditado    # para o endpoint de ditado
```

O `--ditado` liga a flag e declara uma chave falsa, apontando o provedor para
`http://127.0.0.1:4599/v1/speech-to-text` — o servidor de mentira que a própria
suíte levanta.

**Por que existe um launcher.** Um `npx next dev` digitado à mão foi o que
produziu o único incidente desta fase: o `next dev` lê o `.env`, o `.env` deste
projeto tem a chave de PRODUÇÃO, e `test-voice-authorization` — a suíte que
existe para provar que uma fala não autorizada é recusada — atravessou a
autorização nos casos legítimos e sintetizou quatro frases de verdade. A chave
não vem de quem roda o teste: vem de um arquivo que o framework lê sozinho, e
nenhum comando de teste a menciona. Não dá para lembrar de neutralizar o que
não se vê.

Agora a decisão é tomada num lugar só, em
[`scripts/eleven-guard.mjs`](../scripts/eleven-guard.mjs), antes de qualquer
processo nascer:

| Situação | Resultado |
|---|---|
| chave real herdada do ambiente ou do `.env` | **neutralizada** (string vazia) |
| chave declarada por um lote e reconhecível como de teste | passa |
| chave declarada que pode ser real | **recusa**, com o servidor ainda no chão |
| `HELO_ALLOW_LIVE_ELEVENLABS_TESTS=true` | libera, com aviso no terminal |

A neutralização é por string **vazia** e não por remoção: `@next/env` só
preenche o que ainda não existe em `process.env`, então o `.env` é lido e
ignorado para essa chave. Do lado do produto, `provedorConfigurado()` faz
`Boolean(...)` — vazio é falso, e o caminho percorrido é exatamente o de "sem
chave", que é o que as suítes esperam.

O `npm run dev` normal **não** foi tocado: ele é o preview manual, roda com a
chave real de propósito, e a chave continua no `.env` do usuário.
`npm run test:eleven-guard` exercita os quatro casos sem abrir processo, subir
servidor ou tocar a rede — provar que a guarda funciona não pode exigir a
chamada real que ela existe para impedir.

`HELO_DICTATION_PROVIDER_BASE` **só é lida fora de produção**, e isso é o ponto:
uma variável capaz de desviar a voz de um cuidador em produção seria uma
exfiltração com uma linha de configuração. `urlDoScribe` continua sendo a única
forma de montar a URL, e ela sempre acrescenta `enable_logging=false`.

O lote Playwright sobe um servidor com o ditado ligado e uma chave
**intencionalmente inválida**: o `POST` é interceptado na aba e nunca chega ao
servidor; se um dia chegar, morre num 401 sem custo e com o teste vermelho.

---

## 12. Limitações residuais

1. **O recurso está desligado em produção** e assim fica até o workspace
   suportar retenção zero. É o item principal.
2. **Sem parciais ao vivo** — decisão consciente da arquitetura em lote.
3. **A origem por voz não sobrevive a um refresh** do rascunho (§6).
4. **Só o campo 1 registra procedência**; os outros três recebem o texto sem
   marcar como ele entrou.
5. ~~A validação de formato confia no `Content-Type` declarado~~ — **fechada na
   5.2B**: o servidor lê a assinatura do contêiner e exige coerência com o tipo
   declarado.
6. **Rótulos de opção e frases finais da opção não têm ditado** — cabem numa
   fase seguinte, se alguém pedir.
7. **O corpo da resposta do provedor tem prazo total, mas não watchdog por
   chunk** — a resposta é um JSON curto lido inteiro sob o mesmo orçamento de
   30 s, então o problema do TTS não se repete aqui. Está descrito em
   [`docs/robustez-da-voz.md`](robustez-da-voz.md).
8. **A verificação de contêiner é de assinatura, não de conteúdo** — doze bytes
   provam que é um WebM, não que dentro dele há fala. Deliberado: um parser
   completo de mídia seria uma superfície de ataque maior que a que ele fecha.

---

## Referências no código

| Onde | O quê |
|---|---|
| [`lib/voice/dictation.ts`](../lib/voice/dictation.ts) | limites, formatos, estados, `aplicaTranscricao` |
| [`lib/voice/dictation-server.ts`](../lib/voice/dictation-server.ts) | a flag e a chamada com retenção zero |
| [`lib/voice/use-dictation.ts`](../lib/voice/use-dictation.ts) | captura, teardown, ligação ao campo |
| [`app/api/voice/dictation/route.ts`](../app/api/voice/dictation/route.ts) | o único ponto por onde áudio de microfone passa |
| [`lib/voice/mic-ownership.ts`](../lib/voice/mic-ownership.ts) | a posse do microfone: aquisição indivisível, concessão com identidade |
| [`lib/voice/audio-container.ts`](../lib/voice/audio-container.ts) | assinatura de contêiner e coerência com o tipo declarado |
| [`lib/audio-coordinator.ts`](../lib/audio-coordinator.ts) | quem está soando, gate da fala da plataforma, teardown global do ditado |
| [`docs/modelo-de-confianca-voz.md`](modelo-de-confianca-voz.md) | o que o Helo prova e o que não prova sobre voz |
