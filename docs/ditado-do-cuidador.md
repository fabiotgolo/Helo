# Ditado do cuidador (Fase 5.2A)

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
originalText  = o campo inteiro no instante em que a voz terminou de escrever
reviewedText  = o que o cuidador submeteu depois de reler
```

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

**Agent.** O microfone tem um dono de cada vez. O ditado recusa iniciar com a
conversa conectada, e a conversa recusa conectar com o ditado ativo — os dois
lados em `lib/audio-coordinator.ts`. Dois `getUserMedia` simultâneos
reconfiguram o dispositivo na maioria dos aparelhos, e quem perde é a captura
que já estava em curso.

O transcript **não** entra na conversa do Agent, não vira `role="user"`, não é
enviado a ele, não dispara client tool, não passa pelo action registry e não é
interpretado como comando. A coordenação fina (enfileirar, ceder a vez)
pertence à 5.2B; o que a 5.2A não podia era nascer permitindo dois donos.

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

Categorias: `PERMISSION_DENIED`, `NO_DEVICE`, `UNSUPPORTED`, `OFFLINE`,
`TIMEOUT`, `PROVIDER_UNAVAILABLE`, `EMPTY_TRANSCRIPT`, `CANCELLED`, `UNKNOWN`.

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
| lote `voz-ditado` | 18 jornadas de navegador com provider e microfone simulados |

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
5. **A validação de formato confia no `Content-Type` declarado**, não em
   inspeção de bytes. O teto de tamanho e a autenticação limitam o alcance
   disso, e o provedor recusa o que não for áudio.
6. **Rótulos de opção e frases finais da opção não têm ditado** — cabem numa
   fase seguinte, se alguém pedir.

---

## Referências no código

| Onde | O quê |
|---|---|
| [`lib/voice/dictation.ts`](../lib/voice/dictation.ts) | limites, formatos, estados, `aplicaTranscricao` |
| [`lib/voice/dictation-server.ts`](../lib/voice/dictation-server.ts) | a flag e a chamada com retenção zero |
| [`lib/voice/use-dictation.ts`](../lib/voice/use-dictation.ts) | captura, teardown, ligação ao campo |
| [`app/api/voice/dictation/route.ts`](../app/api/voice/dictation/route.ts) | o único ponto por onde áudio de microfone passa |
| [`lib/audio-coordinator.ts`](../lib/audio-coordinator.ts) | arbitragem de microfone entre Agent e ditado |
| [`docs/modelo-de-confianca-voz.md`](modelo-de-confianca-voz.md) | o que o Helo prova e o que não prova sobre voz |
