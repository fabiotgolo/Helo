// Conteúdo padrão da Helo — a base que cada paciente recebe como cópia
// inicial e pode editar, desativar, reordenar ou restaurar. As frases de
// Rotina e Emergência foram migradas de lib/flow.ts (mesmo texto), para que
// pacientes existentes não percam nada na transição.
//
// A defaultKey é estável: é ela que permite "restaurar padrão" sem duplicar
// itens nem apagar o que o paciente personalizou por cima.

import type { HeloItemMode } from "@/lib/types";
import { modeSpeakerRole } from "@/lib/voice";

export interface DefaultItem {
  defaultKey: string;
  label: string;
  spokenText: string;
  category: string;
}

export const DEFAULT_ITEMS: Record<HeloItemMode, DefaultItem[]> = {
  rotina: [
    { defaultKey: "rotina.agua", label: "Água", spokenText: "Quero água, por favor.", category: "necessidades" },
    { defaultKey: "rotina.banheiro", label: "Banheiro", spokenText: "Preciso ir ao banheiro.", category: "necessidades" },
    { defaultKey: "rotina.dor", label: "Estou com dor", spokenText: "Estou com dor.", category: "dor" },
    { defaultKey: "rotina.descansar", label: "Quero descansar", spokenText: "Quero descansar agora.", category: "necessidades" },
    { defaultKey: "rotina.frio", label: "Estou com frio", spokenText: "Estou com frio.", category: "conforto" },
    { defaultKey: "rotina.calor", label: "Estou com calor", spokenText: "Estou com calor.", category: "conforto" },
    { defaultKey: "rotina.bem", label: "Estou bem", spokenText: "Estou bem.", category: "sentimentos" },
    { defaultKey: "rotina.cansado", label: "Estou cansado", spokenText: "Estou cansado.", category: "sentimentos" },
    { defaultKey: "rotina.nao_entendi", label: "Não entendi", spokenText: "Não entendi. Pode repetir?", category: "geral" },
    { defaultKey: "rotina.repita", label: "Repita, por favor", spokenText: "Repita, por favor.", category: "geral" },
    { defaultKey: "rotina.nao_e_isso", label: "Não é isso", spokenText: "Não é isso que eu quis dizer.", category: "geral" },
    { defaultKey: "rotina.familia", label: "Quero minha família", spokenText: "Quero falar com a minha família.", category: "pessoas" },
    { defaultKey: "rotina.posicao", label: "Mudar de posição", spokenText: "Quero mudar de posição, por favor.", category: "conforto" },
  ],
  emergencia: [
    { defaultKey: "emergencia.falta_ar", label: "Falta de ar", spokenText: "Estou com falta de ar. Preciso de ajuda agora.", category: "emergencia" },
    { defaultKey: "emergencia.dor_forte", label: "Dor forte", spokenText: "Estou com uma dor forte. Preciso de ajuda agora.", category: "emergencia" },
    { defaultKey: "emergencia.ajuda", label: "Preciso de ajuda", spokenText: "Preciso de ajuda agora.", category: "emergencia" },
    { defaultKey: "emergencia.chamem", label: "Chamem alguém", spokenText: "Quero que chamem alguém agora, por favor.", category: "emergencia" },
    { defaultKey: "emergencia.nao_bem", label: "Não estou bem", spokenText: "Não estou me sentindo bem. Fiquem comigo.", category: "emergencia" },
  ],
  // Expressões preferidas do paciente na Conversa: alimentam as sugestões da
  // IA com o jeito de falar dele. O padrão é um ponto de partida pequeno —
  // a personalização real acontece em Ajustes.
  conversa: [
    { defaultKey: "conversa.cumprimento", label: "Cumprimento", spokenText: "Olá, estou feliz em ver vocês.", category: "expressao" },
    { defaultKey: "conversa.agradecimento", label: "Agradecimento", spokenText: "Sou muito grato por todo o cuidado que recebo.", category: "expressao" },
    { defaultKey: "conversa.discordancia", label: "Discordância", spokenText: "Não é isso que eu quis dizer.", category: "expressao" },
    { defaultKey: "conversa.descanso", label: "Pedir descanso", spokenText: "Quero descansar agora.", category: "expressao" },
  ],
};

// Emergência fala no toque do assistente (regra do produto: nada na frente
// do socorro); Rotina e Conversa exigem gesto de confirmação do paciente.
export function modeRequiresConfirmation(mode: HeloItemMode): boolean {
  return mode !== "emergencia";
}

// Autoria da fala por modo (definição atual do produto): Rotina é dita pela
// voz da plataforma Helo; Emergência e Conversa são falas do paciente.
// A regra vive em lib/voice.ts (modeSpeakerRole) — ponto único de resolução.
export { modeSpeakerRole };

// Chaves de settings por paciente (perfil de comunicação).
//
// Voz — três chaves com papéis distintos (nunca misturar):
//   voiceId            → voiceId ElevenLabs da voz CLONADA do paciente.
//                        Escrita EXCLUSIVA do Admin (/api/admin/patient-voice);
//                        nunca sai em leituras para o cliente.
//   voiceCloneName     → nome de exibição do clone (ex.: "Voz do Dr. Fábio").
//   patientVoiceSource → fonte escolhida para as falas do paciente:
//                        "clone" ou "platform" (via selectPatientVoiceSource).
//   patientVoicePlatformId → id do CATÁLOGO interno quando a fonte é
//                        "platform" (nunca um voiceId técnico).
//   appearanceTheme       → tema visual da Helo para este paciente.
//   appearanceFontScales  → escalas de fonte do tema, serializadas em JSON.
//   heloVoicePreference   → voz semântica do Agent Helo (female | male).
//                        O voiceId técnico é resolvido exclusivamente no
//                        backend ao iniciar a conversa.
//   heloGreeting          → primeira fala personalizada da Helo para este
//                        paciente; texto simples, limitado no backend.
//   heloPersistentAssistantEnabled → mantém a sessão do Agent Helo entre
//                        rotas internas depois de iniciada manualmente.
export const PATIENT_SETTING_KEYS = {
  name: "patient_name",
  voiceId: "voice_id",
  voiceCloneName: "voice_clone_name",
  patientVoiceSource: "patient_voice_source",
  patientVoicePlatformId: "patient_voice_platform_id",
  appearanceTheme: "appearance_theme",
  appearanceFontScales: "appearance_font_scales",
  heloVoicePreference: "helo_voice_preference",
  heloGreeting: "helo_greeting",
  heloPersistentAssistantEnabled: "helo_persistent_assistant_enabled",
  speechStyle: "speech_style",
  avoidedTopics: "avoided_topics",
  gestureSim: "gesture_sim_emoji",
  gestureTalvez: "gesture_talvez_emoji",
  gestureNao: "gesture_nao_emoji",
} as const;

/** Chaves de voz — fora do fluxo genérico de settings (rotas dedicadas). */
export const VOICE_SETTING_KEYS: readonly string[] = [
  PATIENT_SETTING_KEYS.voiceId,
  PATIENT_SETTING_KEYS.voiceCloneName,
  PATIENT_SETTING_KEYS.patientVoiceSource,
  PATIENT_SETTING_KEYS.patientVoicePlatformId,
];
