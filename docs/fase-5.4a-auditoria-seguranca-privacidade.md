# Fase 5.4A — Auditoria final de segurança residual e contrato externo

> **Esta fase não corrigiu nada.** Nenhuma linha do produto mudou. O que existe
> aqui é o estado real do código em `3d0e8f6` e o plano derivado dele.

---

## 1. Resumo executivo

**Nenhum risco CRÍTICO.** Nenhuma das oito condições de parada da 5.4A foi
encontrada: a chave da ElevenLabs e o segredo do SpeechGrant vivem só no
servidor; não há escrita pública no Storage; não há endpoint anônimo capaz de
sintetizar a voz do paciente; não há áudio de paciente enumerável; não há
download entre pacientes; não há webhook anônimo com efeito sensível; e o gate
que impede o Agent de responder pelo paciente continua de pé (76 asserções
entre `test:agent:gate` e `test:agent:invariants`).

**Dois riscos ALTOS**, e os dois são sobre o que sobra depois que a fala
acontece, não sobre quem pode falar:

- **R-04** — o áudio de uma frase favorita é sintetizado **na voz clonada do
  paciente**, gravado no Storage e publicado por uma URL de download com token
  durável. Essa URL funciona sem autenticação, não expira, não é invalidada
  quando o clone é trocado ou removido, não é invalidada quando alguém perde o
  vínculo com o paciente, e é servida com `max-age=31536000, immutable`. Ela é
  o **caminho alternativo** que contorna todo o controle de SpeechGrant erguido
  na 5.1A: quem tem a URL não precisa de grant, de vínculo, nem de sessão.

- **A-10** — **não existe um único limitador de taxa em lugar nenhum do
  produto.** O pior caso é `/generateMusic`: autenticado, mas sem teto de
  chamadas, com 300 segundos de composição paga por pedido, 1 GiB de memória e
  um MP3 gravado no Storage a cada vez. Um cuidador legítimo, sozinho, esgota a
  cota da conta.

Sete riscos **MÉDIOS** — o prompt do cuidador no log do servidor; o corpo bruto
da recusa do provedor no log; o órfão de Storage quando a re-síntese falha; a
URL durável da música indo para a ElevenLabs no retorno da tool; o caminho
global `musics/`; duas rotas do Agent sem `Cache-Control`; e o `no-cache` do
Firebase Hosting podendo sobrepor o `no-store` das rotas de voz. Mais cinco
**BAIXOS** e cinco **INFORMATIVOS**, inventariados na matriz da §36.

**Duas coisas o repositório não sabe, e a auditoria não inventou:**

1. **Storage Rules.** Não existem no repositório, não são referenciadas em
   `firebase.json`, e não há como saber se estão deployadas ou o que dizem.
   → **CONFIGURAÇÃO EXTERNA NÃO VERIFICADA.**
2. **O contrato do painel ElevenLabs.** System Prompt, tools declaradas,
   schemas, variáveis dinâmicas, Knowledge Base e política de retenção.
   → **CONFIGURAÇÃO EXTERNA NÃO VERIFICADA.** O checklist para preenchimento
   manual está em `docs/elevenlabs-agent-contract-checklist.md`.

Um risco **foi eliminado** desde a auditoria 5.0 sem que ninguém o tenha
atacado de frente: `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (R-13) deixou de ser lido
pelo código — sobrou apenas a linha morta no `.env.local`, que nunca chega ao
bundle porque o Next só inlina o que é referenciado.

---

## 2. Baseline

| Item | Valor |
| --- | --- |
| HEAD | `3d0e8f62a62c8489c5adc958c4c6251f5f132084` |
| `origin/rescue-imported-2026-08-02` | idêntico ao HEAD |
| Tags no HEAD | `ponto-seguranca-fase-5.3`, `ponto-seguranca-fase-5.3c` |
| Árvore | limpa no início e no fim (fora os arquivos desta fase) |
| Actions | 47 — navigation 9, operational 16, sensitive 12, patientResponse 10 |
| Agent-executable | 25 |
| `tsc --noEmit` | limpo |
| `lint` | 55 erros / 6 warnings (baseline inalterado) |
| Chamadas reais à ElevenLabs nesta fase | **zero** |

---

## 3. Superfície ElevenLabs

Seis arquivos alcançam `api.elevenlabs.io`. O censo está congelado em
`scripts/test-superficie-eleven.mjs` §1 — um sétimo arquivo quebra o teste.

| Caminho | Tipo | Autenticação | Autorização | Envia | Recebe | Persiste? | Loga? | Timeout | Rate limit | Cache | Risco |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/v1/text-to-speech/{voice}` via `app/api/tts` | TTS stream | `requireUser` | `requirePatientAccess` + **SpeechGrant** para a voz do paciente | texto (≤1000), voiceId, model | MP3 | não (blob efêmero, revogado) | status+categoria; **nunca o corpo** | 15 s até cabeçalhos | **nenhum** | `no-store` | BAIXO |
| `/v1/convai/conversation/token` via `app/api/helo/conversation-token` | token WebRTC | cookie | `requirePatientAccess` | `agent_id` | token efêmero | não | `voiceOverrideApplied` + preferência (sem id) | 10 s total | **nenhum** | **ausente** | MÉDIO |
| `/v1/speech-to-text` via `lib/voice/dictation.ts` | STT | cookie | `requirePatientAccess` + flag | áudio do cuidador | texto | **não** (nada fica) | motivo+status | 20 s | **nenhum** | `no-store` | BAIXO (desligado em produção) |
| `/v1/voices/{id}` via `lib/voice-catalog.ts` | consulta | `requireAdmin` | admin | voiceId | nome | não | categoria | 8 s | **nenhum** | — | BAIXO |
| `/v1/text-to-speech/{voice}` em `functions/index.js` (`synthesizePhraseAudio`) | TTS | cookie `__session` | `patientAccess(createActivities)` | texto da frase, clone do paciente | MP3 | **SIM — Storage + Firestore** | status apenas | 20 s | **nenhum** | `public, max-age=31536000, immutable` | **ALTO (R-04)** |
| `/v1/music` em `functions/index.js` (`generateMusic`) | música | cookie `__session` | `patientAccess(createSession)` | prompt + gênero | MP3 | **SIM — Storage + playlist** | **prompt bruto + corpo do provedor** | **nenhum** | **nenhum** | `public, max-age=31536000, immutable` | **MÉDIO/ALTO (R-07 + A-10)** |

A sessão WebRTC do Agent é a sétima porta e não passa por `fetch` nenhum: o SDK
`@elevenlabs/react` abre o transporte no navegador com o token efêmero. O que
atravessa por ali está na matriz de §24.

---

## 4. Endpoints do Helo

| Endpoint | Existe | Método | Auth | Patient access | Cache-Control | Rate limit | Logs | Provedor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/tts` | sim | POST | `requireUser` | sim + SpeechGrant | `no-store` | não | motivo da recusa | TTS |
| `/api/voice/grant` | sim | POST | cookie | sim | `no-store` | não | só erro de configuração | — |
| `/api/voice/dictation` | sim | GET/POST | `requireUser` / cookie | sim (via header `x-helo-patient-id`) | `no-store` | não | motivo do container | STT |
| `/api/helo/conversation-token` | sim | POST | cookie | sim | **ausente** | não | override + preferência | conversa |
| `/api/helo/client-tools` | sim | POST | cookie | sim, com permissão declarada | **ausente** | não | nenhum | — |
| `/api/voices` | sim | GET | `requireUser` | opcional | ausente | não | nenhum | — |
| `/api/voice-preference` | sim | POST | `requireUser` | — (é do usuário) | ausente | não | auditoria | — |
| `/api/patient-voice-source` | sim | POST | cookie | sim + `selectPatientVoiceSource` | ausente | não | auditoria | — |
| `/api/admin/voices` | sim | GET/POST/… | `requireAdmin` | — | ausente | não | auditoria | consulta de voz |
| `/api/admin/patient-voice` | sim | POST/DELETE | `requireAdmin` | — | ausente | não | auditoria **com id mascarado** | consulta de voz |
| `/api/media` | sim | GET/POST/DELETE | cookie | sim | `private, max-age=3600` | não | auditoria sem conteúdo | — |
| `/generateMusic` (Function) | sim | POST | cookie `__session` | sim | `public, immutable` no arquivo | **não** | **prompt bruto** | música |
| `/synthesizePhraseAudio` (Function) | sim | POST | cookie `__session` | sim | `public, immutable` no arquivo | **não** | status apenas | TTS |
| `/webhook/generate_music` (legado) | sim | POST | mesma do handler | sim | — | não | aviso de rota legada | música |
| rota de admin de voz dedicada | — | — | — | — | — | — | — | — |

Não existe `middleware.ts`. Não existe nenhuma camada transversal de headers,
autenticação ou limite: cada rota se defende sozinha, e todas as de voz o fazem.

**`/api/media` é o modelo de contraste que a 5.4B deve copiar para o R-04:** os
bytes só saem por uma rota autenticada, com `private, max-age=3600` e
`Content-Disposition` explícito. Não existe URL que funcione sem sessão.

---

## 5. Cloud Functions

Duas Functions e uma rota legada, todas em `functions/index.js` (382 linhas,
JavaScript puro, sem compartilhar código com o app Next — a checagem de acesso é
reimplementada ali de propósito, e confere com `requirePatientAccess`).

### `synthesizePhraseAudio`

| Item | Estado |
| --- | --- |
| Auth | cookie `__session`, token `[a-f0-9]{64}`, sessão não expirada, usuário ativo |
| Authorization | `userPatientAccess/{userId}_{patientId}` ativo com `createActivities` (admin passa) |
| App Check | **não** |
| Patient binding | sim — a frase é lida de `patients/{id}/favoritePhrases/{phraseId}` e **o texto do corpo tem de bater com o texto salvo** |
| Storage | `patients/{patientId}/phrases_audio/{phraseId}.mp3` |
| URL | `getDownloadURL(file)` — token durável |
| Metadata | `contentType: audio/mpeg`, `cacheControl: public, max-age=31536000, immutable`. **Sem owner, sem patientId, sem data de expiração** |
| Logs | status do provedor apenas — o corpo devolvido **não** entra no log (já corrigido em fase anterior) |
| Timeout | 20 s na chamada; 120 s na Function |
| Retenção | **indefinida** |
| Ciclo de vida | apagado só quando a frase é excluída **e** `storagePath` ainda existe no documento |

### `generateMusic`

| Item | Estado |
| --- | --- |
| Auth | igual |
| Authorization | `createSession` |
| App Check | **não** |
| Patient binding | só para autorizar; o arquivo **não** fica sob o paciente |
| Storage | `musics/{Date.now()}-{genero}.mp3` — **caminho global, fora de `patients/`** |
| URL | `getDownloadURL(file)` — token durável |
| Metadata | `generatedBy: helo`, `genre` |
| Logs | **`console.log("Received music payload:", { prompt, genre, durationSeconds })`** e **`response: responseText.slice(0, 500)`** na recusa |
| Timeout | **nenhum** na chamada (deliberado — composição leva minutos); 300 s na Function |
| Tamanho | duração limitada a 10–300 s |
| Limpeza | se a escrita no Firestore falha, o MP3 é apagado |

### Rota legada `/webhook/generate_music`

Passa pelo **mesmo** handler autenticado. Uma server tool da ElevenLabs
chamando dali, sem cookie de sessão, recebe **401**. Continua existindo porque a
pergunta "o painel aponta alguma server tool para cá?" nunca foi respondida —
está no checklist, §5.2.

---

## 6. R-04 — áudio de frase do paciente

O fluxo inteiro, do texto ao arquivo:

```
cuidador salva a frase em /atividades/gerenciar
        │
        ├─ POST /api/favorite-phrases  (createActivities)  → Firestore
        │
        └─ POST /synthesizePhraseAudio (createActivities)
                 │  confere: a frase existe? o texto bate com o salvo?
                 │  resolve a voz: clone do paciente → catálogo → env
                 ├─ ElevenLabs TTS (20 s)
                 ├─ Storage: patients/{pid}/phrases_audio/{phraseId}.mp3
                 │           cacheControl: public, max-age=31536000, immutable
                 ├─ getDownloadURL(file)   ← token durável embutido
                 └─ Firestore: favoritePhrases/{id}.audioUrl = <URL>

reprodução (components/phrases-to-listen-modal.tsx)
        │
        ├─ se audioUrl existe → new Audio(audioUrl)
        │      o navegador busca DIRETO em firebasestorage.googleapis.com
        │      SEM cookie, SEM grant, SEM passar pelo Helo
        │
        └─ se não existe → /api/voice/grant → /api/tts → blob efêmero, revogado
```

As dezoito perguntas, com evidência:

| # | Pergunta | Resposta |
| --- | --- | --- |
| 1 | O áudio é persistido? | **Sim** — `functions/index.js:136-140` |
| 2 | Onde? | Storage do projeto, bucket `helo-app-7fbf8.firebasestorage.app` |
| 3 | O path contém `patientId`? | Sim — `patients/{patientId}/phrases_audio/` |
| 4 | O path contém `userId`? | Não |
| 5 | O nome é previsível? | Parcialmente: `{phraseId}.mp3`, e `phraseId` é um id do Firestore (20 chars aleatórios) — **não enumerável** |
| 6 | O arquivo tem metadata de owner? | **Não** — só `contentType` e `cacheControl` |
| 7 | A URL é download URL com token durável? | **Sim** — `getDownloadURL` |
| 8 | A URL funciona sem autenticação? | **Sim.** O token de download é uma capability: ele **ignora as Storage Rules** por construção |
| 9 | A URL é armazenada no Firestore? | **Sim** — `favoritePhrases/{id}.audioUrl` |
| 10 | Por quanto tempo? | Indefinidamente. O token não expira |
| 11 | Existe exclusão? | **Parcial.** `deleteFavoritePhrase` apaga o objeto — **se** `storagePath` ainda estiver no documento |
| 12 | Existe invalidação se a voz mudar? | **Não.** `DELETE /api/admin/patient-voice` remove o clone e não toca em nenhum MP3 já sintetizado |
| 13 | Existe invalidação se o paciente perder acesso? | **Não.** Revogar o vínculo não alcança uma URL já distribuída |
| 14 | Storage Rules protegem? | **Irrelevante para esta URL** — o token de download passa por cima delas. E, de todo modo, ver 15 |
| 15 | As Rules estão versionadas no repositório? | **Não.** Não há `storage.rules`, e `firebase.json` não tem seção `storage` → **CONFIGURAÇÃO EXTERNA NÃO VERIFICADA** |
| 16 | As Rules distinguem paciente/cuidador? | Desconhecido |
| 17 | Alguém com a URL baixa sem o Helo? | **Sim** |
| 18 | O áudio contém voz clonada identificável? | **Sim, quando existe clone.** O documento registra `usesClonedVoice: true` |

### O defeito lateral: o órfão

`updateFavoritePhrase` (edição do texto) zera `audioUrl` **e** `storagePath` no
Firestore. O cliente então chama `/synthesizePhraseAudio` de novo, que grava no
**mesmo** path e regenera o token — a URL antiga morre junto. Mas se essa
segunda chamada falhar (rede, 503, provedor fora), o documento fica com
`storagePath: null` e o MP3 **antigo continua no Storage, com o token antigo,
dizendo o texto antigo, na voz do paciente**. E como `deleteFavoritePhrase` só
apaga o que `storagePath` apontar, excluir a frase depois **não** remove esse
arquivo. Ele sobrevive à exclusão.

### Classificação

**ALTO**, não crítico. O que segura a severidade é que a URL não é enumerável e
que chegar até ela exige, na origem, acesso legítimo ao paciente. O que a
sustenta em ALTO é tudo o mais: é voz clonada identificável, a URL não expira,
não é revogável, sobrevive à perda de acesso, e contorna inteiro o portão que a
Fase 5.1A construiu.

---

## 7. Storage Rules

| Pergunta | Resposta |
| --- | --- |
| Existem? | Desconhecido |
| Versionadas? | **Não** |
| Referenciadas em `firebase.json`? | **Não** — só `firestore.rules` |
| Deployadas? | Desconhecido |
| Cobrem `patients/*/phrases_audio/`? | Desconhecido |
| Cobrem `musics/`? | Desconhecido |
| Verificam auth? | Desconhecido |
| Verificam vínculo cuidador↔paciente? | Desconhecido |
| Dependem só do token de download? | **O acesso em produção depende, sim** — é assim que o navegador toca o áudio hoje |
| Permitem read/write público? | Desconhecido |

→ **CONFIGURAÇÃO EXTERNA NÃO VERIFICADA.**

E vale dizer o que a resposta *não* mudaria: **Storage Rules apertadas não
fechariam o R-04.** O token de download existe justamente para contornar as
Rules. A correção passa por não emitir o token, não por endurecê-las.

Para contraste, `firestore.rules` está no repositório e é `allow read, write: if
false` no documento raiz — o navegador não fala com o Firestore, e tudo passa
pelas rotas do servidor.

---

## 8. URLs de download

| Mecanismo | Onde | Situação |
| --- | --- | --- |
| `getDownloadURL` | `functions/index.js` — e **só ali** (congelado em teste) | dois usos: frase e música |
| `downloadTokens` explícito | ausente | — |
| Signed URL | ausente | — |
| URL pública direta | ausente | — |
| URL salva em documento | `favoritePhrases.audioUrl`, `playlist.audioUrl` | ambos duráveis |

**Arquivo privado protegido por SDK/Rules** e **URL com bearer token durável**
são coisas diferentes, e o Helo hoje tem só a segunda para áudio persistido. A
primeira existe, e funciona bem, em `/api/media` — para as fotos da biblioteca.

Onde a URL durável aparece:

| Superfície | Frase (voz do paciente) | Música |
| --- | --- | --- |
| Firestore | **sim** | **sim** |
| DOM | `new Audio(url)` — não vai ao HTML, mas está no objeto | `<source src>` — **no HTML** |
| Network do navegador | **sim** | **sim** |
| Cache HTTP do navegador | **sim, por 1 ano** (`immutable`) | **sim, por 1 ano** |
| Cache API / Service Worker | não — o SW ignora outra origem | não |
| localStorage / IndexedDB | não | não |
| Log do navegador | não | **sim** — `[HELO MUSIC] playback started` |
| Enviada à ElevenLabs | não | **sim** — no retorno de `generate_and_play_music` |

---

## 9. R-07 — música

```
cuidador pede música por voz
   → Agent chama generate_and_play_music (client tool)
   → POST /generateMusic  (credentials: same-origin, cookie __session)
        ├─ console.log("Received music payload:", { prompt, genre, duração })   ← MÉDIO
        ├─ patientAccess(createSession)
        ├─ ElevenLabs /v1/music  — SEM TIMEOUT, até 300 s
        │     em recusa: console.error(..., { status, response: corpo[0..500] }) ← MÉDIO
        ├─ Storage: musics/{Date.now()}-{genero}.mp3   ← global, sem paciente
        ├─ getDownloadURL → URL durável
        ├─ Firestore: patients/{pid}/playlist  { title, prompt, genre, audioUrl, storagePath }
        └─ resposta → tool result → **volta para a ElevenLabs com o audioUrl**  ← MÉDIO
```

| Item | Estado | Nota |
| --- | --- | --- |
| Prompt enviado | ao provedor **e ao log do servidor** | o log é o problema |
| `patientId` | usado para autorizar e para a playlist | não vai ao provedor |
| `sessionId` | não circula | — |
| URL | durável, no Firestore, no DOM, no log do navegador **e na ElevenLabs** | — |
| File path | `musics/…` — global | não segue o paciente |
| Resposta bruta do provedor | não registrada no sucesso | — |
| Erro bruto do provedor | **registrado, 500 caracteres** | único ponto do produto que faz isso |
| Stack | `console.error("[HELO MUSIC] Falha inesperada…", error)` | objeto de erro inteiro |
| Webhook | rota legada, autenticada | — |
| Rate limiting | **nenhum** | ver §13 |
| Timeout | **nenhum** | deliberado e documentado |
| Tamanho máximo | duração 10–300 s | não há teto de bytes |

**Conteúdo criativo do cuidador × conteúdo clínico.** O prompt da música é
criativo por natureza — "algo calmo para dormir". Mas ele é ditado em voz alta
numa sessão clínica, sobre uma pessoa, e nada impede que saia como "uma música
para a Maria, que está agitada desde a internação". O Helo não pode decidir por
categoria: precisa tratar o prompt como o conteúdo do cuidador que ele é, e não
o registrar no log do servidor.

`musics/{Date.now()}` merece nota própria (**A-12, MÉDIO**): o caminho é global,
não carrega paciente nenhum, e o nome é um timestamp em milissegundos — perto de
previsível. Não é enumerável na prática (o token ainda protege), mas é o único
lugar do produto onde um arquivo de um paciente não vive sob o paciente.

---

## 10. Logs do Agent — A-09

Todos no **navegador**, não no servidor. A distinção importa para a severidade:
quem lê é quem já está na máquina do cuidador, com o console aberto. Não é
nenhum, mas é bem menos que Cloud Logging.

| Linha | Conteúdo | Classe |
| --- | --- | --- |
| `[HELO TOOL] getCurrentHeloActions called` | nada | SEGURO |
| `[HELO TOOL] capabilities returned` | tela, contagem, `humanOnly` | SEGURO |
| `[HELO TOOL] interactWithHeloUI called`, rawId, **`parameters`** | o objeto inteiro que o Agent mandou | DESNECESSÁRIO |
| `[HELO TOOL] actionId received` | um id declarado | SEGURO |
| `[HELO TOOL] ação bloqueada para o Agent` | actionId + classe | SEGURO |
| `[HELO TOOL] registered client tools` | nomes das tools | SEGURO |
| `[HELO TOOL] unhandled client tool call`, **`call`** | objeto inteiro, com parâmetros | DESNECESSÁRIO |
| `[HELO AUDIO] agent connected { conversationId }` | id de conversa do provedor | DESNECESSÁRIO |
| `[HELO AUDIO] agent disconnected`, **`details`** | objeto do SDK | DESNECESSÁRIO |
| `[HELO AUDIO] agent error`, message, **`context`** | mensagem e contexto do provedor | **ERRO BRUTO DO PROVIDER** |
| `[HELO AUDIO] sdk debug` | só `{ type }` — já minimizado | SEGURO |
| `[HELO AUDIO] voice activity detected` | score numérico | SEGURO |
| `[HELO AUTORIA] turno enviado` | `providerRole` + `source`, **nunca o texto** | SEGURO |
| `[HELO SILENCE] …` | contagens | SEGURO |
| `[HELO NAV] requested/normalized area` | nome de área | SEGURO |
| `[HELO MUSIC] playback started { audioUrl }` | **URL durável** | SENSÍVEL |
| `[HELO MUSIC] music generation or playback failed`, `caught` | erro inteiro | DESNECESSÁRIO |
| `[HELO MUSIC] não foi possível restaurar o áudio`, `caught` | erro inteiro | DESNECESSÁRIO |

**O que não aparece em log nenhum:** transcrição da conversa, nome do paciente,
e-mail do cuidador, texto clínico, rótulo de opção, pergunta de rotina, token,
chave. A fronteira do R-09 — fechada na 5.3B — segurou: o que a tool devolve ao
provedor é capacidade, e é isso que o log registra.

**A-09 continua existindo**, em versão bem menor que a da 5.0: seis linhas
desnecessárias e uma sensível (o `audioUrl`). **BAIXO.**

---

## 11. Logs do STT/TTS

| Procurado | Encontrado? |
| --- | --- |
| Transcrição do ditado | **não** |
| Texto da fala do paciente | **não** |
| `voiceId` | **não** (mascarado até na auditoria: `abcd…wxyz`) |
| SpeechGrant completo | **não** |
| Hash do texto | **não** |
| URL do provedor | **não** |
| Corpo de erro da ElevenLabs | **não** nas rotas Next; **sim** em `generateMusic` |
| Payload da requisição | **não** |
| Chave da API | **não** |

O ponto único de log de falha do provedor é
`registraFalhaElevenLabs(rotulo, falha, status)` — três campos, e o comentário
do arquivo diz por que: *"Existe para que o formato seja um só e ninguém
acrescente o corpo 'só desta vez'."* Ele cumpre.

`[VOZ] fala do paciente recusada: <motivo>` registra só a categoria da recusa
(`expired`, `mismatch`, `misconfigured`…). `[DITADO] conteúdo recusado` registra
motivo e tipo declarado, nunca os bytes nem o nome do arquivo.

---

## 12. Segredos

| Segredo | Server-only? | `NEXT_PUBLIC_`? | Vai ao browser? | Logado? | Sai em resposta? | Sai em erro? |
| --- | --- | --- | --- | --- | --- | --- |
| `ELEVENLABS_API_KEY` | **sim** — só `app/api/**`, `lib/voice/**`, `lib/voice-catalog.ts`, `functions/` | não | **não** | não | não | não |
| `HELO_SPEECH_GRANT_SECRET` | **sim** — só `lib/voice/speech-grant.ts` | não | **não** | não (suíte prova: 32 asserções) | não | não |
| Credenciais Firebase Admin | ADC do runtime | não | não | não | não | não |
| `ANTHROPIC_API_KEY` | sim | não | não | não | não | não |
| Webhook secret | **não existe** | — | — | — | — | — |

A única variável `NEXT_PUBLIC_` do produto é `NEXT_PUBLIC_GENERATE_MUSIC_URL` —
uma URL pública, sem segredo. Congelado em teste: uma `NEXT_PUBLIC_` cujo nome
contenha `KEY`, `SECRET`, `TOKEN`, `GRANT`, `PASSWORD` ou `CREDENTIAL` quebra a
suíte.

**Nenhuma condição de parada da §39 foi acionada.**

---

## 13. Cache-Control — A-10

Lido do código, não presumido.

| Resposta | Header no código | Deveria ser | Veredito |
| --- | --- | --- | --- |
| `/api/tts` (áudio) | `no-store` | `no-store` | **correto** |
| `/api/voice/grant` | `no-store` | `no-store` | **correto** |
| `/api/voice/dictation` (GET, POST, recusas) | `no-store` | `no-store` | **correto** |
| `/api/helo/conversation-token` | **ausente** | `no-store` | **NÃO DEVE SER CACHEADO** |
| `/api/helo/client-tools` | **ausente** | `no-store` | NÃO DEVE SER CACHEADO |
| `/api/voices` (estado de voz do paciente) | ausente | `private, no-store` | NÃO DEVE SER CACHEADO |
| `/api/patient-voice-source`, `/api/voice-preference` | ausente | `no-store` | NÃO DEVE SER CACHEADO |
| `/api/admin/voices`, `/api/admin/patient-voice` | ausente | `no-store` | NÃO DEVE SER CACHEADO |
| `/api/media` (bytes) | `private, max-age=3600` | igual | **correto** |
| MP3 no Storage (frase e música) | `public, max-age=31536000, immutable` | ver §7/§30 | **NÃO DEVE SER CACHEADO assim** |

Nenhuma rota define `Pragma`, `Expires` ou `Vary`. As três que definem
`Cache-Control` o fazem no `Response` diretamente — não há default do Next em
jogo, e nenhuma rota de voz é estática ou revalidada.

### O indeterminado que precisa ser medido — A-10c

`firebase.json` define, para o Hosting:

```json
{ "source": "**", "headers": [ { "key": "Cache-Control", "value": "no-cache" } ] }
```

E o `**` é reescrito para o Cloud Run `heloapp`, que é onde o app Next roda. Se
o Hosting **sobrepõe** o header do backend, o `no-store` de `/api/tts` e de
`/api/voice/grant` vira `no-cache` em produção — e `no-cache` permite **guardar**
a resposta, exigindo apenas revalidação. Para o áudio da voz do paciente e para
um grant assinado, a diferença é real.

Não dá para resolver isso lendo o repositório, e a 5.4A não faz deploy.
→ **INDETERMINADO. Medir em produção com `curl -I` antes de qualquer conserto na
5.4C** — é possível que não haja o que consertar, e é possível que o conserto
seja retirar a regra do Hosting, não mexer nas rotas.

---

## 14. Conversation token

| Pergunta | Resposta |
| --- | --- |
| É cacheável? | POST — não é cacheado por navegador ou CDN na prática, mas **não há `Cache-Control` explícito** |
| Autenticação | cookie de sessão |
| Patient access | **sim** — `requirePatientAccess(patientId)` antes de qualquer chamada externa |
| Reutilizável? | é o token do provedor; o Helo não o guarda nem o reemite |
| TTL | **desconhecido** — definido pela ElevenLabs, não pelo Helo |
| Aparece em log? | **não** — só `voiceOverrideApplied`, a preferência semântica e `voiceIdPresent` (booleano) |
| Erro bruto? | não — categoria (`timeout`, `unauthorized`, …) vira status |
| Timeout | 10 s, total |
| Rate limiting | **nenhum** |
| Resposta traz dado extra? | sim: `dynamicVariables` (12 campos, incluindo `patientName`) e `overrides` — ver §24 |

O `catch` final registra `error.message`, nunca o objeto. O cliente recebe
`{ error: "Serviço de voz indisponível" }`.

---

## 15. STT — `/api/voice/dictation`

A decisão não muda: **produção segue com `HELO_VOICE_DICTATION_ENABLED`
ausente**, o que é o mesmo que `false` (a comparação é estrita contra `"true"`).
Grant Tier 2 sem ZRM. Ativação futura exige ZRM ou equivalente.

| Item | Estado |
| --- | --- |
| Cache-Control | `no-store` em **todas** as saídas, inclusive nas recusas |
| Auth | `requireUser` no GET, cookie no POST |
| Authorization | `requirePatientAccess` — e o `patientId` vem em **cabeçalho**, para autorizar **antes** de o corpo ser lido |
| Rate limiting | **nenhum** |
| Logs | motivo do container e tipo declarado; nunca bytes, nome ou transcrição |
| Tamanho | pré-checagem por `Content-Length` (2×), depois o tamanho real |
| Timeout | 20 s |
| Erro | `{ error, reason }` genéricos — o cuidador não recebe status do provedor nem plano do workspace |

A ordem de verificação é a defesa: flag → vínculo → tamanho → tipo declarado →
**assinatura do contêiner (12 bytes)** → só então o provedor. Nenhuma chamada
real foi feita nesta fase.

---

## 16. TTS — `/api/tts`

**O SpeechGrant continua obrigatório para a fala do paciente, e não foi
enfraquecido.** Os dois caminhos que fazem a voz do paciente soar — uso real e
prévia — passam pelo mesmo portão (`isPatientVoice`), e `confirmationStatus`
continua aceito no corpo sem autorizar coisa alguma.

| Item | Estado |
| --- | --- |
| Cache-Control | `no-store` |
| Rate limiting | **nenhum** |
| Logs | só o motivo da recusa |
| Vazamento de texto | **nenhum** — o corpo de erro da ElevenLabs nunca é registrado, e ele ecoa o texto |
| Erros | `{ error, reason }` com categoria; 503 para transitório, 502 para recusa |
| Timeout | 15 s até os cabeçalhos (o corpo flui livre, de propósito) |
| Tipo de resposta | `audio/mpeg` em stream |
| Autorização antes da chave | **sim** — uma fala proibida é recusada mesmo com o provedor fora do ar, sem gastar um caractere pago |

Confirmado por execução: `test:voice:authorization`, 32 asserções, incluindo
"rascunho arbitrário na voz do paciente é recusado" e "o mesmo grant não
empresta autoridade a outro texto".

---

## 17. Client tools — `/api/helo/client-tools`

**A 5.4 não reabre o R-09.** A rota autoriza sete ações nominais, valida área,
seção e permissão contra allowlists, e delega a autorização real a
`requirePatientAccess` com a permissão declarada pela ação.

| Item | Estado |
| --- | --- |
| Cache-Control | **ausente** |
| Auth | cookie |
| Patient access | sim, com permissão |
| Rate limiting | **nenhum** |
| Logs | nenhum |
| Payload | `{ patientId, action, area?, section?, permission? }` — nada mais é lido |
| Aliases legados | não nesta rota; os aliases vivem no cliente (§22) |

`test:agent:inventory` (42) e `test:agent:capabilities` (47) passaram: o payload
que sai para o provedor continua sendo uma lista declarada de capacidades, e
nenhum marcador clínico atravessa.

---

## 18. Rate limiting — A-10

**Inventário: nada.** A busca por `rateLimit`, `rate-limit`, `throttle`,
`quota`, `429`, `Retry-After`, `Upstash`, `Redis`, contador em memória, contador
no Firebase e Cloud Armor não encontrou **um único limitador do lado do Helo**.
As únicas ocorrências de `429` e `rateLimited` são o tratamento do 429 que a
**ElevenLabs** devolve — o limite é dela, não nosso.

| Endpoint | Situação |
| --- | --- |
| `/generateMusic` | **SEM LIMITADOR** |
| `/synthesizePhraseAudio` | **SEM LIMITADOR** |
| `/api/tts` | **SEM LIMITADOR** |
| `/api/voice/grant` | **SEM LIMITADOR** |
| `/api/voice/dictation` | **SEM LIMITADOR** (hoje desligado) |
| `/api/helo/conversation-token` | **SEM LIMITADOR** |
| `/api/admin/voices` (consulta) | **SEM LIMITADOR** |
| Cloud Run / App Hosting | **LIMITADOR EXTERNO NÃO VERIFICADO** — `maxInstances: 1` limita concorrência, **não** custo com a ElevenLabs |
| Firebase / Google Cloud | **LIMITADOR EXTERNO NÃO VERIFICADO** |

`maxInstances: 1` não protege: uma instância só consegue enfileirar chamadas
pagas indefinidamente. E na Function de música o limite de instâncias é o
padrão, não 1.

**Não se pode assumir que a plataforma resolve.**

---

## 19. Modelagem de rate limiting (para a 5.4C)

Sem valores ainda — a unidade primeiro.

| Endpoint | Abuso relevante | Unidade proposta | Por quê |
| --- | --- | --- | --- |
| `/generateMusic` | **custo financeiro** direto; exaustão de cota; geração de arquivos | **usuário + paciente**, janela longa (hora/dia) | é o único que compra minutos de composição; o paciente entra porque a playlist é dele e o abuso natural é repetir para o mesmo |
| `/synthesizePhraseAudio` | custo; geração de arquivos | **usuário + paciente**, janela média | uma frase por vez, por definição |
| `/api/tts` | custo; exaustão de cota | **usuário**, janela curta (minuto) | é chamado em rajada legítima (pré-aquecimento da Emergência) — o limite precisa caber nisso |
| `/api/voice/grant` | brute force sobre origens; enumeração de recursos | **usuário**, janela curta | não gasta crédito; o alvo é a tentativa repetida |
| `/api/voice/dictation` | custo; resource exhaustion (upload) | **usuário**, janela curta + teto de bytes acumulados | já tem teto por arquivo; falta o acumulado |
| `/api/helo/conversation-token` | custo de sessão; spam de conexões | **usuário**, janela curta | uma sessão por vez é o uso real |
| `/api/admin/voices` (consulta) | enumeração da conta ElevenLabs | **usuário admin**, janela curta | superfície pequena, mas é o único ponto que consulta a conta |

Duas observações que a 5.4C não deve perder:

- **IP não serve sozinho.** Cuidadores de uma mesma instituição saem pelo mesmo
  NAT; limitar por IP puniria a equipe inteira por causa de um.
- **O limitador precisa ser distribuído para valer.** Um contador em memória
  morre com a instância — e com `minInstances: 0` a instância morre o tempo
  todo. Contador no Firestore é o que o projeto já tem à mão.

---

## 20. R-12 — override morto da voz do Agent

**Continua morto, e agora com a causa documentada no código.**

A cadeia: `openAgentSession` chama `deps.requestToken(true)` — literalmente,
com `true` fixo (`lib/voice/agent-session-lifecycle.ts:161`). O comentário
explica: *"O LiveKit aceita a sessão, mas derruba o socket poucos segundos
depois quando recebe o override de voz remoto."* Logo:

`disableVoiceOverride = true` → `resolveVoiceOverride` nunca é chamado →
`voiceId = null` → `overrides` é `undefined` → `voiceOverrideApplied = false` →
o retry `if (!token.voiceOverrideApplied) throw` **nunca** executa o segundo
ramo.

| Pergunta | Resposta |
| --- | --- |
| Realmente morto? | **Sim** — o único chamador passa `true` |
| Usado no Admin? | não |
| Usado no Agent? | não |
| Usado no preview? | não |
| Consumido externamente? | não |
| Documentado? | sim — 5.0 (R-12), 5.3A e 5.3B |

Consequência: `ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED` e as quatro variáveis de
voz do Agent estão **órfãs de fato**, ainda que declaradas em `apphosting.yaml`.

O código **não é lixo**: ele é a implementação pronta de um recurso bloqueado
por uma configuração do painel ("Voice ID override" na segurança do Agent, item
§4 do checklist). Removê-lo antes de saber a resposta seria jogar fora trabalho
correto. **BAIXO**, decisão para a 5.4C **depois** do checklist.

---

## 21. Variáveis órfãs

| Variável | Onde é lida | Onde é configurada | Produção? | Teste? | Morta? | Pode remover? | Depende do painel? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ELEVENLABS_API_KEY` | 8 pontos | `apphosting.yaml`, `.env` | sim | neutralizada | não | **não** | não |
| `HELO_SPEECH_GRANT_SECRET` | `speech-grant.ts` | `apphosting.yaml` | sim | efêmera | não | **não** | não |
| `ELEVENLABS_HELO_AGENT_ID` | `conversation-token` | `apphosting.yaml`, `.env` | sim | — | não | **não** | sim |
| `ELEVENLABS_VOICE_ID` | fallback de `/api/tts` | `apphosting.yaml`, `.env` | sim | — | não | não | não |
| `ELEVENLABS_HELO_VOICE_ID` | `/api/tts`, `voice-catalog`, Function | `.env.example` — **não está no `apphosting.yaml`** | **provavelmente não** | — | quase | **não** (é migração de catálogo) | não |
| `ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED` | `conversation-token` | `apphosting.yaml`, `.env.local` | irrelevante | — | **sim, na prática** | só com o painel | **sim** |
| `ELEVENLABS_HELO_PLATFORM_VOICE_FEMALE_ID` / `_MALE_ID` | `resolveVoiceOverride` | `apphosting.yaml`, `.env.local` | irrelevante | — | **sim, na prática** | só com o painel | **sim** |
| `ELEVENLABS_HELO_VOICE_FEMALE_ID` / `_MALE_ID` | alias no mesmo ponto | **em lugar nenhum** — no `apphosting.yaml` são os *nomes dos secrets*, não das variáveis | não | não | **sim** | **sim** | não |
| `HELO_VOICE_DICTATION_ENABLED` | `dictation-server` | não declarada em produção | ausente = desligado | `dev:teste --ditado` | não | **não** | não |
| `HELO_DICTATION_PROVIDER_BASE` | `dictation-server` | só fora de produção | ignorada em produção | sim | não | **não** | não |
| `NEXT_PUBLIC_GENERATE_MUSIC_URL` | provider | `.env.example` | opcional | — | não | não | não |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` | **ninguém** | `.env.local` | não | não | **sim (R-13)** | **sim** | não |
| `FIRESTORE_DATABASE_ID` | `firestore.ts`, Function | `.env.local`, runtime | sim | sim | não | não | não |
| `FIREBASE_STORAGE_BUCKET` | rota da playlist (fallback) | não declarada | fallback literal | — | não | não | não |

**Nada foi apagado.** Três candidatas claras para a 5.4C:
`ELEVENLABS_HELO_VOICE_FEMALE_ID`/`_MALE_ID` (aliases que nunca são
preenchidos) e a linha morta `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` no `.env.local`.

---

## 22. Aliases legados

Preservados pela 5.3A porque o contrato do painel não foi verificado, e
preservados aqui pelo mesmo motivo. Congelados em teste: um décimo sexto nome
quebra a suíte.

| Tool atual | Alias legado | Onde é aceito | Onde é testado | Onde é documentado |
| --- | --- | --- | --- | --- |
| `getCurrentHeloActions` | `getVisibleHeloActions` | `clientTools` | `test:5.4a:superficie` §6 | 5.3A §A-11; aqui |
| `interactWithHeloUI` | `interactWithVisibleHeloUI`, `executeHeloAction` | `clientTools` | idem | idem |
| `generate_and_play_music` | `generate_music` | `clientTools` | idem | idem |
| `navigateHeloArea` | — | — | — | — |

| Parâmetro atual | Aliases aceitos | Onde |
| --- | --- | --- |
| `actionId` | `action`, `id`, `name`, `label`, `target`, `command` | `interactWithUI` |
| `targetArea` | `area`, `target`, `name` | `navigateHeloArea` |
| `prompt`, `genre`, `duration_seconds` | — | música |
| `date_reference`, `period`, `genre` | — | playlist |

Total: **15 nomes de tool** (10 canônicos + 5 aliases) e **9 aliases de
parâmetro**. Nenhum removido. **BAIXO (A-11)** — a remoção depende inteiramente
do §5 do checklist.

---

## 23. Contrato externo

Procurado no repositório: arquivo exportado do Agent, documentação versionada do
prompt, ferramenta de admin que consulte a API de Agents, configuração local
salva. **Nada disso existe.**

O que o Helo conhece do contrato é só o seu próprio lado:

- os 15 nomes de tool que registra e os 9 aliases de parâmetro que aceita;
- as 12 variáveis dinâmicas que envia;
- o formato do payload de capacidades que devolve;
- que o First Message deveria usar `{{heloPatientGreeting}}` — **deveria**, e é
  o próprio comentário do código que diz isso, sem poder confirmar.

O que ele **não** conhece: System Prompt, descrições das tools, schemas dos
parâmetros, First Message real, voz, modelo, idioma, Knowledge Base, regras de
tool calling, e as configurações de retenção e logging do workspace.

Obter isso pela API exigiria uma chamada real à ElevenLabs — vedada nesta fase.

→ **CONFIGURAÇÃO EXTERNA NÃO VERIFICADA. Nada foi inferido.**

---

## 24. O painel ElevenLabs — o que preciso de você

O arquivo `docs/elevenlabs-agent-contract-checklist.md` foi criado para isso.
Ele pede, nesta ordem:

1. Agent ID e workspace.
2. **System Prompt completo** (o item mais importante).
3. First Message, e se usa `{{heloPatientGreeting}}`.
4. Voz, Voice ID, modelo, idioma, e se "Voice ID override" está habilitado.
5. Lista de Tools: nome, tipo, descrição, e o JSON schema dos parâmetros.
6. Se existe alguma **server tool** e para qual URL ela aponta (especialmente
   `/webhook/**`).
7. Variáveis dinâmicas declaradas.
8. Knowledge Base: existe, quais documentos, se algum tem dado clínico.
9. Retenção e logging **por recurso** — Agent, TTS, Music e STT têm políticas
   diferentes.
10. Opções de segurança do Agent.

**Nenhuma credencial.** O arquivo abre com esse aviso e é versionado no Git.

Quando as três primeiras seções estiverem preenchidas, a comparação da §25
passa a ser possível.

---

## 25. Comparação local × externo

**Não realizada** — falta o lado externo. As perguntas ficam registradas com o
que já se sabe do lado local, para serem respondidas quando o checklist voltar:

| Divergência procurada | O que o lado local diz hoje |
| --- | --- |
| Tool inexistente localmente | 15 nomes registrados; qualquer outro cai em `onUnhandledClientToolCall` e vira um `console.warn` |
| Tool local não declarada no painel | possível — `debug.ping` e `checkUserSilence` são os candidatos |
| Alias antigo ainda usado | 5 nomes + 9 parâmetros mantidos exatamente por não saber |
| Description dizendo que o Agent pode `patientResponse` | o gate recusa: as 10 ações `patientResponse` e as 12 `sensitive` são inalcançáveis por origem `agent` |
| Description dizendo que pode `sensitive` | idem |
| Prompt contradizendo o gate | **é o risco de produto mais provável** — o Agent prometeria em voz o que a interface recusa |
| Referência ao DOM antigo | `localElements` e `availableActions` **não existem mais** desde a 5.3B; um prompt que os cite descreve um Helo que acabou |
| Referência aos campos do R-09 | idem |
| Prompt confundindo cuidador e paciente | o Helo já não confia na `role` do provedor (R-08): `user` significa "entrou pelo microfone desta sessão", que é o do cuidador |
| Instruções sobre SIM / TALVEZ / NÃO | o Helo envia os rótulos como variáveis dinâmicas (`confirmGestureLabel`, …) |
| Confirmação automática | proibida do lado local, em qualquer caminho |
| Conhecimento obsoleto | desconhecido |

**O painel não foi alterado.**

---

## 26. Knowledge Base

Nada no repositório menciona uma Knowledge Base vinculada, nenhum código faz
upload para ela, e nenhum caminho persiste conversa do lado do provedor por
iniciativa do Helo.

| Pergunta | Resposta |
| --- | --- |
| Existe? | desconhecido |
| Vinculada? | desconhecido |
| Conteúdo conhecido? | não |
| Pode conter dado clínico? | desconhecido |
| Só documentação geral? | desconhecido |
| Upload automático? | **não pelo Helo** — não há código que envie documento |
| Persistência de conversa? | **não pelo Helo**; do lado do provedor, desconhecido |

→ **CONFIGURAÇÃO EXTERNA NÃO VERIFICADA.** Nada foi implementado nesta fase.

---

## 27. Retenção na ElevenLabs

As quatro políticas são distintas e **não devem ser confundidas de novo**.

| Recurso | O que o **código** configura | O que se sabe do provedor |
| --- | --- | --- |
| **Speech-to-Text (Scribe)** | `enable_logging=false` na URL, sempre — `urlDoScribe` é a única forma de montá-la, e é o que a suíte de superfície garante | plano atual sem ZRM → **produção permanece desabilitada** |
| **Text-to-Speech** | **nenhum parâmetro de retenção é enviado** | desconhecido |
| **Conversational AI (Agent)** | **nenhum parâmetro de retenção é enviado**; o Helo só pede um token | desconhecido |
| **Music** | **nenhum parâmetro de retenção é enviado** | desconhecido |

Três dos quatro recursos não recebem instrução nenhuma de retenção. Isso não
significa que retenham — significa que **o Helo não sabe**, e o que decide é a
configuração do workspace, que está no §8 do checklist.

Nenhuma chamada real foi feita para "testar retenção".

---

## 28. Multi-tab

Cenário: aba A com o paciente X, aba B com o paciente Y ou outra rota.

| Pergunta | Resposta |
| --- | --- |
| O registry é por aba? | **sim** — `Map` de módulo, um por runtime JS |
| A geração é por runtime JS? | **sim** — contador de módulo, nunca compartilhado |
| Alguma comunicação usa `localStorage`/`BroadcastChannel`? | **`BroadcastChannel` não existe no produto. Nenhum `addEventListener("storage")`.** `helo.patientId` é lido do `localStorage` **só na montagem** |
| Uma aba pode invalidar a outra? | **não** pelo lease. **Sim** pela sessão: o logout destrói `authSessions/{token}` no servidor, e o cookie é do navegador inteiro |
| Existe risco de cruzamento de paciente? | **não.** Cada requisição carrega o `patientId` explícito e passa por `requirePatientAccess` para *aquele* id. Duas abas são duas sessões independentes, cada uma correta no seu contexto |
| Ou só sessões independentes? | **só sessões independentes** |

O único efeito observável é de operação, não de autorização: se a aba B trocar o
paciente ativo, a aba A **continua** com o seu — e um `reload` da aba A a traria
para o paciente da aba B, porque o `localStorage` é a semente. Isso é visível na
tela ("Paciente: …"), não silencioso.

Depois do logout numa aba, a outra falha **fechada**: o `authorizeTool` do
dispatcher é uma ida ao servidor, e ela devolve 401.

**INFORMATIVO.** Nenhuma coordenação entre abas foi implementada, e a auditoria
não recomenda implementar: o risco real é menor que a complexidade de uma
camada de coordenação.

---

## 29. Browser storage

| Mecanismo | Chaves | Conteúdo de voz? |
| --- | --- | --- |
| `localStorage` | `helo.user`, `helo.patientId`, `helo.patients`, `helo.settings.{pid}`, `helo.items.{pid}.{modo}`, `heloAgentInputDeviceId`, chave de mudo | **nenhum áudio, nenhuma transcrição, nenhum token, nenhum grant, nenhuma URL de provedor, nenhum `voiceId` técnico** |
| `sessionStorage` | marca de áudio de boas-vindas | não |
| **IndexedDB** | fila offline, snapshots, chaves, meta | conteúdo clínico do Helo (já coberto pela 4.9). **Nenhum áudio** |
| **Cache API / Service Worker** | shell e assets do próprio domínio | **não** — `/api/**` nunca é cacheado, e outra origem é ignorada por completo (`url.origin !== self.location.origin → return`) |
| Object URLs | cache LRU de 32 entradas, em memória | áudio sintetizado, **revogado** em substituição, despejo, troca de paciente e logout. **Não persiste** |

Um espelho merecia conferência e recebeu: `helo.settings.{pid}` é a resposta de
`/api/settings` guardada em texto claro, e essa resposta poderia carregar o
`voice_id` técnico do clone. **Não carrega.** O handler apaga a chave antes de
responder — `delete settings[PATIENT_SETTING_KEYS.voiceId]`
(`app/api/settings/route.ts:59`) —, e as quatro chaves de voz estão declaradas
fora do fluxo genérico em `VOICE_SETTING_KEYS`. O comentário do arquivo era
verdadeiro, e agora está verificado em vez de acreditado.

A 5.2 já provou que áudio bruto de ditado não persiste. Não foi refeito.

---

## 30. Firestore

| Coleção / campo | Dado | Owner | Autorização | Retenção | URL durável? | Necessário? |
| --- | --- | --- | --- | --- | --- | --- |
| `patients/{id}/favoritePhrases.audioUrl` | URL do MP3 na voz do paciente | paciente | rotas com `requirePatientAccess` | indefinida | **SIM** | **não como está** — ver 5.4B |
| `…favoritePhrases.storagePath` | caminho do objeto | paciente | idem | indefinida | não | sim (é o que permite apagar) |
| `…favoritePhrases.usesClonedVoice` | booleano | paciente | idem | indefinida | não | sim |
| `…favoritePhrases.synthesizedAt` | data | paciente | idem | indefinida | não | sim |
| `patients/{id}/playlist.audioUrl` | URL do MP3 da música | paciente | idem | indefinida | **SIM** | **não como está** |
| `…playlist.prompt` | prompt do cuidador | paciente | idem | indefinida | não | discutível — o título já existe |
| `patients/{id}/settings/voice_id` | `voiceId` do clone | paciente | escrita **exclusiva do Admin** | indefinida | não | sim |
| `patients/{id}/settings/patient_voice_source` | `clone` \| `platform` | paciente | `selectPatientVoiceSource` | indefinida | não | sim |
| `users/*.platformVoiceId` | id do **catálogo**, nunca técnico | usuário | própria | indefinida | não | sim |
| `platformVoices/*` | catálogo aprovado, com `elevenLabsVoiceId` | plataforma | admin | indefinida | não | sim |
| `auditLog` (`favorite_phrase.create/update`) | **`metadata.text` — o texto da frase** | paciente | admin/auditoria | indefinida | não | sim (é auditoria) |

**Não existe** nenhum campo `conversationId`, `transcript`, `phraseAudio`,
`musicUrl` ou similar. Nada da conversa com o Agent é persistido no Firestore
pelo Helo. `firestore.rules` nega tudo ao cliente: o navegador não fala com o
banco.

Nenhum schema foi alterado.

---

## 31. Dados do paciente enviados a terceiros

| Dado | Recurso ElevenLabs | Finalidade | Necessário? | Minimizado? | Persiste no Helo? | Persiste no provedor? | Retenção conhecida? | Risco |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Texto da fala do paciente** | TTS | sintetizar a voz dele | **sim** | sim — ≤1000 chars, só com grant | não (blob efêmero) | desconhecido | **não** | MÉDIO |
| **Texto da frase favorita** | TTS (Function) | pré-sintetizar | sim | sim — ≤500, tem de bater com o salvo | **sim, como MP3** | desconhecido | **não** | **ALTO (R-04)** |
| **Voz do cuidador (áudio)** | Conversational AI | a conversa | **sim** | é o recurso | não | **provavelmente sim** (transcrição do Agent) | **não** | MÉDIO |
| **Mensagem escrita do cuidador** | Agent (`sendUserMessage`) | responder ao cuidador | sim | prefixo de autoria; texto integral | sim (observações) | provavelmente | **não** | MÉDIO |
| **Pergunta da atividade/rotina** | Agent (`systemInstruction`) | a Helo lê para o paciente | **sim** | só o texto da pergunta | sim | provavelmente | **não** | MÉDIO |
| **Gesto do paciente** | Agent (`patientGestureReport`) | o Agent saber que houve resposta | sim | **vocabulário fixo** — 3 mensagens declaradas | sim (evento) | provavelmente | **não** | BAIXO |
| **`patientName`** | Agent (variável dinâmica) | tratar a pessoa pelo nome | **discutível** | não — é o nome real | sim | provavelmente | **não** | **MÉDIO** |
| **`preferredName`** | Agent (variável dinâmica) | idem | sim | é o nome de tratamento configurado | sim | provavelmente | **não** | MÉDIO |
| **`activePatientId`** | Agent (variável dinâmica) | contexto | **não** — o Agent não o usa para nada que o Helo aceite | não | sim | provavelmente | **não** | **BAIXO, candidato a sair** |
| **`currentOperatorRole`** | Agent (variável dinâmica) | tom da conversa | sim | é um papel, não uma pessoa | sim | provavelmente | não | BAIXO |
| Rótulos de gesto, estilo, saudação | Agent | personalização | sim | configuracionais | sim | provavelmente | não | BAIXO |
| **Prompt da música** | Music | compor | **sim** | ≤4100; sem filtro de conteúdo | **sim** (playlist) | desconhecido | **não** | MÉDIO |
| **`audioUrl` da música** | Agent (retorno da tool) | **nenhuma** | **NÃO** | não | sim | **sim, na transcrição** | não | **MÉDIO (R-14)** |
| **Áudio do ditado** | Scribe | transcrever | sim | `enable_logging=false` | **não** | **não** (ZRM na URL) | **sim** | BAIXO — desligado |
| `voiceId` do clone | TTS | dizer qual voz | sim | é um id opaco | sim | por definição | — | BAIXO |
| Capacidades da tela | Agent | o Agent saber o que pode pedir | sim | **muito** — R-09 tirou DOM, rótulos e pergunta clínica | não | provavelmente | não | BAIXO |

Duas linhas merecem decisão na 5.4B: **`patientName`** (o nome real da pessoa
sai do Helo em toda abertura de sessão, e `preferredName` já cobriria o uso) e
**`audioUrl` da música** (não serve para nada do lado do Agent e é durável).

---

## 32. Authorization

**Autenticação** (quem é) e **autorização por paciente** (pode este) são coisas
separadas em todo caminho provider-facing, e nenhuma rota confunde as duas.

| Caminho | Authentication | Patient authorization | Permissão fina |
| --- | --- | --- | --- |
| `/api/tts` | `requireUser` | `requirePatientAccess` na voz do paciente | + SpeechGrant |
| `/api/voice/grant` | cookie | `requirePatientAccess` | — |
| `/api/voice/dictation` | `requireUser` / cookie | `requirePatientAccess` | — |
| `/api/helo/conversation-token` | cookie | `requirePatientAccess` | — |
| `/api/helo/client-tools` | cookie | `requirePatientAccess` | a permissão declarada pela ação |
| `/api/patient-voice-source` | cookie | `requirePatientAccess` | `selectPatientVoiceSource` **se houver clone** |
| `/api/admin/patient-voice` | `requireAdmin` | — | admin |
| `/api/favorite-phrases` | cookie | `requirePatientAccess` | `view/create/edit/deleteActivities` |
| `/generateMusic` | cookie `__session` | `patientAccess` reimplementado | `createSession` |
| `/synthesizePhraseAudio` | cookie `__session` | idem | `createActivities` |
| `/api/media` | cookie | `requirePatientAccess` | `create/editActivities` para gerir |

Nenhum endpoint autenticado aceita um `patientId` sem confrontá-lo. O comentário
em `lib/auth.ts` é explícito sobre o motivo: o cookie é ambiente, e numa máquina
de plantão com duas abas ele pode não ser de quem escreveu — daí o
`expectedUserId` da fila offline.

**Nada foi alterado.**

---

## 33. Webhooks

| Pergunta | Resposta |
| --- | --- |
| Existem? | **um**, legado: `/webhook/generate_music` (mais `/generate_music` e `/generateMusic` no mesmo `app.post`) |
| Assinatura? | **não** |
| Auth? | **sim** — cookie `__session`, o mesmo do handler principal |
| Segredo? | **não existe** |
| Replay protection? | **não** |
| Logs? | `console.warn("[HELO MUSIC] rota legada /webhook usada…")` |
| Patient binding? | sim — `patientAccess(patientId, "createSession")` |
| Endpoint público? | a rota é pública; o **efeito** não é: sem cookie, 401 |

Como a ElevenLabs não teria cookie de sessão do cuidador, uma server tool que
ainda aponte para cá **já está quebrada** — e quebrada do jeito certo. A rota só
continua existindo porque ninguém confirmou que ela não é chamada (checklist
§5.2).

Ausência de assinatura e de replay protection **não é risco aqui**: não existe
caminho anônimo com efeito. Nenhum webhook foi criado.

---

## 34. Exposição de erros

| Origem | O que sai ao cliente | Classe |
| --- | --- | --- |
| `/api/tts` | `{ error: "falha na síntese", reason: <categoria> }` | SEGURO AO CLIENTE |
| `/api/voice/grant` | `{ error: "voz do paciente indisponível" }` | SEGURO AO CLIENTE |
| `/api/voice/dictation` | `{ error, reason }` — categorias fechadas | SEGURO AO CLIENTE |
| `/api/helo/conversation-token` | `{ error: "Não foi possível conectar com a Helo", reason }` | SEGURO AO CLIENTE |
| `/api/favorite-phrases` | `(error as Error).message` — mas as mensagens são do próprio domínio ("A frase deve ter entre 1 e 500 caracteres.") | SEGURO AO CLIENTE |
| `/api/feedback/**`, `/api/admin/feedback` | `error.message` genérico | SEGURO AO CLIENTE |
| `functions/generateMusic` | `{ error: "A ElevenLabs não conseguiu gerar a música." }` | SEGURO AO CLIENTE |
| **log de `generateMusic`** | **corpo bruto do provedor, 500 chars** | **NÃO DEVE SER EXPOSTO** (§9) |
| `console.error("[HELO AUDIO] agent error", message, context)` | erro do provedor no console do navegador | SEGURO SÓ AO SERVIDOR — e nem lá |
| tool result de música | `reason: caught.message` **vai para a ElevenLabs** | SEGURO SÓ AO SERVIDOR |

`response.text()` aparece **uma única vez** em todo o produto:
`functions/index.js:263`. É exatamente o R-07.

### MIME / Content-Type / download

| Superfície | Content-Type | Content-Disposition | Sniffing | Magic bytes | Tamanho | Tipos |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/tts` | `audio/mpeg` | — | não aplicável (stream) | — | texto ≤1000 | — |
| `/api/media` | do registro | `inline; filename=…` codificado | — | — | validado na escrita | validados |
| MP3 no Storage | `audio/mpeg` no metadata | **ausente** | possível | não verificado | sem teto | — |
| Upload do ditado | allowlist | — | **verificado** | **sim, 12 bytes** | 2 tetos | allowlist |

A 5.2B endureceu o upload do ditado e isso não foi refeito. O que falta é do
lado do Storage: os MP3 gravados pelas Functions não declaram
`Content-Disposition` e ninguém confere o que a ElevenLabs devolveu antes de
salvar — só que não está vazio.

---

## 35. Privacidade por design

A ordem de preferência para a 5.4B, aplicada aos achados:

| Achado | não coletar | não enviar | não persistir | proteger | apagar depois |
| --- | --- | --- | --- | --- | --- |
| **R-04** — MP3 da frase | — | — | **é a melhor opção**: sintetizar sob demanda pelo caminho do grant, como a frase sem `audioUrl` já faz | se persistir for necessário por desempenho: servir por rota autenticada, como `/api/media` | + TTL e invalidação ao trocar o clone |
| **R-14** — `audioUrl` à ElevenLabs | — | **é a opção**: o Agent não precisa da URL | — | — | — |
| **R-07a** — prompt no log | — | — | **é a opção**: não registrar | — | — |
| **R-07b** — corpo do provedor no log | — | — | **é a opção**: só status | — | — |
| **A-12** — `musics/` global | — | — | mover para `patients/{id}/musics/` | idem R-04 | — |
| **`patientName`** ao provedor | — | **é a opção**: `preferredName` já basta | — | — | — |
| **`activePatientId`** ao provedor | — | **é a opção**: não é usado | — | — | — |
| **A-09** — logs do navegador | — | — | **é a opção**: remover as seis linhas | — | — |

Para cada um, a resposta às seis perguntas está acima. Em **nenhum** deles a
melhor solução é "proteger melhor a persistência" — na maioria é simplesmente
deixar de guardar ou de enviar.

---

## 36. Matriz de risco

| ID | Severidade | Risco | Evidência | Destino |
| --- | --- | --- | --- | --- |
| **R-04** | **ALTO** | Áudio da voz clonada do paciente atrás de URL de download durável, sem autenticação, sem expiração, sem invalidação ao trocar o clone ou revogar o acesso, com `immutable` por 1 ano — contornando o SpeechGrant | `functions/index.js:136-141`; `phrases-to-listen-modal.tsx:59` | **5.4B** |
| **A-10** | **ALTO** | Nenhum limitador de taxa em endpoint algum; `/generateMusic` compra até 300 s de composição por chamada, sem teto | busca exaustiva, §18 | **5.4C** |
| **R-04b** | MÉDIO | Órfão de Storage: re-síntese falha depois do PATCH → `storagePath: null` e o MP3 antigo sobrevive à exclusão da frase | `lib/favorite-phrases.ts:64-86` | **5.4B** |
| **R-07a** | MÉDIO | Prompt do cuidador no log do servidor | `functions/index.js:216` | **5.4B** |
| **R-07b** | MÉDIO | Corpo bruto da recusa do provedor no log (500 chars) — único ponto do produto | `functions/index.js:263-267` | **5.4B** |
| **R-14** | MÉDIO | `generate_and_play_music` devolve o `audioUrl` durável à ElevenLabs, onde fica na transcrição | `helo-agent-provider.tsx:768` | **5.4B** |
| **A-12** | MÉDIO | `musics/{Date.now()}-{genero}.mp3` — caminho global, sem paciente, nome quase previsível | `functions/index.js:288` | **5.4B** |
| **A-10b** | MÉDIO | `/api/helo/conversation-token` e `/api/helo/client-tools` sem `Cache-Control` | §13 | **5.4C** |
| **A-10c** | MÉDIO / **INDETERMINADO** | O `no-cache` do `**` no Firebase Hosting pode sobrepor o `no-store` das rotas de voz | `firebase.json:41-48` | **5.4C** (medir antes) |
| **A-09** | BAIXO | Seis linhas de log desnecessárias no navegador + o `audioUrl` da música | §10 | **5.4C** |
| **R-12** | BAIXO | Override de voz do Agent é caminho morto; cinco envs órfãs junto | §20 | **5.4C**, depois do checklist |
| **R-13** | BAIXO | `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` morta no `.env.local` | §21 | **5.4C** |
| **A-11** | BAIXO | 5 aliases de tool e 9 de parâmetro sem contrato conhecido | §22 | **5.4C**, depende do checklist |
| **A-13** | BAIXO | `ELEVENLABS_HELO_VOICE_FEMALE_ID`/`_MALE_ID` nunca são preenchidas em lugar nenhum | §21 | **5.4C** |
| ~~A-14~~ | — | *Levantado e descartado na própria fase*: `helo.settings.{pid}` **não** contém o `voice_id` do clone — `/api/settings` apaga a chave antes de responder | `app/api/settings/route.ts:59` | **NÃO FAZER** |
| — | INFORMATIVO | Storage Rules ausentes do repositório | §7 | **5.4B** (versionar) |
| — | INFORMATIVO | Contrato do painel não verificado | §23 | **checklist** |
| — | INFORMATIVO | Knowledge Base e retenção do provedor desconhecidas | §26, §27 | **checklist** |
| — | INFORMATIVO | Multi-tab: sessões independentes, fail-closed no servidor | §28 | **NÃO FAZER** |
| — | INFORMATIVO | `cors({origin:true})` nas Functions, mas `SameSite=Lax` + JSON fecham o CSRF | §33 | **NÃO FAZER** |

**Zero CRÍTICOS.** Nenhuma condição de parada acionada.

---

## 37. Plano da 5.4B — privacidade de áudio, Storage e logs

Ordem proposta, do que mais reduz exposição para o que menos:

1. **R-04 — tirar o áudio da frase de trás da URL durável.**
   A pergunta a decidir antes de codar: *a pré-síntese precisa existir?* O
   caminho sem `audioUrl` já funciona hoje (grant → `/api/tts` → blob efêmero),
   e a diferença é latência. Duas saídas:
   - **(a) não persistir** — remover a Function e deixar o caminho do grant. É a
     opção mais limpa e a que este documento recomenda avaliar primeiro.
   - **(b) persistir sem URL pública** — não chamar `getDownloadURL`; guardar só
     o `storagePath`; servir os bytes por uma rota autenticada, no modelo de
     `/api/media`, com `private, no-store`. Junto: metadata de owner,
     `Content-Disposition`, e invalidação ao trocar/remover o clone.
2. **R-04b — fechar o órfão.** Ou o PATCH não zera `storagePath` antes de a
   nova síntese ter sucesso, ou a exclusão da frase apaga por caminho
   determinístico (`patients/{pid}/phrases_audio/{phraseId}.mp3`) em vez de
   depender do campo.
3. **R-07a e R-07b — os dois logs de `generateMusic`.** Remover o `console.log`
   do payload; trocar o corpo do provedor por status e categoria, no mesmo
   formato de `registraFalhaElevenLabs`.
4. **R-14 — parar de devolver o `audioUrl` à ElevenLabs.** O tool result já traz
   `title`, `outcome` e `message`; a URL não serve a nada do lado do Agent.
5. **A-12 — mover a música para `patients/{id}/musics/`** e aplicar a mesma
   decisão do item 1 sobre a URL.
6. **Fixar em teste** o que a §29 verificou à mão: `/api/settings` apaga o
   `voice_id` do clone antes de responder. Hoje só um `delete` numa linha
   sustenta isso, e nenhuma suíte notaria se ele sumisse.
7. **`patientName` e `activePatientId`** — decidir se saem das variáveis
   dinâmicas. `preferredName` cobre o uso; `activePatientId` não é usado.
8. **Versionar `storage.rules`** no repositório e referenciá-lo em
   `firebase.json`, qualquer que seja a decisão sobre as URLs. Hoje não há como
   revisar o que não existe no Git.

**Testes da 5.4B**: suíte de domínio para o ciclo de vida do áudio persistido
(criar → editar → falhar a re-síntese → excluir → não sobra objeto); suíte de
logs provando que nem prompt nem corpo do provedor saem; e o lote Playwright
`voz-robustez` + `controles-do-paciente` no mínimo. Regressão completa **sim** —
a 5.4B mexe em produto.

---

## 38. Plano da 5.4C — hardening, compatibilidade e validação final

1. **Medir o `Cache-Control` real em produção** (`curl -I` em `/api/tts` e
   `/api/voice/grant`) antes de decidir o A-10c. O conserto pode ser retirar a
   regra `**` do `firebase.json`, não mexer nas rotas.
2. **`no-store` explícito** em `conversation-token`, `client-tools`, `voices`,
   `voice-preference`, `patient-voice-source` e nas rotas de admin de voz.
3. **Rate limiting**, com as unidades da §19 e um contador no Firestore
   (distribuído, porque `minInstances: 0` mata contador em memória). Começar
   pelos dois que gastam dinheiro: `/generateMusic` e `/synthesizePhraseAudio`.
4. **A-09** — remover as seis linhas de log desnecessárias.
5. **Com o checklist preenchido**: remover os aliases de tool e de parâmetro que
   o painel não usa (A-11); decidir o destino do `resolveVoiceOverride` (R-12);
   remover `/webhook/generate_music` se nenhuma server tool apontar para lá.
6. **Envs órfãs**: apagar `ELEVENLABS_HELO_VOICE_FEMALE_ID`/`_MALE_ID` do
   código e a linha `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` do `.env.local`.
7. **Validação final**: regressão Playwright completa, todas as suítes de
   domínio, `tsc`, `lint` no baseline, zero chamadas reais à ElevenLabs.

---

## 39. Testes executados nesta fase

| Suíte | Resultado |
| --- | --- |
| `test:agent:gate` | **53 passaram, 0 falharam** |
| `test:agent:invariants` | **23 passaram, 0 falharam** |
| `test:agent:inventory` | **42 passaram, 0 falharam** |
| `test:agent:capabilities` | **47 passaram, 0 falharam** |
| `test:voice:authorization` | **32 passaram, 0 falharam** (servidor de teste isolado, porta 3510, banco `suite-http`, emulador 127.0.0.1:8090, provedor **NEUTRALIZADO**) |
| `test:voice:grant` (SpeechGrant) | **32 passaram, 0 falharam** |
| `test:eleven-guard` | **46 passaram, 0 falharam** |
| `test:5.4a:superficie` **(novo)** | **25 passaram, 0 falharam** |
| `tsc --noEmit` | limpo |
| `lint` | 55 erros / 6 warnings — baseline inalterado |

Regressão Playwright completa **não** executada, conforme a §41 do escopo: esta
fase não altera produto.

Suítes com suíte própria de Storage Rules ou de segurança de endpoints: **não
existem** — é uma das lacunas que a 5.4B e a 5.4C fecham.

**Zero chamadas reais à ElevenLabs.** O servidor de teste sobe pela guarda de
`scripts/eleven-guard.mjs`, que imprimiu `provedor ElevenLabs: NEUTRALIZADO`.

---

## 40. Limitações desta auditoria

O que este documento **não** pode afirmar:

1. **O que as Storage Rules dizem** — não estão no repositório.
2. **O que o painel da ElevenLabs configura** — System Prompt, tools, schemas,
   Knowledge Base, retenção. Nada foi inferido.
3. **Se o token de download realmente responde sem autenticação neste bucket** —
   é o comportamento documentado do Firebase Storage e a razão de o mecanismo
   existir, mas nenhuma requisição foi feita para confirmar.
4. **Qual `Cache-Control` chega ao navegador em produção** — depende do Hosting,
   e a 5.4A não faz deploy nem mede o ambiente publicado.
5. **A retenção real do provedor** em TTS, Agent e Music — nenhuma chamada foi
   feita para testar.
6. **O comportamento sob carga** — não houve teste de carga, e a ausência de
   rate limiting foi estabelecida por leitura, não por medição.
