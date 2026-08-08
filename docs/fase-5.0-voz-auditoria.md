# Fase 5.0 — Auditoria técnica e contrato da integração de voz / ElevenLabs

> Auditoria de leitura. Nenhum arquivo de produto foi alterado, nenhum
> comportamento foi corrigido, nenhum commit foi criado.
>
> Base congelada: `rescue-imported-2026-08-02` @ `79218e2` (Fase 4.9 fechada).
> Repositório: `/Users/fabiogarcia/Projects/Helo/helo-app`.
> `/Users/fabiogarcia/Documents/Helo` não foi acessado.

---

## 1. Veredito — **GO condicionado**

A base é sólida o suficiente para começar a Fase 5, e melhor do que o esperado
em três pontos que costumam ser os piores: a resolução do `voiceId` já é
exclusiva do servidor, o catálogo de vozes já é fechado e aprovado pelo Admin,
e o gerenciador global de áudio já tem hierarquia de prioridade explícita.

O **GO é condicionado** a que a Fase 5.1 comece pelo fechamento de dois
achados CRÍTICOS descritos abaixo (`R-01` e `R-02`), porque os dois estão
exatamente na fronteira que a Fase 5 promete proteger: quem pode fazer a voz
do paciente dizer alguma coisa. Adicionar TTS/STT/comandos por cima deles
aumenta a superfície do problema em vez de reduzi-la.

Há ainda um achado CRÍTICO fora do escopo estrito de voz (`R-03`: Cloud
Function sem autenticação com a chave da ElevenLabs) que não bloqueia a
arquitetura, mas bloqueia qualquer aumento de uso da conta.

---

## 2. Inventário completo da integração ElevenLabs

### 2.1 Dependência

`@elevenlabs/react@^1.10.0` (com `@elevenlabs/client` transitivo). Único SDK.
Não há SDK de STT, nem `SpeechRecognition`, nem `MediaRecorder` no projeto —
verificado por varredura.

### 2.2 Tabela de arquivos

| Arquivo | Responsabilidade | C/S | Estado | Utilizado por | Observações |
|---|---|---|---|---|---|
| `app/api/tts/route.ts` | Síntese TTS; resolve `voiceId` por autoria | Servidor | **ATIVO** | `lib/useSpeech.ts`, `phrases-to-listen-modal`, `ajustes`, `admin` | Confia no `confirmationStatus` enviado pelo cliente — ver `R-01` |
| `app/api/helo/conversation-token/route.ts` | Token WebRTC efêmero + `dynamicVariables` | Servidor | **ATIVO** | `components/helo-agent-provider.tsx` | `resolveVoiceOverride` está morto na prática — ver `R-11` |
| `app/api/helo/client-tools/route.ts` | Autorização (só) das client tools do Agent | Servidor | **ATIVO** | `helo-agent-provider` | Não escreve dado; aperta permissão |
| `app/api/voices/route.ts` | Catálogo em projeção pública + estado de voz do paciente | Servidor | **ATIVO** | `helo-voice-settings`, `ajustes` | Nunca devolve `voiceId` técnico |
| `app/api/voice-preference/route.ts` | Preferência de voz de plataforma do **usuário** | Servidor | **ATIVO** | `ajustes`, `dashboard` | Só ids do catálogo ativo |
| `app/api/patient-voice-source/route.ts` | Fonte da voz das falas do **paciente** (clone \| catálogo) | Servidor | **ATIVO** | `helo-voice-settings` | Permissão `selectPatientVoiceSource` quando há clone |
| `app/api/admin/patient-voice/route.ts` | Atribuir/remover clone do paciente | Servidor | **ATIVO** | `app/admin/page.tsx` | Valida na ElevenLabs; mascara na auditoria |
| `app/api/admin/voices/route.ts` | CRUD do catálogo de vozes da plataforma | Servidor | **ATIVO** | `app/admin/page.tsx` | Devolve `elevenLabsVoiceId` cru ao Admin (por desenho) |
| `app/api/settings/route.ts` | Settings do paciente | Servidor | **ATIVO** | Ajustes | Recusa explicitamente `VOICE_SETTING_KEYS` |
| `lib/voice.ts` | Domínio da autoria vocal (`speakerRole`, `patientCloneAllowed`, cache key) | Ambos | **ATIVO** | `useSpeech`, `/api/tts`, telas | Núcleo conceitual — bom ponto de partida da Fase 5 |
| `lib/voice-catalog.ts` | Catálogo + resolução de voz (servidor) | Servidor | **ATIVO** | rotas de voz | Fonte única de resolução; `ensureSeeded` migra `ELEVENLABS_HELO_VOICE_ID` |
| `lib/useSpeech.ts` | Orquestrador de voz do cliente (TTS, cache, fallback, amplitude) | Cliente | **ATIVO** | `lib/helo-state.tsx` (instância única) | ObjectURLs nunca revogados — ver `R-06` |
| `lib/audio-coordinator.ts` | Gate global de áudio e hierarquia de prioridade | Cliente | **ATIVO** | `useSpeech`, `helo-agent-provider`, telas | Módulo-nível; funciona fora do React |
| `lib/helo-state.tsx` | Provider de voz global + modos | Cliente | **ATIVO** | App inteiro | Uma só instância de `useSpeech` |
| `components/helo-agent-provider.tsx` | Sessão WebRTC do Agent Helo, client tools, player de música, UI do cuidador | Cliente | **ATIVO** | `palco-layout-client` | 2230 linhas; concentra transporte, tools, UI e música — ver §13 |
| `lib/helo-action-registry.ts` | Registro vivo das ações clicáveis da tela | Cliente | **ATIVO** | 8 telas + provider | Ponte Agent → UI |
| `lib/helo-client-tools.ts` | Contrato fechado de áreas/seções/permissões | Ambos | **ATIVO** | provider + rota de autorização | Bom modelo para o action registry da Fase 5 |
| `lib/helo-screen-context.ts` | Sub-estado da tela reportado ao Agent | Cliente | **ATIVO** | `rotina` | Só a Rotina publica hoje |
| `lib/phrase-audio.ts` | Evento que suspende o mic durante áudio gravado | Cliente | **ATIVO** | `phrases-to-listen-modal`, `gerenciar` | 8 linhas |
| `lib/useWelcomeAudio.ts` | Áudio pré-login (`/bem-vindo.mp3`) | Cliente | **ATIVO** | `welcome-orb` | **Não** passa pela ElevenLabs, por regra de produto |
| `components/helo-voice-settings.tsx` | UI de configuração de voz | Cliente | **ATIVO** | `ajustes` | — |
| `functions/index.js` → `generateMusic` | Geração de música (ElevenLabs Music API) | Servidor (Functions) | **ATIVO** | client tool do Agent | **SEM AUTENTICAÇÃO** — ver `R-03` |
| `functions/index.js` → `synthesizePhraseAudio` | Síntese e **persistência** de frases favoritas na voz do clone | Servidor (Functions) | **ATIVO** | `favorite-phrases` | Autenticado; persiste áudio do paciente — ver `R-04` |
| `functions/index.js` → `api` (`/webhook/**`) | Alias do `generateMusic` | Servidor (Functions) | **LEGADO** | compatibilidade | Herda a falta de autenticação |
| `components/supported-by.tsx`, `public/elevenlabs-logo-*.svg` | Crédito ElevenLabs Grants | Cliente | **ATIVO** | rodapé | Só marca |
| `components/orb-shader.ts` | Shader do orbe | Cliente | **ATIVO** | orb-3d | Só menciona ElevenLabs em comentário |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (`.env.local`) | — | — | **NÃO UTILIZADO** | ninguém | Variável órfã — ver `R-09` |
| `ELEVENLABS_HELO_VOICE_ID` | Voz legada da plataforma | Servidor | **PARCIAL** | `ensureSeeded`, fallback de `/api/tts`, `functions` | Substituída pelo catálogo; ainda é fallback |
| `ELEVENLABS_HELO_PLATFORM_VOICE_*_ID` + `_OVERRIDE_ENABLED` | Override de voz por sessão do Agent | Servidor | **NÃO UTILIZADO** (código vivo, caminho morto) | `conversation-token` | Ver `R-11` |
| `getCurrentHeloActions` / `getVisibleHeloActions` | Mesmo handler, dois nomes | Cliente | **DUPLICADO** (intencional) | painel ElevenLabs | Compatibilidade de nomenclatura |
| `interactWithHeloUI` / `interactWithVisibleHeloUI` / `executeHeloAction` | Mesmo handler, três nomes | Cliente | **DUPLICADO** (intencional) | painel ElevenLabs | Idem |
| `generate_and_play_music` / `generate_music` | Mesmo handler, dois nomes | Cliente | **DUPLICADO** (alias temporário) | painel ElevenLabs | Alias declarado como temporário no código |

Nada foi removido.

---

## 3. Mapa dos endpoints e credenciais

### 3.1 `POST /api/helo/conversation-token`

| Item | Estado |
|---|---|
| Quem chama | `helo-agent-provider.connect()` e `restartForVoiceChange()` |
| Autenticação | Cookie de sessão (`requirePatientAccess`) |
| Autorização | Vínculo ativo com o `patientId` — o id do cliente **não** é confiado |
| Envia | `{ patientId, disableVoiceOverride }` |
| Recebe | `{ conversationToken, dynamicVariables, overrides?, voiceOverrideApplied }` |
| Chave secreta | `ELEVENLABS_API_KEY`, só no header `xi-api-key` da chamada servidor→ElevenLabs |
| Segredo ao cliente | **Não.** Só o token efêmero de conversa |
| TTL do token | Definido pela ElevenLabs; **não é lido, não é validado, não é renovado** pelo app |
| 401/403 | Propagados por `requirePatientAccess` |
| Timeout | **Ausente** — `fetch` sem `AbortSignal` |
| ElevenLabs indisponível | `!response.ok` → 502; exceção → 502; agente sem config → 503 |

`dynamicVariables` enviadas: `patientName`, `preferredName`, `heloPatientGreeting`,
`communicationStyle`, `responsePace`, os três rótulos de gesto, `activePatientId`,
`currentOperatorRole`, `heloLanguage`, `heloInteractionMode`. Sem histórico,
sem diagnóstico, sem documentos — coerente com o comentário do código.

### 3.2 `POST /api/tts`

| Item | Estado |
|---|---|
| Quem chama | `useSpeech.fetchElevenAudio` (todas as falas), `phrases-to-listen-modal`, prévias de `/ajustes` e `/admin` |
| Autenticação | `requireUser` |
| Autorização | `requirePatientAccess` **apenas** quando `speakerRole === "patient" && patientId` |
| Envia | `{ text≤1000, speakerRole, confirmationStatus, patientId?, previewPlatformVoiceId?, previewPatientVoice? }` |
| Recebe | `audio/mpeg` (stream), `Cache-Control: no-store`, `X-Voice-Source` |
| Chave secreta | `ELEVENLABS_API_KEY`, servidor |
| Segredo ao cliente | **Não.** O `voiceId` técnico nunca sai; só a *categoria* via `X-Voice-Source` |
| 401/403 | Propagados; 403 próprio para fala do paciente sem confirmação |
| Timeout | **Ausente** |
| ElevenLabs indisponível | Sem chave → 503 (`useSpeech` marca `elevenAvailable=false`); erro upstream → 502 |
| Rate limit | **Ausente** |

### 3.3 Demais rotas

| Rota | Auth | Autorização | Segredo | Observação |
|---|---|---|---|---|
| `GET /api/voices` | `requireUser` | vínculo p/ bloco `patient` | não | Projeção pública, sem `voiceId` |
| `POST /api/voice-preference` | `requireUser` | própria conta | não | Só ids ativos do catálogo |
| `POST /api/patient-voice-source` | `requirePatientAccess` | `selectPatientVoiceSource` se há clone | não | Auditado |
| `POST\|DELETE /api/admin/patient-voice` | `requireAdmin` | admin | valida na ElevenLabs | Auditoria mascara o id |
| `GET\|POST\|... /api/admin/voices` | `requireAdmin` | admin | valida na ElevenLabs | Devolve `elevenLabsVoiceId` cru ao Admin (por desenho) |
| `POST /api/helo/client-tools` | `requirePatientAccess` | permissão declarada pela ação | não | Não escreve dado |
| `POST /generateMusic` (Function) | **NENHUMA** | **NENHUMA** | usa `ELEVENLABS_API_KEY` | `R-03` |
| `POST /webhook/**` (Function `api`) | **NENHUMA** | **NENHUMA** | idem | `R-03` |
| `POST /synthesizePhraseAudio` (Function) | cookie `__session` | vínculo + `createActivities`; texto tem de bater com a frase gravada | usa `ELEVENLABS_API_KEY` | `R-04` |

### 3.4 Confirmações pedidas explicitamente

| Afirmação | Veredito | Evidência |
|---|---|---|
| Nenhuma API key privada da ElevenLabs vai ao navegador | ✅ **Confirmado** | Única var `NEXT_PUBLIC_*` usada é `NEXT_PUBLIC_GENERATE_MUSIC_URL` (uma URL pública). `ELEVENLABS_API_KEY` só aparece em rotas de servidor e em `functions/` |
| Nenhum token de conversa no IndexedDB | ✅ **Confirmado** | `lib/offline/types.ts` lista `conversationtoken` em `CAMPOS_PROIBIDOS`; `assertPayloadSemSegredo` roda em profundidade antes de gravar |
| Nenhum token de conversa na fila offline | ✅ **Confirmado** | mesma guarda; nenhum caminho de voz enfileira operação |
| Nenhum token cacheado pelo Service Worker | ✅ **Confirmado** | `public/sw.js:174` retorna cedo para `/api/`; teste `tests/e2e/offline-app-shell.spec.ts` "R9" cobre as duas rotas |
| `/api/**` fora do cache | ✅ **Confirmado** | idem |
| Logs não imprimem segredos | ⚠️ **Confirmado com ressalva** | `[HELO AGENT] voice override` só loga booleanos. **Mas**: `/api/tts` loga o corpo de erro cru da ElevenLabs (pode ecoar o `voice_id`), e `[HELO MUSIC] playback started` loga a `audioUrl` de download durável **no console do navegador** — ver `R-07` |

---

## 4. Inventário do Agent Helo

### 4.1 Ciclo de vida

- **Inicialização**: `HeloAgentProvider` monta acima das páginas
  (`palco-layout-client`). A sessão só abre por ação explícita —
  `connect()`, disparado pelo botão "Conectar com Helo" ou pela ação
  `helo.conectar` do registry.
- **Token**: `POST /api/helo/conversation-token`; o SDK abre WebRTC com
  `connectionType: "webrtc"`.
- **Encerramento**: `end()` → `stopGeneratedMusic()` → `clearLocalSessionState()`
  → `endSession()` (só `if (wasStarted)` — ver `R-05`).
- **Gatilhos de encerramento**: desmontagem do provider, `beforeunload`, evento
  `helo-agent-stop` (logout), troca de paciente ativo, e saída de `/helo`
  quando o assistente persistente está desligado.
- **Navegação**: por **`router.push`** com rotas de uma tabela fechada
  (`HELO_AREA_ROUTES`) — nunca por URL livre, DOM ou clique simulado. As ações
  de tela vão pelo **Action Registry**, chamando o **mesmo handler do clique
  manual**. Este é o ponto mais bem resolvido da integração atual.
- **Página inexistente**: impossível — `resolveHeloNavigationArea` só devolve
  áreas do enum; o resto vira `"Área de navegação inválida"`.
- **Perda de conexão**: `onDisconnect` → `connectionStatus="offline"`,
  `clearLocalSessionState()`, e mensagem ao cuidador se `reason !== "user"`.
- **Microfone negado**: `describeConversationError` reconhece `NotAllowedError`
  e devolve texto acionável. `refreshInputDevices` distingue negação de falha.
- **Sessão expirada**: **não tratado**. Não há renovação de token nem detecção
  específica — cai no caminho genérico de `onError`/`onDisconnect`.
- **Troca de paciente**: efeito em `helo-agent-provider.tsx:1456` encerra a
  conversa e avisa. `authorizeTool` revalida o paciente ativo **depois** da
  resposta do servidor, fechando a janela de troca durante a autorização.

### 4.2 Ferramentas expostas ao Agent (client tools)

| Nome | Entrada | Ação | Poder de alteração | Risco | Exige confirmação? |
|---|---|---|---|---|---|
| `navigateHeloArea` | `targetArea\|area\|target\|name` | `router.push` p/ área do enum | Navegação | BAIXO | Não |
| `openPatientSettings` | `section` (enum) | Abre `/ajustes?section=` | Navegação | BAIXO | Não |
| `openRoutineMode` | — | Área `rotina` | Navegação | BAIXO | Não |
| `openEmergencyMode` | — | Área `emergencia` | Navegação | MÉDIO | Devolve `requiresUserConfirmation: true`, mas **não bloqueia** |
| `openActivitiesMode` | — | Área `atividades` (delega a `activity.goToActivityMenu` se montado) | Navegação | BAIXO | Não |
| `showGestureChoices` | — | Destaca a barra de gestos por 8 s | Visual | BAIXO | Não |
| `getCurrentHeloActions` / `getVisibleHeloActions` | — | **Leitura** do registry + varredura de `button, a` do DOM | Nenhum | MÉDIO (exposição) | Não |
| `interactWithHeloUI` / `interactWithVisibleHeloUI` / `executeHeloAction` | `actionId` (7 aliases) + `payload` | Executa o handler real da ação | **ALTO — ver 4.3** | **CRÍTICO** | Não |
| `generate_and_play_music` / `generate_music` | `prompt`, `genre`, `duration_seconds` | Chama `/generateMusic`, grava na playlist, toca | Escreve em `patients/{id}/playlist` | ALTO (custo + escrita) | Não |
| `play_existing_music` | `date_reference`, `period`, `genre` | Busca e toca faixa do histórico | Leitura | BAIXO | Não |
| `checkUserSilence` | — | Política de lembretes de silêncio | Nenhum | BAIXO | Não |

Observação sobre `getCurrentHeloActions`: além do registry, ele devolve
`localElements` — **todo `<button>` e `<a>` visível, com o `textContent`**. Isso
manda ao provedor externo o texto de tela do paciente (incluindo, em telas de
conversa, frases sendo compostas). Não é segredo técnico, mas é conteúdo
clínico saindo para um terceiro sem necessidade demonstrada. `MÉDIO`.

### 4.3 Ações executáveis via registry (o poder real do Agent)

| Tela | `actionId` | O que faz | Classe |
|---|---|---|---|
| `/helo` | `helo.conectar`, `helo.encerrar`, `helo.solicitarMicrofone` | Sessão/mic | Operacional |
| `/helo` | `gesto.confirmar` \| `gesto.reformular` \| `gesto.recusar` | `markGesture()` → `sendUserMessage` + `logEvent(confirmacao\|reformulacao\|descarte)` | **PROIBIDA** |
| `/rotina` | `routine.open.{key}` | Abre o card | Navegação |
| `/rotina` | `routine.answer.{key}.{yes\|maybe\|no}` | `answer()` → **fala na voz do paciente** + registro | **PROIBIDA** |
| `/rotina` | `routine.backToMenu` | Voltar | Navegação |
| `/conversa` | `conversa.comecar`, `.repetir`, `.continuar`, `.encerrar`, `.pausar`, `.retomar`, `.voltar`, `.gestoIncerto` | Condução | Operacional / Sensível (`encerrar`) |
| `/conversa` | `gesto.confirmar` \| `.reformular` \| `.recusar` | `onConfirmGesture` / `onQuestionGesture` → **fala na voz do paciente** | **PROIBIDA** |
| `/conversa` | `conversa.opcao.{n}` | Seleciona opção | Operacional |
| `/emergencia` | `emergencia.item.{key}` | `trigger()` → **fala de emergência na voz do paciente** + registro | Sensível (por regra de produto, o toque é a confirmação) |
| `/emergencia` | `emergencia.editar.{id}` | Navega para edição | Operacional |
| `/atividades` | `atividades.iniciar.{id}`, `.gerenciar`, `.criar`, `.voltarLista`, `.frases.*`, `.editar.{id}` | Sessões e conteúdo | Operacional |
| Player | `atividades.resposta.{n}.{gesture}`, `atividades.resposta.pergunta`, `atividades.concluir`, `atividades.encerrar`, `.anterior`, `.proxima` | Respostas → **fala na voz do paciente**; conclusão de sessão | **PROIBIDA** / Sensível |
| Modal de frases | `atividades.frases.ouvir`, `.anterior`, `.proxima` | **Fala na voz do paciente** | Sensível |
| `helo-dialog` | `dialog.confirm`, `dialog.cancel` | Confirma diálogos modais — inclusive os de saída de sessão | **Sensível** |

`dialog.confirm` merece destaque: é a ação que o Agent pode usar para
**responder afirmativamente à confirmação que existia justamente para proteger
uma ação sensível** (ex.: "Editar este item encerra a sessão atual").

---

## 5. Mapa das vozes do Helo

### 5.1 As quatro fontes

| # | Fonte | Onde vive | Escopo | Quem altera |
|---|---|---|---|---|
| A | **Voz da plataforma (sistema/assistente)** | `platformVoices` (Firestore), doc do catálogo | Global (padrão) + por usuário | Admin cadastra; usuário escolhe entre as ativas |
| B | **Preferência de voz do usuário** | `users.platformVoiceId` | **Por usuário** — nunca afeta os outros | O próprio usuário (`/api/voice-preference`) |
| C | **Voz clonada do paciente** | `patients/{id}/settings/voice_id` | **Por paciente** (subcoleção) | **Somente Admin** (`/api/admin/patient-voice`) |
| D | **Fonte das falas do paciente** | `patients/{id}/settings/patient_voice_source` + `patient_voice_platform_id` | Por paciente | Vínculo ativo; `selectPatientVoiceSource` se há clone |
| E | Voz do **Agent** (conversa WebRTC) | Configurada **no painel da ElevenLabs** | Global do agente | Fora do app (override existe mas está morto — `R-11`) |
| F | Voz do **navegador** (`speechSynthesis`) | SO do usuário | Fallback | Só em Emergência |
| G | **`/bem-vindo.mp3`** | `public/` | Pré-login | Estático; nunca ElevenLabs |

Além de `heloVoicePreference` (`female`/`male`) — preferência **semântica** do
Agent, salva tanto no paciente (`helo_voice_preference`) quanto no usuário.
Hoje ela alimenta apenas o override morto.

### 5.2 Cascatas de fallback (todas resolvidas **no servidor**)

**Falas do paciente** — `resolvePatientVoice(patientId)`:

```
source="clone" e clone existe  → clone do paciente        (patientElevenLabsClone)
   ↓ senão
platformVoiceId escolhido e ativo → voz do catálogo        (platformCatalogVoice)
   ↓ senão
voz padrão do catálogo            → voz padrão             (platformCatalogVoice)
   ↓ senão (catálogo vazio)
ELEVENLABS_VOICE_ID ou DEFAULT_VOICE → fallback declarado  (approvedFallback)
```

**Voz da plataforma** — `resolvePlatformVoiceForUser(user)`:

```
preferência do usuário, se ainda ativa → heloElevenLabs
   ↓ senão
voz padrão do catálogo                 → heloElevenLabs
   ↓ senão
ELEVENLABS_HELO_VOICE_ID ou DEFAULT_VOICE → heloElevenLabs
```

Em nenhum ponto a cascata cai no clone de **outro** paciente. Isso é garantido
estruturalmente (subcoleção por paciente), não por convenção.

### 5.3 Efeito da troca de paciente

- `useSpeech` valida `patientId === activePatientId()` **antes** de falar e
  **antes** de aquecer o cache — uma fala do paciente fora do contexto ativo é
  bloqueada com `"erro"`.
- A chave de cache inclui papel **e** paciente (`audioCacheKey`) — áudio de um
  paciente nunca responde por outro.
- A sessão do Agent é encerrada na troca.
- **Mas**: o cache de blobs não é limpo na troca (ver `R-06`).

### 5.4 Fluxo textual

```
conteúdo (frase, pergunta, item de modo)
    │
    ├─ a tela declara AUTORIA: speakerRole ("helo" | "patient")
    │  + confirmationStatus + patientId          ← declarado pelo CLIENTE  ⚠ R-01
    ▼
lib/useSpeech.speak()
    │
    ├─ [1] GATE GLOBAL  lib/audio-coordinator.canPlatformSpeak()
    │        paciente > Agente > plataforma;  MUTE vence tudo
    │        exceção: priority "patientEmergency" | "patientResponse"
    ├─ [2] valida paciente ativo
    ├─ [3] patientCloneAllowed(speakerRole, confirmationStatus)   ⚠ R-01
    ├─ [4] cache por (papel, paciente, texto)  → HIT ⇒ toca
    ▼
POST /api/tts   (servidor)
    │
    ├─ requireUser  (+ requirePatientAccess se paciente)
    ├─ patientCloneAllowed  — mesma regra, mesmo dado do cliente  ⚠ R-01
    ├─ resolve voiceId:  voice-catalog.resolvePatientVoice / resolvePlatformVoiceForUser
    ▼
api.elevenlabs.io /v1/text-to-speech/{voiceId}
    model eleven_multilingual_v2 · stability .55 · similarity .75 · speed .92
    ▼
audio/mpeg  +  X-Voice-Source  +  Cache-Control: no-store
    ▼
Blob → URL.createObjectURL → <audio> único → AnalyserNode → destino
                                                     │
                                                     └─ getAmplitude() → Orb
    ▼
falhou?  →  Emergência: speechSynthesis pt-BR, identificado como approvedFallback
            fora dela: falha em silêncio (regra de produto)
```

---

## 6. Auditoria do invariante de autoria

O portão formal — `lib/confirmed-patient-statement.ts` — é **excelente**. Marca
por `Symbol` não exportado, aceita só um `OptionConversationFinalStatement`
persistido, recusa `TALVEZ`/`NÃO`, exige `presentedText` (texto congelado), e
confere `origin`/`interactionMode` nos dois sentidos.

**O problema não é o portão. É que o canal de voz não passa por ele.**

| # | Regra | Estado | Evidência |
|---|---|---|---|
| 1 | Rascunho nunca é fala do paciente | ✅ | `presentedText`, nunca `currentText` |
| 2 | Transcrição nunca é fala confirmada | ✅ (por ausência) | `VOICE_TRANSCRIPTION` não é aceito (`IMPLEMENTED_QUESTION_SOURCES`); não existe STT |
| 3 | Texto do cuidador não é fala confirmada antes do paciente | ⚠️ | Verdadeiro no fluxo 4.x; **falso** em `/api/tts`, que aceita qualquer texto com `confirmationStatus:"confirmed"` |
| 4 | Contexto de sessão nunca é fala do paciente | ✅ | `session-context` é entidade separada |
| 5 | Interpretação do cuidador exige o SIM | ✅ no domínio | `origin=CAREGIVER_INTERPRETATION` + `textFormulatedBy` preservados |
| 6 | MAYBE nunca confirma | ✅ no domínio / ⚠️ no canal | `confirmedResponse !== "YES"` recusa; mas o Agent pode acionar `routine.answer.*.yes` |
| 7 | NO nunca confirma | ✅ / ⚠️ | idem |
| 8 | **Só `ConfirmedPatientStatement` representa fala confirmada** | ❌ **VIOLADO no canal de voz** | `/api/tts` nunca vê um `ConfirmedPatientStatement`. Recebe uma **string** |
| 9 | Retry/sync nunca alteram autoria | ✅ | `projection.ts` recusa qualquer patch que resulte em `CONFIRMED` |
| 10 | O Agent nunca fabrica resposta do paciente | ❌ **VIOLÁVEL** | `interactWithHeloUI` → `gesto.confirmar` / `routine.answer.*` |

### Caminhos que hoje podem violar

**`V1` — a confirmação é um campo, não uma prova.** (`R-01`, CRÍTICO)
`/api/tts:69-70` lê `speakerRole` e `confirmationStatus` do corpo da
requisição. `patientCloneAllowed` verifica o *valor que o chamador enviou*.
Qualquer usuário autenticado com vínculo pode POSTar 1000 caracteres
arbitrários com `speakerRole:"patient", confirmationStatus:"confirmed"` e
receber o áudio na **voz clonada da pessoa**. O bloqueio "de domínio, não só de
interface" descrito no comentário do arquivo é real quanto à *localização*
(está no servidor), mas não quanto à *fonte da verdade*.

**`V2` — o Agent pode causar a fala confirmada.** (`R-02`, CRÍTICO)
`resolveRequestedUIAction` (provider, linhas 313-352) monta candidatos
`${actionId}.${gesture}` a partir de campos livres (`gesto`, `resposta`,
`answer`, `choice`, `value`…). O registry tem uma proteção — `AMBIGUOUS_GESTURE_TOKENS`
recusa casar um pedido cujo único token de conteúdo seja "sim"/"nao"/"talvez"
— **mas ela só cobre o casamento difuso por token**. O `actionId` exato
(`gesto.confirmar`, `routine.answer.agua.yes`) passa pelo caminho 1 do
`findHeloUIAction` sem tocar nessa proteção. Consequência concreta: o cuidador
diz "clica no sim da água"; o Agent chama a tool; a **voz clonada do paciente
diz "Sim, quero tomar água"** e um evento `confirmacao` é gravado — sem que o
paciente tenha feito gesto nenhum.

**`V3` — frases favoritas na voz do clone, persistidas.** (`R-04`, ALTO)
`functions/synthesizePhraseAudio` sintetiza com o clone e **grava o MP3** em
`patients/{id}/phrases_audio/{phraseId}.mp3` com URL pública de download e
`cacheControl: public, max-age=31536000, immutable`. Não há conceito de autoria
nem de confirmação ali. `phrases-to-listen-modal` também declara
`confirmationStatus: "confirmed"` por conta própria.

**`V4` — o registro de conversa do Agent não distingue autores.** (`R-08`, MÉDIO)
Três caminhos injetam turnos com `role: "user"` na sessão da ElevenLabs:
`markGesture` (`GESTURE_SEMANTIC_MESSAGES`), `sendCaregiverMessage` e
`speakActivityQuestion`. O texto dos dois últimos é prefixado ("Mensagem
escrita pelo acompanhante:", "Leia agora para o paciente:"), o que é uma
mitigação por *prompt*, não por *tipo*. No transcript que a ElevenLabs guarda,
fala do paciente, relato de gesto e instrução do app são todos `user`.

**`V5` — o microfone é da sala, não do paciente.** (§10)
O Agent transcreve tudo que o microfone capta. Hoje o texto transcrito só
alimenta `onMessage` → `resetSilenceReminderState()`; **não existe caminho
automático de "sim" transcrito → gesto registrado**. A colisão entre a palavra
"sim" do cuidador e o gesto do paciente **não acontece diretamente** — mas
acontece indiretamente, via `V2`. A separação arquitetural que a §10 pede
existe em intenção e falha no elo do action registry.

---

## 7. Mapa do TTS atual

| Pergunta | Resposta |
|---|---|
| Quem dispara | Telas (`conversa`, `rotina`, `emergencia`, `mensagem`, `atividades`), `helo-state.playIntro/enterMode`, prévias de Ajustes/Admin, modal de frases |
| Quando | Entrada em modo, pergunta apresentada, confirmação, resposta do paciente, prévia, aquecimento (`prime`) |
| Qual voz | Resolvida no servidor pela autoria (§5.2) |
| Sobreposição | **Impossível por construção**: `speak()` chama `stop()` antes de iniciar; elemento `<audio>` único; `genRef` invalida falas em preparação |
| Interromper | `stop()` — local, ou global via `stopAllPlatformAudio()` (mute, logout, Agente ativo, prioridade do paciente) |
| Repetir | Por ação de tela (`conversa.repetir`, `atividades.frases.*`) — não há API genérica |
| Trocar de tela | `setActiveMode` chama `stop()`; `enterMode` idem |
| Pausar sessão | `/conversa` desabilita as ações; **a fala em curso não é interrompida** pelo pause |
| Encerrar sessão | `stop()` via troca de modo / navegação |
| Trocar paciente | Fala do paciente é bloqueada por validação de contexto; **o cache não é limpo** |
| Refresh | Tudo se perde (estado em memória) — comportamento correto |
| Áudio armazenado | Em memória (`Map` de ObjectURLs) durante toda a vida da aba. Em disco: só via `synthesizePhraseAudio` (Storage) |
| Blob/ObjectURL liberado | **Não.** `URL.revokeObjectURL` nunca é chamado em `useSpeech` — `R-06` |
| Vazamento de memória | **Sim**, confirmado (`R-06`). Também em `ajustes:283` e `admin:967` |
| Erros | Emergência mostra estado visível (`falando`/`erro`/`silenciada`); fora dela a falha é silenciosa por regra de produto |

Pontos fortes que a Fase 5 deve preservar: o watchdog de 2,5 s para
`play()` pendente, o de 3 s para `speechSynthesis`, o `settleRef` que resolve
cada fala exatamente uma vez, e o `genRef` que impede áudio "atrasado" de tocar
depois de interrompido. São defesas contra falhas reais de navegador, não
ornamento.

---

## 8. Mapa do STT / microfone atual

### **NÃO IMPLEMENTADO** — no sentido de captura própria.

Verificado por varredura: não existe `SpeechRecognition`, `MediaRecorder`,
`AudioWorklet`, `createScriptProcessor`, nem chamada a qualquer API de
speech-to-text.

O que existe:

| Item | Estado |
|---|---|
| Quem pode ativar | Só o cuidador, e só por gesto explícito ("Conectar com Helo") |
| Finalidade | Conversa por voz com o Agent — **não** ditado, **não** transcrição para o produto |
| Para onde vai o áudio | Direto do navegador para a ElevenLabs por WebRTC. **Não passa pelo servidor da Helo** |
| Áudio bruto armazenado | Não pelo app. O que a ElevenLabs retém é política do provedor — **não auditado aqui** |
| Onde fica o transcript | Na ElevenLabs. O app só recebe `onMessage({message, role})` e **não persiste** |
| Como é revisado | Não é. Não vira conteúdo do produto |
| Como é cancelado | `setMuted(true)` (mute do agente também corta a entrada), `end()`, troca de paciente, logout |
| Permissões | `getUserMedia` pedido só em `connect()` e em `helo.solicitarMicrofone`; streams de permissão têm os tracks parados no `finally`; `enumerateDevices` com preferência persistida em `localStorage` (`heloAgentInputDeviceId`) |

**Conclusão para o contrato**: o contrato de STT desejado (§8 do briefing) está
**inteiramente por construir**, e isso é uma boa notícia — não há legado para
desfazer. A única decisão herdada a respeitar é que o modelo de dados já reserva
`VOICE_TRANSCRIPTION` como `QuestionSource` **não aceito**; a Fase 5.2 deve
ativá-lo com nascimento em rascunho, e não criar um caminho paralelo.

---

## 9. Comandos de voz — classificação

Não existem "comandos" declarados: existe o par
`getCurrentHeloActions` + `interactWithHeloUI` sobre o Action Registry. A
classificação abaixo é do **efeito**, não da nomenclatura.

### A. Navegação segura
`navigateHeloArea`, `openPatientSettings`, `openRoutineMode`,
`openActivitiesMode`, `navigate-*` (9 rotas globais), `routine.backToMenu`,
`atividades.voltarLista`, `conversa.voltar`, `activity.goToActivityMenu`,
`showGestureChoices`, `getCurrentHeloActions`.

### B. Ação operacional
`conversa.comecar`, `conversa.repetir`, `conversa.continuar`,
`conversa.pausar`/`retomar`, `conversa.gestoIncerto`, `conversa.opcao.{n}`,
`atividades.iniciar.{id}`, `atividades.anterior`/`proxima`,
`atividades.frases.abrir`/`fechar`/`anterior`/`proxima`,
`routine.open.{key}`, `helo.conectar`, `helo.solicitarMicrofone`,
`play_existing_music`, `checkUserSilence`.

### C. Ação sensível (hoje **sem** confirmação por voz)
| Comando | Efeito |
|---|---|
| `atividades.concluir` | Conclui a sessão |
| `atividades.encerrar` | Abandona a sessão |
| `conversa.encerrar` | Encerra e navega para `/` |
| `helo.encerrar` | Encerra a conversa |
| `dialog.confirm` | **Confirma qualquer modal**, inclusive o de sair de sessão |
| `openEmergencyMode` | Abre Emergência (devolve `requiresUserConfirmation` mas não bloqueia) |
| `emergencia.item.{key}` | Dispara a frase de socorro na voz do paciente |
| `atividades.editar.{id}`, `emergencia.editar.{id}`, `atividades.gerenciar`, `atividades.criar` | Levam a edição de conteúdo |
| `generate_and_play_music` | Gera áudio pago e **escreve** na playlist do paciente |

### D. Ações que deveriam ser **PROIBIDAS por voz** e hoje **não são**
| Comando | Por que é proibido | Estado |
|---|---|---|
| `gesto.confirmar` / `gesto.reformular` / `gesto.recusar` | Confirma SIM/TALVEZ/NÃO em nome do paciente | ❌ **executável** |
| `routine.answer.{key}.{yes\|maybe\|no}` | Idem + faz a voz clonada falar | ❌ **executável** |
| `atividades.resposta.{n}.{gesture}` | Idem | ❌ **executável** |
| `atividades.frases.ouvir` | Faz a voz clonada falar | ❌ executável (risco menor: texto pré-curado) |
| Fabricar resposta do paciente | — | ❌ possível pelos itens acima |
| Resolver conflito de autoria automaticamente | — | ✅ não há tool para isso (as telas de conflito da 4.9 não registram ações) |

**Nenhum comando foi adicionado nesta auditoria.**

---

## 10. Gestos do paciente × voz do cuidador

**Risco de colisão direta: BAIXO.** A palavra "sim" captada pelo microfone
segue para a ElevenLabs como turno `user` e não toca em `markGesture`,
`answer()` nem `onConfirmGesture`. Não existe listener que converta transcrição
em gesto. O registry ainda tem `AMBIGUOUS_GESTURE_TOKENS`, que impede um pedido
cujo único conteúdo seja "sim"/"talvez"/"não" de casar por similaridade.

**Risco de colisão indireta: CRÍTICO.** O que a proteção acima cobre é o
*casamento difuso*. O que ela não cobre é o `actionId` exato, e é exatamente
isso que `resolveRequestedUIAction` produz: ele **constrói** o candidato
`gesto.confirmar` a partir de campos livres do payload. O caminho é:

```
cuidador diz "pode marcar sim"
   → ElevenLabs transcreve e decide chamar interactWithHeloUI
   → resolveRequestedUIAction extrai gesture="sim" de qualquer campo string
   → tenta "…​.sim", "sim de <opção>", e os textos crus
   → findHeloUIAction casa "gesto.confirmar" por id exato
   → markGesture("sim") → logEvent(type:"confirmacao")
   → em /rotina e /atividades: a VOZ CLONADA DO PACIENTE fala
```

A separação que a §10 exige precisa deixar de ser uma lista de tokens no
matcher e virar uma **propriedade de tipo da ação**: uma ação de classe
"resposta do paciente" não deve ser alcançável por nenhum caminho originado no
Agent, independentemente de como o `actionId` foi construído.

---

## 11. Modelo de estados de voz proposto

Hoje existem **três** máquinas parciais e desconectadas:
`VoiceState` em `lib/voice.ts` (declarado, **nunca usado**), os booleanos de
`useSpeech` (`speaking`, `engine`, `activeSpeaker`, `activeVoiceSource`), e o
`status` do SDK no provider. A proposta unifica.

### Estados

| Estado | Significado | Quem controla |
|---|---|---|
| `IDLE` | Nada tocando, nada escutando | Máquina |
| `PERMISSION_PENDING` | `getUserMedia` em curso | Cuidador (gesto) |
| `PERMISSION_DENIED` | Negado — **estado terminal recuperável**, não `ERROR` | Navegador |
| `CONNECTING` | Token pedido / WebRTC abrindo | Provider |
| `LISTENING` | Sessão aberta, microfone ativo | SDK |
| `AGENT_SPEAKING` | O Agent tem a voz | SDK |
| `PLATFORM_SPEAKING` | Voz da plataforma (`speakerRole:"helo"`) | `useSpeech` |
| `PATIENT_SPEAKING` | **Voz do paciente** — prioridade máxima | `useSpeech` + `audio-coordinator` |
| `SUPPRESSED` | Voz existe mas está silenciada (mute, prioridade superior) | `audio-coordinator` |
| `INTERRUPTED` | Fala abortada por `stop()` — transitório | `useSpeech` |
| `DEGRADED` | ElevenLabs indisponível; operação manual **segue** | Máquina |
| `UNAVAILABLE` | Navegador não suporta o necessário | Detecção de capacidade |
| `ERROR` | Falha inesperada, com causa | Máquina |

Ajustes propostos ao esboço do briefing:

- `REQUESTING_PERMISSION` desdobrado em `PERMISSION_PENDING` +
  `PERMISSION_DENIED`: negar o microfone é uma escolha do usuário, não um erro,
  e não deve produzir a mesma UI que uma falha.
- `TRANSCRIBING` e `REVIEWING_TRANSCRIPT` **não entram na máquina de voz** —
  pertencem à máquina de *ditado* da Fase 5.2. Misturar as duas foi o que
  produziu, na arquitetura atual, a ambiguidade entre "o microfone está aberto"
  e "isto vai virar conteúdo".
- `SPEAKING` desdobrado em três, porque **quem fala** é a informação que o
  produto inteiro precisa e é o que hoje está espalhado por `activeSpeaker`,
  `agentSpeaking` e `patientVoiceActive`.
- `SUPPRESSED` explicitado: hoje é um efeito colateral (`setVolume({volume:0})`)
  que não aparece em estado nenhum.

### Transições proibidas (invariantes da máquina)

1. `* → PATIENT_SPEAKING` **exige** um `ConfirmedPatientStatement` (ou a
   dispensa formal da Emergência) — nunca uma string com um campo `confirmed`.
2. `AGENT_SPEAKING → PATIENT_SPEAKING` é permitido (prioridade); o inverso
   nunca acontece sem `endPatientVoiceOverride()`.
3. Nenhuma transição para qualquer estado `*_SPEAKING` a partir de uma
   client tool do Agent sem passar pelo mesmo portão da UI.
4. `DEGRADED` **nunca** bloqueia transição de estado de sessão manual.
5. `PERMISSION_DENIED → LISTENING` só por novo gesto explícito do cuidador.

### Impactos

| Evento | Efeito |
|---|---|
| Pausa da sessão | `*_SPEAKING → INTERRUPTED → IDLE`; hoje a fala em curso **não** para |
| Logout | Tudo → `IDLE`; `helo-agent-stop` + `stopAllSpeech()` (já existe); **falta** limpar o cache de blobs |
| Troca de paciente | Tudo → `IDLE`; **deve** invalidar o cache do paciente anterior |
| Mudança de página | `PLATFORM_SPEAKING → IDLE`; sessão do Agent persiste só se habilitado |
| Perda de internet | `LISTENING/AGENT_SPEAKING → DEGRADED`; sessão manual intacta |

---

## 12. Offline e fallback

| Cenário | Comportamento atual | Contrato atendido? |
|---|---|---|
| Navegador offline | `fetch` falha → erro ao cuidador; SW serve o shell de `/conversa/perguntas`; fila IndexedDB intacta | ✅ |
| ElevenLabs indisponível (rede ok) | 502; fora da Emergência, falha em silêncio | ✅ (por regra de produto) |
| `conversation-token` falha | `describeConversationError` → mensagem ao cuidador; `startedRef=false` | ✅ |
| WebSocket/WebRTC cai | `onDisconnect` → `offline` + `clearLocalSessionState()` + aviso se não foi o usuário | ✅ |
| TTS falha | Emergência → `speechSynthesis` identificado; fora dela → silêncio | ✅ |
| Microfone negado | Mensagem específica; nada mais é bloqueado | ✅ |
| Microfone some | `refreshInputDevices` limpa a seleção inválida | ✅ |
| Navegador sem suporte | `!navigator.mediaDevices?.getUserMedia` → mensagem clara | ✅ |
| Sem chave ElevenLabs (503) | `elevenAvailable=false` **para sempre nesta aba** — não há reset | ⚠️ `R-10` |

| Contrato desejado | Estado |
|---|---|
| Funcionalidades manuais seguem disponíveis | ✅ Verificado — voz e sessão manual são caminhos independentes |
| Nenhuma sessão bloqueada por falha de voz | ✅ |
| Nenhum áudio entra na `OfflineOperation` | ✅ — nenhum caminho de voz enfileira |
| Nenhum token entra na fila | ✅ — `CAMPOS_PROIBIDOS` inclui `conversationtoken` |
| Nenhum segredo no IndexedDB | ✅ — `assertPayloadSemSegredo` em profundidade |
| Agent informa indisponibilidade só ao cuidador | ⚠️ Parcial — a UI de erro vive no painel de `/helo` e no `<aside>` fixo, ambos visíveis na tela compartilhada com o paciente |
| Tela do paciente sem mensagens técnicas | ⚠️ Mesma ressalva |

---

## 13. Privacidade e dados de áudio

| Tipo | Origem | Destino | Persistência | TTL | Sensibilidade | Proteção |
|---|---|---|---|---|---|---|
| Áudio capturado (mic) | Navegador | ElevenLabs (WebRTC direto) | Não pelo app | — | **ALTA** | Retenção do provedor **não auditada** |
| Áudio TTS (plataforma) | ElevenLabs | Memória do navegador | Vida da aba | ∞ | Baixa | ObjectURL nunca revogado (`R-06`) |
| Áudio TTS (**voz do paciente**) | ElevenLabs | Memória do navegador | Vida da aba | ∞ | **ALTA** | Idem — chave inclui `patientId`, mas não é limpa |
| Áudio de frases favoritas | Function | **Firebase Storage** `patients/{id}/phrases_audio/` | **Permanente** | ∞ | **ALTA** | URL pública de download, `immutable`; sem `storage.rules` no repo (`R-04`) |
| Música gerada | Function | **Firebase Storage** `musics/` (não escopado por paciente) | **Permanente** | ∞ | Média | Idem; URL logada no console (`R-07`) |
| Transcript | ElevenLabs | Nunca persistido pelo app | — | — | **ALTA** | Fora do controle do app |
| `voiceId` do clone | Admin | `patients/{id}/settings/voice_id` | Permanente | — | **ALTA** | Nunca sai ao cliente comum; mascarado na auditoria; `/api/settings` o remove do GET |
| `voiceId` do catálogo | Admin | `platformVoices` | Permanente | — | Média | Sai cru para o **Admin** (`admin/page.tsx:1152`) |
| Token de conversa | Servidor | Memória do cliente, passado ao SDK | Transitório | ElevenLabs | Alta | Nunca em storage; bloqueado na fila offline |
| `ELEVENLABS_API_KEY` | Secret Manager | Só runtime servidor | — | — | **CRÍTICA** | Nunca no cliente |
| Preferência de microfone | Cuidador | `localStorage` `heloAgentInputDeviceId` | Permanente | — | Baixa | Não limpo no logout (prefixo não é `helo.`) |
| Preferência de mute | Usuário | `localStorage` `heloPlatformMuted` | Permanente | — | Nula | Idem |
| Áudio de boas-vindas | `public/` | `sessionStorage` `heloWelcomeAudioPlayed` | Sessão | — | Nula | — |

Varredura por destino: **localStorage** — só as duas chaves acima e os
espelhos `helo.*`; nenhuma delas com áudio, token ou `voiceId`. **IndexedDB** —
tudo cifrado (AES-GCM com escopo), guarda proibida de credenciais. **Cache API**
— só shell e estáticos. **Query strings** — nenhum dado sensível.
**Firestore** — `voiceId` do clone (isolado por subcoleção), playlist com
`audioUrl`. **Objetos globais** — `__heloAudio` e `__heloUIActions`, ambos
guardados por `NODE_ENV !== "production"`. ✅

---

## 14. Ciclo de vida — teardown

| Verificação | Estado |
|---|---|
| Microfone liberado | ✅ nos caminhos normais — `endSession()` do SDK; streams de permissão têm `getTracks().forEach(stop)` no `finally` |
| MediaStream tracks encerrados | ✅ / ❌ — ver `R-05` (sessão órfã) |
| WebSocket/WebRTC fecha | ✅ em unmount, `beforeunload`, `helo-agent-stop`, troca de paciente, saída de rota |
| Áudio em reprodução para | ✅ `stopAllPlatformAudio()` cobre todas as instâncias por registro de módulo |
| Timers cancelados | ✅ `gestureUnlock`, `gestureHighlight`, heartbeat, rAF de seek |
| Listeners removidos | ✅ mouse/touch, online/offline, `PHRASE_AUDIO_EVENT`, `helo-agent-stop`, `beforeunload` |
| ObjectURLs revogados | ❌ **`R-06`** — `useSpeech`, `ajustes:283`, `admin:967` |
| Contexto do paciente anterior eliminado | ⚠️ Estado React sim; **cache de áudio não** |
| `AudioContext` fechado | ⚠️ `useWelcomeAudio` fecha; `useSpeech` nunca (`R-12`) |
| rAF de medição | ⚠️ roda a cada frame pela vida do app, mesmo desconectado (`R-13`) |

**`R-05` em detalhe** (novo achado, ALTO): em `connect()`, se
`startLoggedSession()` (linha 1674) lançar — rede instável, 500 do servidor —
o `catch` da linha 1686 faz `startedRef.current = false` e **não** chama
`endSession()`. A sessão WebRTC já está aberta e o microfone ligado. Como
`end()` só chama `endSession()` `if (wasStarted)`, nem o botão "Encerrar"
fecha a sessão. Resultado: microfone aberto, indicador de conexão ativo, e
nenhum caminho de UI que o feche além de recarregar a página.

---

## 15. Acessibilidade e UX

| Item | Estado |
|---|---|
| Indicador de microfone | ✅ ponto colorido + barra de nível + rótulo textual |
| Estado "escutando" / "falando" | ✅ `label` derivado de `isSpeaking`/`isListening`, em `aria-live="polite"` |
| Erro de permissão | ✅ texto específico com `role="alert"` |
| Botão parar | ✅ "Encerrar conversa" (painel) e "Encerrar Helo" (aside) |
| Botão repetir | ⚠️ existe por tela (`conversa.repetir`, frases), **não** globalmente |
| Feedback de transcrição | ❌ não existe (não há STT) |
| Revisão antes de apresentar | ❌ não existe no canal de voz |
| Fallback para digitação | ✅ textarea "Mensagem para a Helo" |
| Acessibilidade por teclado | ✅ inclusive o slider de música (setas, Home, End) — bem-feito |
| `aria-label` | ✅ consistente |
| Mute da plataforma | ✅ `platform-mute-toggle`, persistido |

**Ressalva de layout, relevante para a Fase 5**: o `<aside>` do Agent é
`position: fixed` no viewport inteiro, e o painel de `/helo` mostra seletor de
microfone, medidor de nível e mensagens de erro técnicas. Em uso à beira do
leito, com uma tela só, essa é a interface do cuidador ocupando o campo de
visão do paciente. A exigência "a interface técnica deve permanecer
exclusivamente na área do cuidador" **não está estruturalmente garantida** —
não há separação de superfície paciente/cuidador no código.

---

## 16. Riscos encontrados

| # | Sev. | Risco | Local |
|---|---|---|---|
| **R-01** | **CRÍTICO** | `/api/tts` aceita `confirmationStatus` declarado pelo cliente — qualquer usuário com vínculo faz a voz clonada dizer texto arbitrário | `app/api/tts/route.ts:69-70,126-134` |
| **R-02** | **CRÍTICO** | O Agent executa ações de resposta do paciente (`gesto.*`, `routine.answer.*`, `atividades.resposta.*`) — fabrica confirmação e faz a voz clonada falar | `helo-agent-provider.tsx:313-352,979-1047` |
| **R-03** | **CRÍTICO** | `/generateMusic` e `/webhook/**` sem autenticação, com a chave da ElevenLabs e escrita em `patients/{qualquer}/playlist` | `functions/index.js:127,263,283` |
| **R-04** | **ALTO** | Áudio na voz clonada do paciente persistido em Storage com URL pública `immutable`; sem `storage.rules` versionado | `functions/index.js:86-90`; `firebase.json` |
| **R-05** | **ALTO** | Sessão WebRTC órfã com microfone aberto quando `startLoggedSession` falha | `helo-agent-provider.tsx:1674-1693,1307-1312` |
| **R-06** | **ALTO** | ObjectURLs de áudio nunca revogados; cache nunca limpo (nem no logout, nem na troca de paciente) | `lib/useSpeech.ts:217`; `ajustes:283`; `admin:967` |
| **R-07** | **MÉDIO** | URL de download durável de mídia do paciente logada no console do navegador; corpo de erro cru da ElevenLabs logado no servidor | `helo-agent-provider.tsx:702`; `api/tts/route.ts:190` |
| **R-08** | **MÉDIO** | Turnos injetados como `role:"user"` (gesto, mensagem do cuidador, instrução de leitura) — o transcript do provedor não distingue autores | `helo-agent-provider.tsx:1526-1534,1567-1589,1740` |
| **R-09** | **MÉDIO** | `getCurrentHeloActions` envia ao provedor o `textContent` de **todos** os `button`/`a` da tela | `helo-agent-provider.tsx:946-958` |
| **R-10** | **MÉDIO** | Sem timeout/abort nas chamadas servidor→ElevenLabs, com `maxInstances: 1` — poucas requisições penduradas derrubam o app | `api/tts`, `conversation-token`; `apphosting.yaml` |
| **R-11** | **BAIXO** | `elevenAvailable=false` nunca é reencapado: uma 503 transitória degrada a aba até o reload | `lib/useSpeech.ts:221` |
| **R-12** | **BAIXO** | Override de voz do Agent é caminho morto: `connect()` sempre envia `disableVoiceOverride=true`, logo `voiceOverrideApplied` é sempre `false` e o retry nunca ocorre | `helo-agent-provider.tsx:1656-1669` |
| **R-13** | **BAIXO** | `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` órfã em `.env.local`; `AudioContext` de `useSpeech` nunca fechado; rAF de medição roda sempre | `.env.local`; `useSpeech.ts:97`; `provider:1479` |
| **R-14** | **INFO** | Comentário em `.env` indica chave Anthropic previamente exposta — confirmar rotação | `.env` |

---

## 17. Arquitetura proposta para a Fase 5

Princípio: **não reescrever o que funciona.** `audio-coordinator`,
`voice-catalog`, `helo-client-tools` e `confirmed-patient-statement` ficam
como estão. As mudanças são de *fronteira*, não de motor.

```
┌─ DOMÍNIO (puro, testável sem rede) ────────────────────────────────┐
│  lib/voice.ts                    ← já existe                       │
│  lib/confirmed-patient-statement ← já existe (portão de autoria)   │
│  lib/voice/authorization.ts      ← NOVO: SpeechGrant               │
│  lib/voice/state-machine.ts      ← NOVO: §11, função pura          │
└────────────────────────────────────────────────────────────────────┘
┌─ TRANSPORTE (uma camada só) ───────────────────────────────────────┐
│  lib/voice/provider.ts           ← NOVO: interface VoiceProvider   │
│    ├ ElevenLabsProvider          ← extraído das rotas atuais       │
│    └ MockProvider                ← para teste, sem chave           │
│  lib/voice-catalog.ts            ← já existe (resolução de voz)    │
└────────────────────────────────────────────────────────────────────┘
┌─ APLICAÇÃO ────────────────────────────────────────────────────────┐
│  useSpeech            ← mantém; passa a emitir estados da máquina  │
│  helo-agent-provider  ← FATIAR em 4 (ver abaixo)                   │
│  helo-action-registry ← ganha classificação de ação                │
└────────────────────────────────────────────────────────────────────┘
```

### As quatro decisões estruturais

**1. `SpeechGrant` — a autorização vira valor, não campo.**
Substitui o par `(speakerRole, confirmationStatus)` no corpo da requisição por
um **grant emitido pelo servidor**: opaco, de curta duração, ligado a
`(patientId, hash do texto, origem da confirmação)`. Quem quer que a voz do
paciente fale precisa apresentar o grant; `/api/tts` deixa de acreditar em
quem pede. Emitido a partir de um `ConfirmedPatientStatement` (fluxo 4.x) ou da
dispensa formal da Emergência. Fecha `R-01` e é o único caminho que satisfaz de
verdade a regra 8.

**2. Classificação da ação no registry.**
`HeloUIAction` ganha `class: "navigation" | "operational" | "sensitive" | "patientResponse"`.
A regra é de tipo, não de string: `patientResponse` é **inalcançável** por
qualquer chamada originada no Agent; `sensitive` exige confirmação humana
explícita. Fecha `R-02` e §10 sem depender de listas de tokens.

**3. Fatiar `helo-agent-provider.tsx` (2230 linhas) em quatro.**
Não por estética — porque hoje transporte, registro de tools, player de música
e UI do cuidador compartilham 40 refs mutáveis, e essa é a razão pela qual
`R-05` existe e passou despercebido.
`helo-agent-session.tsx` (transporte e ciclo de vida) ·
`helo-agent-tools.ts` (registro e despacho) ·
`helo-music-player.tsx` (independente do Agent) ·
`helo-agent-panel.tsx` (UI do cuidador, isolável da superfície do paciente).

**4. `VoiceProvider` como interface.**
Uma abstração, não uma hierarquia. Existe para que o teste rode sem chave paga
e para que os dois consumidores de TTS de hoje (rota Next e Cloud Function)
parem de resolver voz de dois jeitos diferentes.

**Explicitamente fora**: não criar camadas de "serviço" genéricas, não abstrair
o `audio-coordinator` (já é bom), não introduzir biblioteca de máquina de
estados (a máquina cabe numa função pura de ~80 linhas).

---

## 18. Estratégia de testes

| Nível | Escopo | Depende da ElevenLabs? |
|---|---|---|
| **A. Unitário / domínio** | `SpeechGrant` (emissão/verificação/expiração), máquina de estados (transições permitidas e **proibidas**), `patientCloneAllowed`, `audioCacheKey`, resolução do catálogo, `findHeloUIAction` com a classificação nova | Não |
| **B. HTTP** | `/api/tts` (403 sem grant; 403 com grant de outro paciente; 403 com grant expirado; 200 com grant válido), `conversation-token` (401/403/502/503), `client-tools`, `/generateMusic` **com** autenticação | Não — `MockProvider` |
| **C. Playwright + provider mockado** | Fluxo completo de fala, gate de prioridade, mute, troca de paciente, degradação | Não |
| **D. Permissões de microfone** | `--use-fake-device-for-media-stream`; concedido, negado, dispositivo removido | Não |
| **E. Interrupção / reconexão** | `stop()` durante o fetch, watchdogs, queda de WebRTC, `R-05` (falha do log de sessão **não** deixa sessão órfã) | Não |
| **F. Autoria** | **O mais importante.** O Agent **não consegue** acionar `patientResponse`; `/api/tts` recusa fala do paciente sem grant; `MAYBE`/`NO` nunca produzem fala confirmada; a voz clonada nunca soa antes do gate | Não |
| **G. Smoke real** | Um roteiro manual: conectar, uma frase na voz da plataforma, uma na do paciente, encerrar | **Sim** — sob condições estritas |

O smoke real: script dedicado (`npm run smoke:voice`), **fora** de
`test:*` e fora do CI, exigindo variável de ambiente explícita
(`HELO_SMOKE_ELEVENLABS=1`), sem imprimir segredo algum (só `X-Voice-Source`,
status e duração), em ambiente de desenvolvimento com paciente de teste.

O padrão da Fase 4.9 — scripts `.mjs` de domínio + Playwright em lotes — deve
ser mantido; a Fase 5 acrescenta arquivos ao mesmo modelo, não um novo runner.

---

## 19. Arquivos que provavelmente serão alterados

**Alteração certa**
`app/api/tts/route.ts` · `components/helo-agent-provider.tsx` (fatiado) ·
`lib/helo-action-registry.ts` · `lib/useSpeech.ts` · `functions/index.js` ·
`lib/voice.ts`

**Arquivos novos**
`lib/voice/authorization.ts` · `lib/voice/state-machine.ts` ·
`lib/voice/provider.ts` · `components/helo-agent-session.tsx` ·
`components/helo-agent-tools.ts` · `components/helo-music-player.tsx` ·
`components/helo-agent-panel.tsx` · `storage.rules` ·
`scripts/test-voice-*.mjs` · `tests/e2e/voz-*.spec.ts`

**Alteração provável (consumidores da autoria)**
`app/(palco)/rotina/page.tsx` · `app/(palco)/conversa/page.tsx` ·
`app/(palco)/emergencia/page.tsx` · `app/mensagem/page.tsx` ·
`components/activity-player.tsx` · `components/phrases-to-listen-modal.tsx` ·
`app/api/helo/conversation-token/route.ts` · `firebase.json`

**Alteração improvável (não tocar sem motivo)**
`lib/audio-coordinator.ts` · `lib/voice-catalog.ts` ·
`lib/confirmed-patient-statement.ts` · `lib/helo-client-tools.ts` ·
`public/sw.js` · `lib/offline/**`

**Congelado (Fase 4.9)**
`lib/offline/**` · `public/sw.js` · `components/realtime-questions/**` ·
`lib/option-conversation-*` — a voz se adapta a eles.

---

## 20. Divisão recomendada da implementação

### 5.1 — TTS e o portão de autoria
Fecha `R-01`, `R-06`, `R-10`, `R-11`.
`SpeechGrant` no domínio; `/api/tts` passa a exigi-lo; consumidores migrados
tela a tela; ciclo de vida dos blobs (revogação, limpeza no logout e na troca
de paciente); `AbortSignal` nas chamadas à ElevenLabs.

*Aceite*: nenhum caminho faz a voz clonada falar sem grant válido; `/api/tts`
devolve 403 para grant ausente, expirado ou de outro paciente; nenhum ObjectURL
sobrevive ao logout; testes A, B e F verdes.
*Risco de regressão*: **ALTO** — toca todas as telas que falam.

### 5.2 — STT / ditado do cuidador
Terreno novo (nada a desfazer).
Ditado como ferramenta **do cuidador**; transcript nasce `DRAFT` com
`source: VOICE_TRANSCRIPTION`; revisão humana obrigatória; áudio bruto não
persistido; indisponibilidade nunca bloqueia o manual.

*Aceite*: nenhum transcript alcança `CONFIRMED` sem passar pelo portão da 4.x;
nenhum áudio bruto em Storage ou IndexedDB; ditado desligado ⇒ operação
idêntica à de hoje; testes A, C, D verdes.
*Risco de regressão*: **BAIXO** — funcionalidade aditiva.

### 5.3 — Agent Helo e comandos
Fecha `R-02`, `R-08`, `R-09`; fatia o provider.
Classificação de ações; `patientResponse` inalcançável pelo Agent;
confirmação humana para `sensitive`; turnos injetados deixam de ser `role:"user"`;
`localElements` restrito ao registry.

*Aceite*: nenhuma ação `patientResponse` é executável por client tool, por
nenhum `actionId`, alias ou payload; `dialog.confirm` exige gesto humano;
o transcript distingue autores; testes A, C, F verdes.
*Risco de regressão*: **ALTO** — o Agent perde capacidades que hoje usa.

### 5.4 — Resiliência e segurança
Fecha `R-03`, `R-04`, `R-05`, `R-07`, `R-13`.
Autenticação em `generateMusic`; `storage.rules` versionado; escopo por paciente
para a música; retenção/TTL do áudio persistido; `R-05`; higiene de logs;
separação de superfície paciente/cuidador (§15).

*Aceite*: nenhum endpoint com a chave da ElevenLabs responde sem autenticação;
`storage.rules` no repositório e aplicada; nenhuma sessão órfã em falha do log;
nenhuma URL de mídia no console; nenhuma UI técnica na superfície do paciente;
testes B e E verdes.
*Risco de regressão*: **MÉDIO** — o cliente do `generateMusic` muda.

### 5.5 — Validação final
Regressão completa (4.9 + 5.x), smoke real controlado, auditoria de fechamento.

*Aceite*: toda a suíte da 4.9 verde e inalterada; suíte da 5 verde; smoke real
executado uma vez e registrado sem segredos; documento de fechamento com as 10
regras de autoria verificadas uma a uma.
*Risco de regressão*: **BAIXO**.

---

## 21. Estado do repositório

```
$ git status -sb
## rescue-imported-2026-08-02...origin/rescue-imported-2026-08-02
?? docs/fase-5.0-voz-auditoria.md
```

Nenhum arquivo de produto foi alterado. Nenhum commit foi criado. Nenhum push.
O único arquivo novo é este documento.
