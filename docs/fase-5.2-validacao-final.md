# Fase 5.2 — matriz de confiança do ditado do cuidador

Este documento fecha a Fase 5.2. Ele não descreve o recurso — isso está em
[`ditado-do-cuidador.md`](./ditado-do-cuidador.md) — mas responde a uma única
pergunta, invariante por invariante: **por que acreditamos que é verdade?**

A regra que a fase inteira existe para proteger:

> **A transcrição é entrada de texto do cuidador.**
>
> Ela não é fala do paciente, não é consentimento, não é confirmação, não é
> comando, não é `patientResponse`, não é `SpeechGrant`, não é
> `ConfirmedPatientStatement`.

O caminho, do começo ao fim, e sem atalho em nenhum ponto:

```
voz do cuidador → áudio temporário → STT → transcript → rascunho → revisão humana → ação manual
```

Nunca:

```
voz do cuidador → ação do paciente
```

---

## Três afirmações que convivem

Elas parecem contraditórias e não são. Mantê-las separadas é a única forma de
ler o estado do projeto sem erro:

| Afirmação | Estado |
|---|---|
| Implementação do STT | **concluída** |
| Fase 5.2 | **concluída** |
| Ditado em produção | **desabilitado** |

O ditado está desabilitado em produção porque o workspace atual da ElevenLabs
está em **Grant Tier 2**, que **não oferece Zero Retention Mode**. É uma decisão
de privacidade e de ativação — não uma falha da implementação, e não um teste
que ficou faltando.

A ativação futura depende de um ambiente com ZRM confirmado, ou de outra
solução de STT que satisfaça a mesma política de retenção. Se for ElevenLabs,
`enable_logging=false` continua obrigatório, sem exceção e sem fallback.

---

## A matriz

| # | Invariante | Evidência concreta | Suíte | Resultado |
|---|---|---|---|---|
| 1 | Áudio é temporário | `encerra()` marca `encerrada` **antes** do `stop()`, para as trilhas, zera `pedacos` e libera a concessão; nenhum caminho guarda o `Blob` | `test:dictation:coordination` §4–§10 | 111 ✓ |
| 2 | Áudio não entra no offline | Nenhum `OfflineOperation` aceita `Blob`/`MediaRecorder`; a fila só transporta texto | `test:dictation:authorship`; `test:dictation:provenance` §29 | 206 · 48 ✓ |
| 3 | Transcript nasce rascunho | A transcrição sai pelo `onChange` do campo, o mesmo caminho do teclado — nunca por uma via própria | `test:dictation:authorship`; E2E "a transcrição entra no campo, e o campo continua editável" | 206 ✓ · `voz-ditado` |
| 4 | Transcript não confirma o paciente | `VOICE_TRANSCRIPTION` não alcança `ConfirmedPatientStatement` em nenhum call site | `test:dictation:authorship` | 206 ✓ |
| 5 | Transcript não gera SpeechGrant | Nenhum caminho liga transcrição a `grant` | `test:dictation:authorship`; `test:voice:grant`; `test:voice:callsites` | 206 · 32 · 14 ✓ |
| 6 | Transcript não executa o Agent | Não vira `role=user`, não entra na conversation, não toca o action registry nem client tools | `test:dictation:authorship`; `test:agent:gate`; `test:agent:invariants`; E2E "a transcrição não chega ao Agent Helo" | 206 · 52 · 21 ✓ |
| 7 | SIM / TALVEZ / NÃO são texto | Ditados, viram valor de campo e nada mais: nenhum gesto, nenhum `patientResponse`, tela inalterada | `test:dictation:authorship` (domínio) + `voz-ditado-integrado` (E2E, os três) | 206 ✓ · 9/9 |
| 8 | O microfone tem um dono só | Concessão com id monotônico; aquisição indivisível; liberação atrasada é no-op | `test:dictation:coordination` §2–§4, §18 | 111 ✓ |
| 9 | Resposta atrasada não cruza paciente | Troca de paciente com POST pendurado: o texto não aparece, as trilhas fecham | `voz-ditado-integrado` "trocar de paciente durante a transcrição descarta a resposta atrasada" | ✓ |
| 10 | Resposta atrasada não cruza sessão nem campo | Identidade por execução (`vigente`) e por campo alvo | `test:dictation:coordination`; E2E "trocar de campo antes da resposta" | 111 ✓ |
| 11 | Emergência cancela sem upload | `beginPatientVoiceOverride` → `stopAllDictation` → `encerra`; `ondataavailable`/`onstop` atrasados não produzem envio | `test:dictation:coordination` §19; E2E "emergência durante a gravação: o fragmento não vira upload nem transcrição" | 111 ✓ |
| 12 | Offline não cria retry | Não existe fila de áudio nem segunda tentativa no código | `test:dictation:retention`; E2E "perder a rede durante a gravação cancela, e nada é enviado depois" | 131 ✓ |
| 13 | O provedor recebe no máximo uma request | Um `AbortController` por execução; zero retry em qualquer falha | `test:dictation:retention`; `test:dictation:endpoint` | 131 · 60 ✓ |
| 14 | ZRM é requisito para ativação futura | Toda URL do Scribe é montada com `enable_logging=false`; não existe caminho sem o parâmetro, com `true`, nem segunda tentativa | `test:dictation:retention` | 131 ✓ |
| 15 | Produção está desabilitada | `HELO_VOICE_DICTATION_ENABLED` desligada por omissão; sem ela o endpoint recusa e a interface não oferece o botão | `test:dictation:retention`; E2E "com o recurso indisponível não há botão, e nenhum áudio é enviado" | 131 ✓ |
| 16 | Provedor real não roda em teste | A guarda neutraliza a chave antes de qualquer processo nascer; opt-in explícito e ausente | `test:eleven-guard` | 46 ✓ |
| 17 | Os endpoints exigem autorização | Sessão, acesso ao paciente e flag, nessa ordem, antes de qualquer byte | `test:dictation:endpoint`; `test:access` | 60 · 72 ✓ |
| 18 | O contêiner real é validado | Assinatura lida nos bytes (EBML, OggS, ftyp) e comparada ao tipo declarado | `test:dictation:content` §12 | 73 ✓ |
| 19 | Os limites de campo são respeitados | O que não cabe não é cortado: nada muda e o cuidador é avisado | `test:dictation:domain`; E2E "o que não cabe no campo não é cortado" | 88 ✓ |
| 20 | O fluxo manual é fallback integral | Permissão negada, provedor fora do ar, recurso desligado, sem rede: o campo continua digitável em todos | `voz-ditado` (4 testes) | 36/36 ✓ |

### Um invariante a mais, que a 5.2C acrescentou

| # | Invariante | Evidência | Suíte | Resultado |
|---|---|---|---|---|
| 21 | Nenhum armazenamento do navegador guarda áudio | Varredura real de `localStorage`, `sessionStorage`, Cache API e **todas** as bases IndexedDB depois de um ditado: nenhum `Blob`, nenhum `data:audio`, nenhum `blob:`, nenhum estado de gravação | `voz-ditado-integrado` "o que fica guardado depois de ditar é texto, e nada mais" | ✓ |
| 22 | Sair da conta não deixa nada atrás | Logout durante captura e durante transcrição: zero upload, trilhas paradas, transcript atrasado descartado, e o próximo login começa limpo | `voz-ditado-integrado` (2 testes) | ✓ |

---

## Os quatro campos

| Campo | Onde | Procedência registrada | Prova |
|---|---|---|---|
| Pergunta livre | `session-screens.tsx` | **`VOICE_TRANSCRIPTION`** | `test:dictation:provenance` casos A–E |
| Interpretação do cuidador | `interpretation.tsx` | não registra | E2E "o ditado também preenche a interpretação" |
| Frase da mensagem em construção | `option-conversation/composer.tsx` | não registra | `voz-ditado-integrado` |
| Título/pergunta do nível | `option-conversation/node-editor.tsx` | não registra | `voz-ditado-integrado` |

Só a pergunta livre registra `VOICE_TRANSCRIPTION` no domínio. Os outros três
recebem o texto e param aí — de propósito: inventar procedência onde o modelo
não a tem seria uma mentira de auditoria.

## A semântica de `VOICE_TRANSCRIPTION`

| Caso | Antes | Ação | Origem depois | `originalText` |
|---|---|---|---|---|
| A | campo vazio | ditar | `VOICE_TRANSCRIPTION` | a transcrição |
| B | texto digitado | ditar | `MANUAL_TEXT` | `null` |
| C | nasceu por voz | editar à mão | `VOICE_TRANSCRIPTION` | a transcrição bruta |
| D | nasceu por voz | ditar de novo | `VOICE_TRANSCRIPTION` | as duas, concatenadas |
| E | qualquer | limpar o campo | `MANUAL_TEXT` | `null` |

`reviewedText` é sempre o texto efetivamente enviado. `originalText` guarda só
o que veio do áudio — uma edição manual nunca é registrada como se fosse voz.

---

## Modos de validação

| | Modo A — produção atual | Modo B — ambiente isolado |
|---|---|---|
| `HELO_VOICE_DICTATION_ENABLED` | `false` | `true` |
| Provedor | nenhum | mockado, interceptado na aba |
| Chave real | neutralizada pela guarda | neutralizada pela guarda |
| Banco | — | emulador descartável, nunca `helo-db` |
| Prova | recurso indisponível, zero captura, digitação normal | o recurso implementado, de ponta a ponta |

Os dois nunca se misturam. Servidores de regressão sobem apenas por
`npm run dev:teste` ou pelo runner oficial — os dois caminhos passam pela
guarda de `scripts/eleven-guard.mjs`. Um `npx next dev` digitado à mão continua
tecnicamente possível e **não** é interceptado; a proteção ali é de processo,
não de framework.

---

## Limitações residuais, aceitas

1. **Ditado desabilitado em produção**, porque o workspace Grant Tier 2 não
   oferece ZRM. Não impede a conclusão técnica da fase.
2. Sem parciais ao vivo — o texto aparece quando a transcrição termina.
3. STT em lote, não em streaming.
4. Só a pergunta livre registra `VOICE_TRANSCRIPTION` no domínio.
5. A procedência transitória não sobrevive ao refresh enquanto o texto é
   rascunho. O texto volta; a origem, não.
6. Rótulos de opção e frases finais de opção não têm ditado.
7. A validação de áudio identifica contêiner e assinatura — ela não decodifica
   o arquivo nem julga o conteúdo.
8. A ativação futura depende de ambiente ElevenLabs com ZRM confirmado, ou de
   outra solução de STT que satisfaça a política de retenção do Helo.

---

## Como a regressão desta fase é executada

A suíte de interface roda em lotes, um servidor novo por lote. Duas
particularidades, ambas medidas e não supostas:

- as quatro specs da **conversa por opções** e a spec **`voz-ditado-integrado`**
  rodam sobre **build de produção** (`npm run test:ui:build` + `next start`),
  porque a jornada mais longa gasta ~60 s em 68 ações contra `next dev` e ~42 s
  contra a build — o custo estava no compilador sob demanda, não no produto;
- o preparo de sessão de toda spec é sincronizado pelo request real
  (`POST /api/realtime-questions/sessions`) e pela hidratação (o botão nasce
  `disabled` no HTML pré-renderizado), e não por orçamento de tempo.
  `scripts/test-e2e-sync.mjs` prende essas propriedades, inclusive contra uma
  spec nova que copie o padrão antigo.
