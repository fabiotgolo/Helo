import { getPatientSettings, setPatientSettings } from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";
import { PATIENT_SETTING_KEYS, VOICE_SETTING_KEYS } from "@/lib/defaults";
import {
  isThemeId,
  sanitizeFontScales,
  type Permission,
} from "@/lib/access-types";

const HELO_GREETING_MAX_LENGTH = 200;

// Configurações do paciente (nome, gestos, estilo de fala…).
// Sempre com escopo de patientId — não existe mais configuração global.
// Escrita exige a permissão da área correspondente:
//   perfil → editProfile · comunicação → editConversation · gestos → editGestures.
// Aparência e voz semântica da Helo exigem vínculo ativo com o paciente, mas
// não são tratadas como edição de perfil.
//
// A voz clonada do paciente não passa por aqui (nem leitura do id técnico,
// nem escrita):
//   - clone do paciente → /api/admin/patient-voice (Admin);
//   - fonte da voz do paciente → /api/patient-voice-source (permissão
//     selectPatientVoiceSource);
//   - estado visível (status, nomes) → /api/voices.
// Isso garante que nenhum voiceId ElevenLabs seja gravado ou lido pelo
// fluxo genérico de settings, mesmo por requisição direta. A preferência
// semântica do Agent Helo (female | male) é uma setting comum do paciente.

function permissionForKey(key: string): Permission | undefined {
  if (
    key === PATIENT_SETTING_KEYS.gestureSim ||
    key === PATIENT_SETTING_KEYS.gestureTalvez ||
    key === PATIENT_SETTING_KEYS.gestureNao
  ) {
    return "editGestures";
  }
  if (
    key === PATIENT_SETTING_KEYS.speechStyle ||
    key === PATIENT_SETTING_KEYS.avoidedTopics
  ) {
    return "editConversation";
  }
  if (key === PATIENT_SETTING_KEYS.name) {
    return "editProfile";
  }
  return undefined;
}

export async function GET(request: Request) {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  // Leitura exige vínculo ativo — mínimo para operar a Helo.
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  const settings = await getPatientSettings(patientId);
  // O voiceId técnico do clone nunca sai para o cliente; o restante do
  // estado de voz (existe clone? qual fonte?) vem de /api/voices.
  delete settings[PATIENT_SETTING_KEYS.voiceId];
  return Response.json(settings);
}

export async function POST(request: Request) {
  const { patientId, ...updates } = (await request.json()) as {
    patientId?: number;
  } & Record<string, unknown>;
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const keys = Object.keys(updates);
  if (keys.some((k) => VOICE_SETTING_KEYS.includes(k))) {
    return Response.json(
      { error: "configuração de voz só pelas rotas dedicadas de voz" },
      { status: 403 }
    );
  }
  const appearanceTheme = updates[PATIENT_SETTING_KEYS.appearanceTheme];
  if (appearanceTheme !== undefined && !isThemeId(appearanceTheme)) {
    return Response.json({ error: "tema inválido" }, { status: 422 });
  }
  const appearanceFontScales = updates[PATIENT_SETTING_KEYS.appearanceFontScales];
  if (appearanceFontScales !== undefined) {
    if (typeof appearanceFontScales !== "string") {
      return Response.json({ error: "escalas de fonte inválidas" }, { status: 422 });
    }
    try {
      const scales = sanitizeFontScales(JSON.parse(appearanceFontScales));
      updates[PATIENT_SETTING_KEYS.appearanceFontScales] = JSON.stringify(scales ?? {});
    } catch {
      return Response.json({ error: "escalas de fonte inválidas" }, { status: 422 });
    }
  }
  const heloVoicePreference = updates[PATIENT_SETTING_KEYS.heloVoicePreference];
  if (
    heloVoicePreference !== undefined &&
    heloVoicePreference !== "female" &&
    heloVoicePreference !== "male"
  ) {
    return Response.json({ error: "preferência de voz inválida" }, { status: 422 });
  }
  const heloGreeting = updates[PATIENT_SETTING_KEYS.heloGreeting];
  if (heloGreeting !== undefined) {
    if (typeof heloGreeting !== "string") {
      return Response.json({ error: "saudação inválida" }, { status: 422 });
    }
    const normalizedGreeting = heloGreeting.trim();
    if (normalizedGreeting.length > HELO_GREETING_MAX_LENGTH) {
      return Response.json(
        { error: `a saudação deve ter no máximo ${HELO_GREETING_MAX_LENGTH} caracteres` },
        { status: 422 }
      );
    }
    // Vazio é intencional: remove a personalização e faz o Agent usar o
    // fallback seguro ao iniciar a próxima sessão.
    updates[PATIENT_SETTING_KEYS.heloGreeting] = normalizedGreeting;
  }
  if (Object.values(updates).some((value) => typeof value !== "string")) {
    return Response.json({ error: "configuração inválida" }, { status: 422 });
  }
  const baseAuth = await requirePatientAccess(request, Number(patientId));
  if (baseAuth instanceof Response) return baseAuth;

  const needed = new Set(
    keys
      .map((k) => permissionForKey(k))
      .filter((permission): permission is Permission => Boolean(permission))
  );
  for (const permission of needed) {
    const auth = await requirePatientAccess(
      request,
      Number(patientId),
      permission
    );
    if (auth instanceof Response) return auth;
  }
  await setPatientSettings(Number(patientId), updates as Record<string, string>);
  return Response.json({ ok: true });
}
