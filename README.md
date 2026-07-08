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

## Rodar

```bash
npm install
npm run dev
```

Abra http://localhost:3000.

## Configuração (.env)

Copie `.env.example` para `.env` e preencha:

- `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` — síntese de voz. Sem chave, o
  app usa a voz local do navegador em pt-BR.
- `ANTHROPIC_API_KEY` — habilita as sugestões dinâmicas de opções por IA. Sem
  chave, o app funciona apenas com a árvore de conversa curada.

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
- `lib/db.ts` — SQLite em `data/helo.db`: sessões, eventos (autoria protegida),
  mensagens, rede de pessoas e configurações.
- `app/api/tts` — síntese ElevenLabs com fallback para voz local.
- `app/api/suggest` — sugestões dinâmicas de opções via Claude, limitadas a 3.

## Registro (autoria protegida)

Cada interação grava: o que foi apresentado, qual gesto o paciente fez, tempo de
resposta, gestos incertos, pausas, reformulações, descartes e confirmações.
Os relatórios são observacionais e **não constituem diagnóstico médico**.
