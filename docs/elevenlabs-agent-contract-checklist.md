# Contrato externo do Agent Helo — checklist do painel ElevenLabs

> **Nunca copiar API key, secret ou credential para este arquivo.**
> Nada aqui é segredo. Se um campo do painel mostrar uma chave, um token ou
> qualquer credencial, **pule o campo** — a auditoria não precisa dele e o
> repositório não deve tê-lo. Este arquivo é versionado no Git.

## Por que ele existe

O Helo conhece metade do contrato: os nomes de tool que o cliente registra, os
parâmetros que aceita e o payload que devolve. A outra metade — o que o Agent
foi **instruído** a fazer — vive só no painel da ElevenLabs, e nenhuma parte
dela está no repositório. A auditoria da Fase 5.4A parou nesse ponto e não
inferiu nada (ver `docs/fase-5.4a-auditoria-seguranca-privacidade.md`, §17–18).

Preencha o que souber. Um campo em branco é uma resposta legítima ("não sei" é
melhor que um palpite); um campo preenchido de memória, não.

---

## 1. Identificação

| Campo | Valor |
| --- | --- |
| Agent ID (`agent_...`) | |
| Nome do Agent no painel | |
| Workspace / conta | |
| Data em que estas informações foram copiadas | |

## 2. System Prompt

Cole **na íntegra**, sem resumir. É o item mais importante da lista: é ele que
pode contradizer o gate de autoridade do Helo (ver §3 abaixo).

```text

```

## 3. First Message

O Helo envia a variável dinâmica `heloPatientGreeting` esperando que o First
Message a use. Cole o texto exato configurado no painel:

```text

```

| Pergunta | Resposta |
| --- | --- |
| O First Message usa `{{heloPatientGreeting}}`? | |
| Se não usa, qual texto fixo ele diz? | |

## 4. Voz, modelo e idioma

| Campo | Valor |
| --- | --- |
| Voice (nome) | |
| Voice ID | |
| LLM / modelo | |
| Idioma configurado | |
| "Voice ID override" (segurança do Agent) está **habilitado**? | |

> O último importa: o Helo tem código para enviar override de voz por sessão
> (`resolveVoiceOverride`), mas hoje **sempre desabilita** o envio, porque o
> LiveKit derrubava a sessão. É o risco **R-12**.

## 5. Tools declaradas

Uma linha por tool declarada no painel — inclusive as que você achar que não
são mais usadas.

| # | Nome da tool | Tipo (client / server / system) | Descrição (colar) |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |

### 5.1 Parâmetros de cada tool

Para cada tool acima, cole o JSON schema dos parâmetros exatamente como o
painel mostra:

```json

```

### 5.2 Server tools / URLs externas

| Pergunta | Resposta |
| --- | --- |
| Existe alguma **server tool** (webhook) declarada? | |
| Se sim, para qual URL ela aponta? | |
| Alguma aponta para `heloapp.web.app/webhook/**`? | |

> A rota legada `/webhook/generate_music` continua existindo nas Cloud
> Functions justamente porque esta pergunta nunca foi respondida. Desde a Fase
> 5.1A ela exige cookie de sessão do cuidador — uma server tool chamando dali
> recebe **401**.

## 6. Variáveis dinâmicas

O Helo envia estas, e só estas, em cada abertura de sessão:

`patientName`, `preferredName`, `heloPatientGreeting`, `communicationStyle`,
`responsePace`, `confirmGestureLabel`, `reformulateGestureLabel`,
`rejectGestureLabel`, `activePatientId`, `currentOperatorRole`, `heloLanguage`,
`heloInteractionMode`.

| Pergunta | Resposta |
| --- | --- |
| Quais variáveis dinâmicas o painel **declara**? | |
| Alguma declarada não está na lista acima? | |
| Alguma da lista acima **não** é usada pelo prompt? | |

## 7. Knowledge Base

| Pergunta | Resposta |
| --- | --- |
| Existe Knowledge Base vinculada a este Agent? | |
| Quais documentos? (nomes) | |
| Algum contém dado clínico, nome de paciente ou conteúdo de sessão? | |
| Algum é atualizado automaticamente por algum processo? | |

## 8. Retenção e logging

Cada recurso da ElevenLabs tem política própria — **não presuma que uma vale
para as outras**.

| Recurso | Retenção configurada | Logging / gravação | Observação |
| --- | --- | --- | --- |
| Conversational AI (Agent) | | | transcrição e áudio da conversa |
| Text-to-Speech | | | fala da plataforma e do paciente |
| Music | | | prompt do cuidador |
| Speech-to-Text (Scribe) | | | hoje **desligado** em produção |

| Pergunta | Resposta |
| --- | --- |
| O workspace tem **Zero Retention Mode** disponível no plano atual? | |
| Está habilitado? Para quais recursos? | |
| Existe opção de desligar o armazenamento de transcrições do Agent? | |
| Por quanto tempo as conversas ficam visíveis no painel? | |

## 9. Segurança do Agent

| Opção | Estado |
| --- | --- |
| Overrides permitidos por sessão (quais) | |
| Autenticação exigida para abrir conversa | |
| Allowlist de domínios / origens | |
| Limite de concorrência ou de uso configurado | |

## 10. Qualquer outra configuração relevante

```text

```

---

## O que será feito com isto

Assim que este arquivo estiver preenchido, a Fase 5.4C consegue responder — e
só então — três perguntas que hoje estão em aberto:

1. **Aliases legados.** O cliente registra 15 nomes de tool, cinco dos quais
   existem só por compatibilidade (`generate_music`, `getVisibleHeloActions`,
   `interactWithVisibleHeloUI`, `executeHeloAction`, e sete aliases de
   parâmetro do `actionId`). Sabendo quais nomes o painel realmente chama, os
   demais saem.
2. **Contradição de autoridade.** Se o System Prompt disser ao Agent que ele
   pode responder, confirmar ou escolher pelo paciente, o gate do Helo continua
   recusando — mas o Agent tentará, e o cuidador ouvirá uma promessa que a
   interface desmente. Isso é um defeito de produto, não de segurança, e o
   conserto é no prompt.
3. **Retenção.** A política real de cada recurso decide se algum dado precisa
   deixar de sair do Helo.

**Nada disso altera o painel.** A leitura é só leitura; qualquer mudança de
configuração é uma decisão sua, tomada depois, com a divergência à vista.
