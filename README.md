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

## Configuração (.env)

Copie `.env.example` para `.env` e preencha:

- `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` — síntese de voz. Sem chave, o
  app usa a voz local do navegador em pt-BR.
- `ELEVENLABS_HELO_AGENT_ID` — Agent privado (`agent_...`) usado somente pelo
  Orb Helo. A chave da API fica no servidor; o navegador recebe apenas um
  conversation token WebRTC temporário.
- `ELEVENLABS_HELO_PLATFORM_VOICE_FEMALE_ID` e
  `ELEVENLABS_HELO_PLATFORM_VOICE_MALE_ID` — IDs centralizados das vozes do
  Agent. No App Hosting, esses env vars podem apontar para os secrets já
  existentes `ELEVENLABS_HELO_VOICE_FEMALE_ID` e
  `ELEVENLABS_HELO_VOICE_MALE_ID`. `ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED=true`
  só é seguro após o Voice ID override ter sido habilitado no Agent Helo na
  ElevenLabs.
- `ANTHROPIC_API_KEY` — habilita as sugestões dinâmicas de opções por IA. Sem
  chave, o app funciona apenas com a árvore de conversa curada.

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

As **regras do Firestore não sobem no rollout do App Hosting** — deploy à parte:
`firebase deploy --only firestore:rules --project helo-app-7fbf8`.

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

## Estrutura

- `app/conversa` — conversa guiada: perguntas em voz, até 3 opções por vez,
  sugestões por IA quando a árvore se esgota, confirmação antes de comunicar,
  pausa, gesto incerto, voltar.
- `app/mensagem` — construção progressiva de mensagens: frase → parágrafo
  (máx. 3 frases) → mensagem final, cada frase confirmada por gesto.
- `app/rotina` — frases rápidas do dia a dia (funciona sem IA).
- `app/emergencia` — frases críticas, um toque fala na hora, sem IA.
- `app/ajustes` — escolha de voz ElevenLabs, nome/tratamento do paciente e
  rede de pessoas importantes (usada no fluxo "Falar com alguém").
- `app/dashboard` — relatórios observacionais por período + Gerar PDF (imprimir).
- `lib/flow.ts` — árvore de conversa curada (máx. 3 opções por lote, temas
  sensíveis marcados para confirmação reforçada).
- `lib/firestore.ts` — init do Firebase Admin SDK (emulador em dev, conta de
  serviço do runtime em produção).
- `lib/store.ts` — acesso a dados sobre o Firestore: sessões, eventos (autoria
  protegida), mensagens, rede de pessoas e configurações. As agregações do
  dashboard são feitas em JS no fuso de São Paulo.
- `app/api/tts` — síntese ElevenLabs com fallback para voz local.
- `app/api/helo/conversation-token` — token temporário WebRTC de um Agent
  privado, protegido pela sessão autenticada.
- `app/api/suggest` — sugestões dinâmicas de opções via Claude, limitadas a 3.

## Contas, vínculos e permissões

Usuários e pacientes têm relação **muitos-para-muitos**: cada usuário
(cuidador, enfermeiro, profissional de saúde, familiar) vê somente os
pacientes aos quais possui vínculo; um paciente pode ser acompanhado por
vários usuários — todos acessando **o mesmo** Dashboard Individual
(`/dashboard/[patientId]`). A autorização é aplicada **no servidor** em
todas as rotas de API (`lib/auth.ts`), nunca só na interface.

- `/login` — entrada; na primeira execução (nenhum usuário) cria o Admin.
- `/admin` — exclusivo do Admin: usuários, pacientes, matriz de acesso
  (vínculos com permissões granulares por vínculo) e auditoria.
- `lib/access.ts` — users, userPatientAccess, auditEvents, sessões de login.
- Testes de autorização: `npm run test:access` (com emulador + dev server;
  **limpa o banco do emulador**).

## Registro (autoria protegida)

Cada interação grava: o que foi apresentado, qual gesto o paciente fez, tempo de
resposta, gestos incertos, pausas, reformulações, descartes e confirmações.
Os relatórios são observacionais e **não constituem diagnóstico médico**.
