Helo é um aplicativo de comunicação assistiva criado para ajudar pessoas com Parkinson ou limitações severas de fala a expressarem pensamentos, vontades, sentimentos e mensagens por meio de escolhas simples, gestos confirmados e apoio de IA.

O sistema apresenta opções de frases contextualizadas, permite seleção por gestos ou sinais adaptáveis e protege a autoria do paciente por meio de confirmação contínua, consentimento e registro do processo comunicacional.

Helo não fala pelo paciente. Helo cria um caminho entre o que a pessoa sente e aquilo que ela ainda deseja dizer.

## Como funciona

O paciente responde com **3 gestos** — 👍 Sim · ✋ Talvez · ✊ Não — e o assistente
(familiar, cuidador, profissional) seleciona na tela o gesto observado. A cada
passo, o Helo apresenta no máximo 3 opções por vez, lidas em voz alta.

**O Helo nunca fala, deduz ou decide pelo paciente.** Toda mensagem passa por
confirmação (dupla, em temas sensíveis) antes de ser falada, salva ou compartilhada.
Quando a árvore de opções curadas se esgota, o Helo pode sugerir até 3 novas
opções por IA — sempre sinalizadas como sugestão, nunca apresentadas como se
fossem a vontade do paciente.

## Os cinco modos

A experiência do paciente vive num **palco persistente** (grupo de rotas
`app/(palco)`): um único canvas WebGL com os orbes dos modos, que nunca
desmonta ao navegar. O orbe do modo ativo fica no centro; as páginas são só a
camada de conteúdo, em overlay. A ordem e os metadados dos modos são definidos
em `lib/helo-state.tsx`.

| Modo | Rota | O que é |
| --- | --- | --- |
| **Rotina** | `/rotina` | Frases do dia a dia, prontas para usar. **Funciona sem IA e sem rede.** |
| **Conversar** | `/conversa` | Conversa guiada: perguntas em voz, até 3 opções por vez, sugestões por IA quando a árvore curada se esgota, confirmação antes de comunicar, pausa, gesto incerto, voltar. |
| **Emergência** | `/emergencia` | Frases críticas: um toque fala na hora. **Não depende de IA nem de rede.** |
| **Atividades** | `/atividades` | Sessões personalizadas por paciente: memórias, reconhecimento, treino, exercícios. |
| **Helo** | `/helo` | Conversa por voz com o Agent conversacional da ElevenLabs (WebRTC). |

Fora do palco: `/mensagem` (construção progressiva de mensagens — frase →
parágrafo de até 3 frases → mensagem final, cada frase confirmada por gesto),
`/ajustes`, `/atividades/gerenciar`, `/dashboard`, `/admin`, `/feedback` e
`/login`.

## Rodar (desenvolvimento)

A persistência usa **Firestore**. Em dev, rode contra o **emulador** — nenhum
dado de produção é tocado. Em dois terminais:

```bash
npm install
npm run emu    # emulador do Firestore em 127.0.0.1:8080 (UI em :4000)
npm run dev    # Next.js em http://localhost:3000
```

O `.env.local` (não versionado) já aponta o app para o emulador
(`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, `GCLOUD_PROJECT=helo-app-7fbf8`).

Stack: Next.js 16 (App Router) + React 19, Tailwind 4, three.js (orbes),
firebase-admin, SDKs da ElevenLabs e da Anthropic.

## Configuração (.env)

Copie `.env.example` para `.env` e preencha. Os três papéis de voz são
distintos e **nunca se misturam** (ver "Arquitetura de voz"):

- `ELEVENLABS_API_KEY` — sem chave, o app usa a voz local do navegador em pt-BR.
- `ELEVENLABS_HELO_VOICE_ID` — voz **oficial da plataforma** (apresentação,
  perguntas, instruções, Rotina). Identidade sonora da marca; nunca a voz de
  um paciente.
- `ELEVENLABS_VOICE_ID` — voz neutra de **fallback aprovado** para falas do
  paciente que ainda não têm clone configurado. A voz clonada de cada paciente
  é salva por paciente, em Ajustes — não aqui.
- `ELEVENLABS_HELO_AGENT_ID` — Agent privado (`agent_...`) usado pelo modo
  Helo. A chave da API fica no servidor; o navegador recebe apenas um
  conversation token WebRTC temporário.
- `ELEVENLABS_HELO_PLATFORM_VOICE_FEMALE_ID` e
  `ELEVENLABS_HELO_PLATFORM_VOICE_MALE_ID` — vozes do Agent oferecidas como
  preferência pessoal do usuário. No App Hosting apontam para os secrets
  `ELEVENLABS_HELO_VOICE_FEMALE_ID` e `ELEVENLABS_HELO_VOICE_MALE_ID`.
  `ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED=true` só é seguro depois de
  habilitar o Voice ID override no Agent Helo na ElevenLabs.
- `ANTHROPIC_API_KEY` — habilita as sugestões dinâmicas de opções por IA. Sem
  chave, o app funciona apenas com a árvore de conversa curada.
- `NEXT_PUBLIC_GENERATE_MUSIC_URL` — opcional no ambiente local. O app
  publicado usa `/generateMusic` no próprio domínio (rewrite do Hosting).

Em produção essas chaves não vão em arquivo: são **secrets** do App Hosting
(ver seção Deploy).

## Deploy (Firebase App Hosting)

Hospedado no **Firebase App Hosting** (projeto `helo-app-7fbf8`, plano Blaze),
com Firestore em modo nativo (banco nomeado `helo-db`). O backend observa a
branch **`main`**: publica-se com **merge `dev`→`main` + push** — um hook
pós-merge bumpa a versão ("chore: auto-bump versão (deploy)") e o push dispara
o rollout. **Push no `dev` NÃO deploya.** O trabalho é feito no `dev`.

URLs de produção:

- `https://heloapp.web.app` — Firebase Hosting (CDN). Atenção: ele descarta
  todos os cookies das requisições ao backend, **exceto o de nome `__session`**
  (por isso o cookie de sessão se chama assim, em `lib/auth.ts`).
- `https://heloapp--helo-app-7fbf8.us-central1.hosted.app` — Cloud Run direto,
  sem remoção de cookie (útil como fallback/diagnóstico).

Três artefatos **não sobem no rollout do App Hosting** e têm deploy próprio:

```bash
firebase deploy --only firestore:rules --project helo-app-7fbf8
firebase deploy --only functions --project helo-app-7fbf8
firebase deploy --only hosting --project helo-app-7fbf8
```

Segredos (uma vez):

```bash
firebase apphosting:secrets:set ELEVENLABS_API_KEY --project helo-app-7fbf8
firebase apphosting:secrets:set ELEVENLABS_VOICE_ID --project helo-app-7fbf8
firebase apphosting:secrets:set ELEVENLABS_HELO_AGENT_ID --project helo-app-7fbf8
firebase apphosting:secrets:set ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED --project helo-app-7fbf8
firebase apphosting:secrets:set ELEVENLABS_HELO_VOICE_FEMALE_ID --project helo-app-7fbf8
firebase apphosting:secrets:set ELEVENLABS_HELO_VOICE_MALE_ID --project helo-app-7fbf8
firebase apphosting:secrets:set ANTHROPIC_API_KEY --project helo-app-7fbf8
```

Se um rollout falhar por acesso a secret:
`firebase apphosting:secrets:grantaccess <NOME> --project helo-app-7fbf8`.
As credenciais do Firestore vêm automaticamente da conta de serviço do runtime.

### Cloud Functions

Tarefas longas demais para o request do app vivem em `functions/index.js`,
expostas por rewrites do Hosting (`firebase.json`):

- `/generateMusic` → `generateMusic` — geração de música da playlist do
  paciente (até 300 s).
- `/synthesizePhraseAudio` → `synthesizePhraseAudio` — pré-síntese do áudio
  das frases favoritas.
- `/webhook/**` → `api` — compatibilidade com a integração anterior de música.

## Estrutura

### Telas

- `app/(palco)/` — layout persistente do palco (`components/palco-layout-client.tsx`
  + `orb-stage.tsx`) e os cinco modos do paciente. A home (`page.tsx`) é o
  estado "intro": a Helo se apresenta por voz e avança sozinha quando a fala
  termina de verdade, respeitando a política de autoplay do navegador.
- `app/ajustes` — configuração **por paciente**, separada do fluxo de uso:
  identidade, estilo de comunicação, gestos, voz, aparência, rede de pessoas e
  as frases de Rotina, Emergência e Conversa. A edição nunca acontece nas telas
  de uso.
- `app/atividades/gerenciar` — modo de **edição** das Atividades, separado do
  modo de uso por regra do produto: nada aqui roda sessão, e nada lá edita
  conteúdo — sem edição acidental durante uma sessão em andamento.
- `app/dashboard` — Dashboard Geral multi-paciente: organiza e resume os
  pacientes, sem nenhum conteúdo de comunicação. Linguagem observacional por
  regra — contagens e datas, nunca leitura clínica.
- `app/dashboard/[id]` — Dashboard Individual: os dados de **um** paciente. O
  `patientId` vem da rota e respostas atrasadas de uma troca de paciente são
  descartadas.
- `app/admin` — exclusivo do Admin: usuários, pacientes, matriz de acesso
  (vínculos com permissões granulares), vozes da plataforma, feedback e
  auditoria.
- `app/feedback` — canal de feedback e suporte para os usuários.
- `app/login` — entrada; na primeira execução (nenhum usuário) cria o Admin.

### Domínio e dados (`lib/`)

- `flow.ts` — árvore de conversa curada (máx. 3 opções por lote, temas
  sensíveis marcados para confirmação reforçada).
- `frases.ts`, `routine.ts`, `defaults.ts` — conteúdo padrão de Mensagem,
  Rotina e Emergência.
- `firestore.ts` — init do Firebase Admin SDK (emulador em dev, conta de
  serviço do runtime em produção).
- `store.ts` — sessões, eventos (autoria protegida), mensagens, rede de
  pessoas e configurações. As agregações do dashboard são feitas em JS no fuso
  de São Paulo.
- `access.ts` / `access-types.ts` — users, `userPatientAccess`, `auditEvents`,
  sessões de login e o conjunto de permissões por vínculo.
- `auth.ts` — sessão (`__session`) e autorização de servidor.
- `patient.tsx` — provider do **paciente ativo**: tudo personalizado é lido e
  gravado sob o `patientId` dele. Paciente, settings e itens de cada modo ficam
  espelhados em `localStorage` para que Rotina e Emergência abram e falem sem
  rede.
- `theme.tsx` — aparência, que pertence ao paciente ativo (trocar de paciente
  aplica a configuração dele).
- `activity-types.ts` / `activity-store.ts` — Atividades (ver abaixo).
- `feedback-types.ts` / `feedback.ts` — Feedback & Support.
- `playlist.ts`, `favorite-phrases.ts` — playlist de músicas e frases
  favoritas do paciente, com áudio no Storage.
- `voice.ts`, `voice-catalog.ts`, `useSpeech.ts`, `audio-coordinator.ts` — voz
  (ver abaixo).
- `helo-state.tsx`, `helo-action-registry.ts`, `helo-screen-context.ts`,
  `helo-client-tools.ts` — modos e integração com o Agent (ver abaixo).

### API (`app/api/`)

Toda a leitura e escrita do Firestore passa por estas rotas — o navegador
**nunca** fala com o banco (as regras negam tudo, ver "Segurança").

- `auth/*` — bootstrap do Admin, login, logout, sessão corrente.
- `admin/*` — usuários, matriz de acesso, auditoria, catálogo de vozes, voz do
  paciente e feedback. Toda rota exige papel admin no servidor.
- `patients/*`, `people`, `settings/*`, `preferences/theme` — cadastro,
  vínculos, rede de pessoas e configurações.
- `sessions`, `events`, `messages`, `stats` — registro e agregações.
- `items` — frases dos modos (Rotina, Emergência e expressões de Conversa) do
  paciente ativo.
- `activities/*` (templates, runs, responses) e `media` — Atividades e a
  biblioteca de mídia interna do paciente.
- `feedback/*` — pedidos, mensagens, votos e resolução.
- `favorite-phrases`, `patients/[patientId]/playlist` — frases favoritas e
  playlist.
- `tts` — síntese ElevenLabs com fallback para voz local.
- `suggest` — sugestões dinâmicas de opções via Claude, limitadas a 3.
- `helo/conversation-token` — token temporário WebRTC do Agent privado,
  protegido pela sessão autenticada.
- `helo/client-tools` — ponte entre as Client Tools do Agent e a interface.
- `voices`, `voice-preference`, `patient-voice-source` — escolhas de voz.

## Arquitetura de voz

Dois papéis vocais, ambos ElevenLabs: **plataforma** (apresentação, perguntas,
instruções, Rotina — a identidade sonora da marca) e **paciente** (voz
clonada/personalizada, usada somente quando a frase é efetivamente uma fala
dele). `speakerRole` responde "quem é o autor da fala"; `voiceSource` responde
"qual voz técnica sintetiza o áudio" — os dois nunca se misturam, e a resolução
acontece em `lib/voice.ts` e no servidor (`/api/tts`), nunca espalhada por
componentes visuais.

O catálogo é controlado (`lib/voice-catalog.ts`), com três conceitos separados:

- **Catálogo da plataforma** — vozes cadastradas e aprovadas pelo Admin. O
  usuário comum vê só o nome amigável; o `voiceId` técnico nunca sai para o
  cliente. A listagem completa da conta ElevenLabs jamais alimenta combos.
- **Voz clonada do paciente** — atribuída exclusivamente pelo Admin, isolada
  por `patientId` por construção.
- **Preferências** — escolhas entre opções já aprovadas.

`lib/audio-coordinator.ts` é o ponto **único** que decide se a voz automática
pode soar, numa hierarquia estrita: voz do **paciente** > voz do **Agent** >
voz da **plataforma**. Ninguém fala por cima de quem está acima.

## Agent Helo (conversa por voz)

O modo Helo abre uma sessão WebRTC com um Agent privado da ElevenLabs
(`components/helo-agent-provider.tsx`). A sessão é montada acima das páginas e
só permanece entre rotas quando a opção do paciente está ligada.

A ponte com a interface é um **Action Registry**
(`lib/helo-action-registry.ts`): cada tela registra, enquanto está montada, as
ações que o operador vê — com o **mesmo handler do clique manual**, nunca
clique simulado por coordenada ou `querySelector`. O painel da ElevenLabs
conhece apenas duas tools genéricas (`getCurrentHeloActions` /
`interactWithHeloUI`); os `actionId` pertencem à aplicação e são estáveis.
`lib/helo-screen-context.ts` deixa a tela publicar sub-estados (ex.: qual
pergunta da Rotina está aberta) sem que o provider conheça os detalhes de cada
modo. `lib/helo-client-tools.ts` mantém o contrato fechado — URLs e permissões
nunca são derivadas de valores enviados pelo Agent.

O modo Helo também traz playlist de músicas geradas por paciente, frases
favoritas com áudio pré-sintetizado, mensagens ao vivo para o cuidador,
indicador de qualidade de conexão e controles de privacidade de áudio.

## Atividades (sessões personalizadas)

Sessões montadas para um paciente específico — memórias, reconhecimento,
treino, exercícios — com biblioteca de mídia interna (fotos familiares, que só
saem pela rota autenticada).

Dois conceitos que **nunca se misturam** no modelo (`lib/activity-types.ts`):

- **Opções de resposta** (ex.: Pedro / Renato / Gilberto) — as respostas
  possíveis à pergunta, selecionadas pelo operador conforme observa;
- **Gestos** (👍 / ✋ / ✊) — o sinal do paciente, na metodologia da Helo.

Os dois são registrados em campos separados. O conteúdo de cada sessão é um
**snapshot imutável**: editar uma atividade não altera sessões já iniciadas —
só uma sessão nova exibe o conteúdo recém-salvo.

## Contas, vínculos e permissões

Usuários e pacientes têm relação **muitos-para-muitos**: cada usuário
(cuidador, enfermeiro, profissional de saúde, familiar) vê somente os
pacientes aos quais possui vínculo; um paciente pode ser acompanhado por
vários usuários — todos acessando **o mesmo** Dashboard Individual
(`/dashboard/[id]`). A autorização é aplicada **no servidor** em todas as
rotas de API (`lib/auth.ts`), nunca só na interface.

O **papel** define o nível geral de acesso; o **vínculo** define quais
pacientes o usuário alcança e com quais permissões. As permissões são
granulares e por vínculo — nunca derivadas do título profissional: dois
familiares do mesmo paciente podem ter conjuntos diferentes. Elas cobrem
Dashboard, sessões, métricas, edição de perfil/Conversa/Rotina/Emergência/
gestos, criação de sessões, o ciclo completo de Atividades e a exclusão de
músicas da playlist (`PERMISSIONS`, em `lib/access-types.ts`).

## Segurança

`firestore.rules` **nega toda leitura e escrita do cliente**. O navegador não
fala com o Firestore em momento algum: tudo passa pelas rotas autenticadas do
servidor, que verificam sessão, papel, autoria e visibilidade antes de usar o
Admin SDK. Chaves da ElevenLabs e da Anthropic ficam apenas no servidor — o
cliente recebe, no máximo, um conversation token WebRTC temporário.

## Registro (autoria protegida)

Cada interação grava: o que foi apresentado, qual gesto o paciente fez, tempo de
resposta, gestos incertos, pausas, reformulações, descartes e confirmações.
Os relatórios são observacionais e **não constituem diagnóstico médico**.

## Testes

Testes de integração rodam contra o **emulador** + dev server. Nunca contra
produção — os scripts limpam o banco do emulador.

```bash
npm run test:access      # autorização, vínculos e permissões
npm run test:activities  # Atividades
npm run test:feedback    # Feedback & Support (banco isolado, ex.: feedback-test)
```
