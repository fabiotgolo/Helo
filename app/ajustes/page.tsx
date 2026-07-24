"use client";

// ——— Ajustes: a área de configuração, separada do fluxo de comunicação ———
// Tudo aqui é POR PACIENTE: identidade, estilo de comunicação, gestos, voz,
// rede de pessoas e as frases de Rotina, Emergência e expressões de Conversa.
// A edição nunca acontece nas telas de uso — só aqui, por quem cuida.

import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { AppearanceSettings } from "@/components/appearance-settings";
import { useHeloDialog } from "@/components/helo-dialog";
import { HeloVoiceSettings } from "@/components/helo-voice-settings";
import { GESTURES, type Gesture, type HeloItemMode, type ModeItem } from "@/lib/types";
import { GESTURE_EMOJI_KEYS } from "@/lib/gestures";
import { usePatient, usePatientItems } from "@/lib/patient";
import { isHeloPersistentAssistantEnabled, PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { readSearchParams, safeReturnTo } from "@/lib/edit-link";

// Vozes visíveis ao usuário: SOMENTE o catálogo interno aprovado pelo Admin
// (nomes amigáveis — nenhum voiceId técnico chega ao cliente) e, quando
// existir, a voz clonada DO paciente ativo. Nunca a biblioteca ElevenLabs.
type PublicVoice = {
  id: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
};
type VoicesData = {
  voices: PublicVoice[];
  defaultVoiceId: string | null;
  platformVoiceReady: boolean;
  canSelectPlatformVoice: boolean;
  myPlatformVoiceId: string | null;
  patient?: {
    patientId: number;
    hasClone: boolean;
    cloneName: string | null;
    source: "clone" | "platform";
    platformVoiceId: string | null;
    canSelectPatientVoiceSource: boolean;
  };
};
type Person = { id: number; name: string; relation: string | null };
type SettingsCaps = {
  profile: boolean;
  conversation: boolean;
  gestures: boolean;
  heloGreeting: boolean;
  persistentAssistant: boolean;
};
type SettingsCapsState = {
  patientId: number;
  caps: SettingsCaps;
};

const GESTURE_ORDER: Gesture[] = ["sim", "talvez", "nao"];
const HELO_GREETING_MAX_LENGTH = 200;

// Paleta de mãos por gesto — cada gesto oferece só as mãos coerentes com ele
// (ex.: o "Sim" não oferece 👎). Mãos neutras servem a qualquer gesto, pois o
// que importa é o que o paciente consegue formar.
const GESTURE_PALETTES: Record<Gesture, string[]> = {
  sim: ["👍", "✊", "✋", "🤚", "🖐️", "👊", "✌️", "👌"],
  talvez: ["✊", "✋", "🤚", "🖐️", "👊", "✌️"],
  nao: ["👎", "✊", "✋", "🤚", "🖐️", "👊"],
};

export default function AjustesPage() {
  const {
    patients,
    patient,
    patientId,
    selectPatient,
    addPatient,
    renamePatient,
    settings,
    saveSettings,
  } = usePatient();

  const [voicesData, setVoicesData] = useState<VoicesData | null>(null);
  const [voicesError, setVoicesError] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [speechStyle, setSpeechStyle] = useState("");
  const [avoidedTopics, setAvoidedTopics] = useState("");
  const [heloGreeting, setHeloGreeting] = useState("");
  const [persistentAssistantEnabled, setPersistentAssistantEnabled] = useState(true);
  const [gestureEmojis, setGestureEmojis] = useState<Record<Gesture, string>>({
    sim: "",
    talvez: "",
    nao: "",
  });
  const [people, setPeople] = useState<Person[]>([]);
  const [newName, setNewName] = useState("");
  const [newRelation, setNewRelation] = useState("");
  const [newPatientName, setNewPatientName] = useState("");
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsCapsState, setSettingsCapsState] = useState<SettingsCapsState | null>(null);
  const settingsCaps =
    settingsCapsState?.patientId === patientId ? settingsCapsState.caps : null;
  // Qual prévia está tocando — "plataforma" | "paciente" | null. Antes era um
  // booleano único, o que fazia os DOIS botões "Ouvir" virarem "Falando…" ao
  // clicar em um só. Agora cada botão reflete só o próprio estado.
  const [previewing, setPreviewing] = useState<"plataforma" | "paciente" | null>(
    null
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ——— Edição contextual (deep link) ———
  // ?editMode=<rotina|emergencia|conversa>&itemId=…&returnTo=… abre a seção
  // certa JÁ no item, com o formulário de edição aberto, e oferece o retorno
  // à tela de origem. Lido uma vez, do lado do cliente (página client-only).
  const [editContext, setEditContext] = useState<{
    mode: HeloItemMode | null;
    itemId: string | null;
    returnTo: string | null;
  }>({ mode: null, itemId: null, returnTo: null });
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const q = readSearchParams();
      const mode = q.get("editMode") as HeloItemMode | null;
      setEditContext({
        mode: mode === "rotina" || mode === "emergencia" || mode === "conversa" ? mode : null,
        itemId: q.get("itemId"),
        returnTo: safeReturnTo(q.get("returnTo")),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Client Tools só podem escolher seções conhecidas. A query não concede
  // permissão e não altera dados; ela apenas posiciona a página já existente.
  useEffect(() => {
    const section = readSearchParams().get("section");
    const allowed = ["paciente", "aparencia", "voz_helo", "gestos", "comunicacao"];
    if (!section || !allowed.includes(section)) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // O formulário espelha as configurações do paciente ativo; trocar de
  // paciente recarrega tudo — nada de um vaza para o outro.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setPatientName(settings[PATIENT_SETTING_KEYS.name] ?? "");
      setSpeechStyle(settings[PATIENT_SETTING_KEYS.speechStyle] ?? "");
      setAvoidedTopics(settings[PATIENT_SETTING_KEYS.avoidedTopics] ?? "");
      setHeloGreeting(settings[PATIENT_SETTING_KEYS.heloGreeting] ?? "");
      setPersistentAssistantEnabled(isHeloPersistentAssistantEnabled(settings));
      setGestureEmojis({
        sim: settings[GESTURE_EMOJI_KEYS.sim] ?? "",
        talvez: settings[GESTURE_EMOJI_KEYS.talvez] ?? "",
        nao: settings[GESTURE_EMOJI_KEYS.nao] ?? "",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settings]);

  // Estado de voz sempre no escopo do paciente ativo: trocar de paciente
  // recarrega — o clone de um nunca aparece no contexto do outro.
  const loadVoices = useCallback(async () => {
    if (patientId == null) return;
    setVoicesError(false);
    try {
      const r = await fetch(`/api/voices?patientId=${patientId}`);
      if (!r.ok) throw new Error();
      const d = (await r.json()) as VoicesData;
      setVoicesData((current) =>
        // Troca rápida de paciente: só aplica se a resposta é do ativo.
        d.patient?.patientId === patientId ? d : current
      );
    } catch {
      setVoicesError(true);
    }
  }, [patientId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setVoicesData(null);
      void loadVoices();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadVoices]);

  const loadPeople = useCallback(async () => {
    if (patientId == null) return;
    try {
      const r = await fetch(`/api/people?patientId=${patientId}`);
      const d = (await r.json()) as { people: Person[] };
      setPeople(d.people ?? []);
    } catch {
      /* segue sem rede */
    }
  }, [patientId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setPeople([]);
      void loadPeople();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadPeople]);

  useEffect(() => {
    if (patientId == null) return;
    void fetch(`/api/settings/caps?patientId=${patientId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((caps: SettingsCaps) => setSettingsCapsState({ patientId, caps }))
      .catch(() =>
        setSettingsCapsState({
          patientId,
          caps: {
            profile: false,
            conversation: false,
            gestures: false,
            heloGreeting: false,
            persistentAssistant: false,
          },
        })
      );
  }, [patientId]);

  const save = useCallback(async () => {
    if (!settingsCaps) return;

    const updates: Record<string, string> = {};
    if (settingsCaps.profile) {
      updates[PATIENT_SETTING_KEYS.name] = patientName;
    }
    if (settingsCaps.conversation) {
      updates[PATIENT_SETTING_KEYS.speechStyle] = speechStyle.trim();
      updates[PATIENT_SETTING_KEYS.avoidedTopics] = avoidedTopics.trim();
    }
    if (settingsCaps.heloGreeting) {
      updates[PATIENT_SETTING_KEYS.heloGreeting] = heloGreeting.trim();
    }
    if (settingsCaps.persistentAssistant) {
      updates[PATIENT_SETTING_KEYS.heloPersistentAssistantEnabled] = String(
        persistentAssistantEnabled
      );
    }
    if (settingsCaps.gestures) {
      updates[GESTURE_EMOJI_KEYS.sim] = gestureEmojis.sim.trim();
      updates[GESTURE_EMOJI_KEYS.talvez] = gestureEmojis.talvez.trim();
      updates[GESTURE_EMOJI_KEYS.nao] = gestureEmojis.nao.trim();
    }

    const ok = Object.keys(updates).length > 0 ? await saveSettings(updates) : false;
    if (ok && settingsCaps.profile && patientId != null && patientName.trim()) {
      await renamePatient(patientId, patientName.trim());
    }
    setSaved(ok);
    setTimeout(() => setSaved(false), 2500);
  }, [
    saveSettings,
    renamePatient,
    patientId,
    patientName,
    speechStyle,
    avoidedTopics,
    heloGreeting,
    persistentAssistantEnabled,
    gestureEmojis,
    settingsCaps,
  ]);

  // Prévia de voz: o cliente NUNCA envia voiceId técnico — só ids do
  // catálogo interno aprovado ou a referência ao clone do paciente ativo.
  const playPreview = useCallback(
    async (which: "plataforma" | "paciente", payload: Record<string, unknown>, text: string) => {
      setPreviewing(which);
      try {
        audioRef.current?.pause();
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ...payload }),
        });
        if (!res.ok) return;
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        audioRef.current = audio;
        await audio.play();
      } finally {
        setPreviewing(null);
      }
    },
    []
  );

  const flashVoice = useCallback((msg: string) => {
    setVoiceNotice(msg);
    window.setTimeout(() => setVoiceNotice(null), 3000);
  }, []);

  // Preferência de voz da plataforma — do USUÁRIO logado ("" = padrão da
  // Helo). Não altera a experiência de outros usuários.
  const choosePlatformVoice = useCallback(
    async (id: string) => {
      const r = await fetch("/api/voice-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platformVoiceId: id || null }),
      });
      if (r.ok) {
        setVoicesData((d) => (d ? { ...d, myPlatformVoiceId: id || null } : d));
        flashVoice("Voz da plataforma salva para você.");
      } else {
        flashVoice("Não foi possível salvar a voz da plataforma.");
      }
    },
    [flashVoice]
  );

  // Fonte da voz das falas do paciente: "clone" ou uma voz do catálogo.
  const choosePatientVoice = useCallback(
    async (value: string) => {
      if (patientId == null) return;
      const body =
        value === "clone"
          ? { patientId, source: "clone" }
          : { patientId, source: "platform", platformVoiceId: value };
      const r = await fetch("/api/patient-voice-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setVoicesData((d) =>
          d?.patient
            ? {
                ...d,
                patient: {
                  ...d.patient,
                  source: value === "clone" ? "clone" : "platform",
                  platformVoiceId:
                    value === "clone" ? d.patient.platformVoiceId : value,
                },
              }
            : d
        );
        flashVoice("Voz das falas do paciente salva.");
      } else {
        flashVoice("Não foi possível salvar a voz do paciente.");
      }
    },
    [patientId, flashVoice]
  );

  const addPerson = useCallback(async () => {
    if (!newName.trim() || patientId == null) return;
    await fetch("/api/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, name: newName, relation: newRelation }),
    });
    setNewName("");
    setNewRelation("");
    await loadPeople();
  }, [newName, newRelation, patientId, loadPeople]);

  const removePerson = useCallback(
    async (id: number) => {
      if (patientId == null) return;
      await fetch("/api/people", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId, id }),
      });
      await loadPeople();
    },
    [patientId, loadPeople]
  );

  const createPatient = useCallback(async () => {
    if (!newPatientName.trim()) return;
    setCreatingPatient(true);
    const created = await addPatient(newPatientName.trim());
    setCreatingPatient(false);
    if (created) {
      setNewPatientName("");
      selectPatient(created.id);
    }
  }, [newPatientName, addPatient, selectPatient]);

  return (
    <div className="flex min-h-dvh flex-col pb-24 sm:pb-0">
      <TopBar
        right={
          <>
            {editContext.returnTo && (
              <PillLink href={editContext.returnTo}>← Voltar</PillLink>
            )}
            <PillLink href="/conversa">Conversa</PillLink>
          </>
        }
      />

      <main className="safe-area-pb-spaced mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-8 pl-14 sm:pl-20 xl:pl-6">
        <div>
          <h1 className="text-4xl font-medium tracking-tight">Ajustes</h1>
          <p className="mt-2 text-lg text-ink-soft">
            Ajustes de {patient?.name ?? "paciente"}. Estas configurações pertencem ao paciente selecionado.
          </p>
        </div>

        {/* ——— Paciente ativo ——— */}
        <section id="section-paciente" className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Paciente</h2>
          <p className="text-sm text-ink-soft">
            Tudo nesta página pertence ao paciente selecionado. Trocar de
            paciente troca a experiência inteira.
          </p>
          <div
            role="group"
            aria-label="Escolher paciente"
            className="mt-4 flex flex-wrap gap-2"
          >
            {patients.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPatient(p.id)}
                aria-pressed={p.id === patientId}
                className={`rounded-full border px-5 py-2.5 text-sm font-medium transition-colors ${
                  p.id === patientId
                    ? "border-accent bg-accent text-on-accent"
                    : "border-line bg-cream hover:border-ink-mute"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={newPatientName}
              onChange={(e) => setNewPatientName(e.target.value)}
              placeholder="Nome do novo paciente"
              className="flex-1 rounded-2xl border border-line bg-cream px-4 py-3 outline-none focus:border-ink-mute"
            />
            <button
              type="button"
              onClick={() => void createPatient()}
              disabled={creatingPatient || !newPatientName.trim()}
              className="rounded-full border border-line bg-cream px-6 py-3 font-medium hover:border-ink-mute disabled:opacity-40"
            >
              {creatingPatient ? "Criando…" : "+ Novo paciente"}
            </button>
          </div>
          <label className="mt-5 flex w-full flex-col gap-2">
            <span className="text-sm font-medium text-ink-soft">
              Como o Helo deve se dirigir a {patient?.name ?? "este paciente"}
              {" "}(ex.: “Dr. Fábio, você está com dor?”)
            </span>
            <input
              type="text"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              placeholder="Nome ou tratamento (ex.: Dr. Fábio)"
              className="w-full rounded-2xl border border-line bg-cream px-5 py-3.5 text-lg outline-none focus:border-ink-mute"
            />
          </label>
        </section>

        {/* ——— Aparência do paciente ativo ——— */}
        <div id="section-aparencia"><AppearanceSettings /></div>

        {/* ——— Voz do Agent para o paciente ativo ——— */}
        <div id="section-voz_helo"><HeloVoiceSettings /></div>

        <section className="rounded-3xl border border-line bg-card p-6" aria-labelledby="helo-greeting-title">
          <h2 id="helo-greeting-title" className="font-semibold tracking-tight">Saudação da Helo</h2>
          <p className="text-sm text-ink-soft">
            Escreva a frase que a Helo deve dizer ao iniciar uma conversa com este paciente.
          </p>
          <label className="mt-4 flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-soft">Frase inicial</span>
            <textarea
              value={heloGreeting}
              onChange={(e) => setHeloGreeting(e.target.value.slice(0, HELO_GREETING_MAX_LENGTH))}
              rows={3}
              maxLength={HELO_GREETING_MAX_LENGTH}
              disabled={!settingsCaps?.heloGreeting}
              placeholder="Bom dia, Dr. Fábio! Como você está hoje?"
              className="w-full rounded-2xl border border-line bg-cream px-5 py-3.5 outline-none focus:border-ink-mute disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="text-xs text-ink-mute">{heloGreeting.length}/{HELO_GREETING_MAX_LENGTH} caracteres</span>
          </label>
          <p className="mt-3 text-xs text-ink-mute">
            Evite incluir informações médicas ou dados sensíveis nesta saudação.
          </p>
          {!settingsCaps?.heloGreeting && settingsCaps && (
            <p className="mt-3 text-sm text-ink-mute">Você pode visualizar esta saudação, mas não tem permissão para alterá-la.</p>
          )}
        </section>

        <section className="rounded-3xl border border-line bg-card p-6" aria-labelledby="persistent-assistant-title">
          <div className="flex items-start justify-between gap-5">
            <div>
              <h2 id="persistent-assistant-title" className="font-semibold tracking-tight">Assistente persistente</h2>
              <p className="mt-1 text-sm text-ink-soft">
                Quando ativado, a Helo pode continuar ativa enquanto você navega pela plataforma, permitindo comandos de voz como abrir Rotina, Atividades ou Emergência.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={persistentAssistantEnabled}
              aria-label="Ativar assistente persistente"
              disabled={!settingsCaps?.persistentAssistant}
              onClick={() => setPersistentAssistantEnabled((enabled) => !enabled)}
              className={`relative mt-1 h-8 w-14 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                persistentAssistantEnabled ? "bg-accent" : "bg-line"
              }`}
            >
              {/* `left-1` é obrigatório: sem ele o knob cai na posição
                  estática, que num <button> (text-align: center do
                  navegador) é o CENTRO do trilho — e o translate somava a
                  partir dali, jogando o knob para fora. Ancorado à
                  esquerda, o curso é trilho − knob − 2×folga (56−24−8=24px
                  = translate-x-6), e tudo em rem acompanha a escala de
                  fonte do paciente. */}
              <span
                className={`absolute left-1 top-1 size-6 rounded-full bg-card shadow-sm transition-transform ${
                  persistentAssistantEnabled ? "translate-x-6" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <p className="mt-4 text-xs text-ink-mute">
            A Helo só continua ativa depois que você iniciar a conversa. Você verá sempre um indicador enquanto ela estiver ativa e poderá encerrá-la a qualquer momento.
          </p>
          {!settingsCaps?.persistentAssistant && settingsCaps && (
            <p className="mt-3 text-sm text-ink-mute">Você pode visualizar esta opção, mas não tem permissão para alterá-la.</p>
          )}
        </section>

        {/* ——— Estilo de comunicação ——— */}
        <section id="section-comunicacao" className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Estilo de comunicação</h2>
          <p className="text-sm text-ink-soft">
            Usado pela IA para sugerir frases com o jeito de falar do paciente.
            A sugestão nunca substitui a confirmação por gesto.
          </p>
          <label className="mt-4 flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-soft">
              Jeito de falar, tom e vocabulário
            </span>
            <textarea
              value={speechStyle}
              onChange={(e) => setSpeechStyle(e.target.value)}
              rows={3}
              placeholder="Ex.: fala formal, chama a esposa de 'minha querida', prefere frases curtas e diretas"
              className="w-full rounded-2xl border border-line bg-cream px-5 py-3.5 outline-none focus:border-ink-mute"
            />
          </label>
          <label className="mt-4 flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-soft">
              Temas que devem ser evitados
            </span>
            <textarea
              value={avoidedTopics}
              onChange={(e) => setAvoidedTopics(e.target.value)}
              rows={2}
              placeholder="Ex.: não sugerir assuntos sobre a doença do irmão"
              className="w-full rounded-2xl border border-line bg-cream px-5 py-3.5 outline-none focus:border-ink-mute"
            />
          </label>
        </section>

        {/* ——— Gestos ——— */}
        <section id="section-gestos" className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Gestos</h2>
          <p className="text-sm text-ink-soft">
            Escolha a mão que representa cada gesto — adapte ao que o paciente
            consegue fazer. O significado (Sim, Talvez, Não) não muda.
          </p>
          <div className="mt-4 flex flex-col gap-5">
            {GESTURE_ORDER.map((g) => {
              const selected = gestureEmojis[g].trim() || GESTURES[g].emoji;
              return (
                <div
                  key={g}
                  className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4"
                >
                  <div className="flex w-24 shrink-0 items-center gap-2 sm:pt-1">
                    <span className="text-3xl" aria-hidden="true">
                      {selected}
                    </span>
                    <span className="text-sm font-medium">{GESTURES[g].label}</span>
                  </div>
                  <div
                    role="group"
                    aria-label={`Emoji para ${GESTURES[g].label}`}
                    className="flex flex-wrap gap-1.5"
                  >
                    {GESTURE_PALETTES[g].map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() =>
                          setGestureEmojis((prev) => ({ ...prev, [g]: e }))
                        }
                        aria-pressed={selected === e}
                        aria-label={`Usar ${e} para ${GESTURES[g].label}`}
                        className={`flex h-10 w-10 items-center justify-center rounded-xl border text-xl transition-colors ${
                          selected === e
                            ? "border-accent bg-cream"
                            : "border-line hover:border-ink-mute"
                        }`}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ——— Voz ——— */}
        {/* Duas configurações DIFERENTES, ambas restritas ao catálogo
            aprovado pelo Admin: a voz da plataforma (preferência do usuário
            logado) e a voz das falas do paciente (clone dele ou catálogo).
            Sem a permissão correspondente, o campo é somente leitura. */}
        <section className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Voz</h2>
          <p className="text-sm text-ink-soft">
            As vozes disponíveis são as aprovadas pelo administrador. A voz
            clonada de um paciente só aparece no contexto dele.
          </p>
          {voiceNotice && (
            <p role="status" className="mt-3 rounded-2xl bg-sim-soft px-4 py-2 text-sm text-sim">
              {voiceNotice}
            </p>
          )}
          {voicesError ? (
            <p className="mt-4 rounded-2xl bg-talvez-soft px-4 py-3 text-sm text-talvez">
              Não foi possível carregar as vozes agora. Sem elas, o app usa a
              voz padrão da Helo (ou a voz local do navegador, identificada).
            </p>
          ) : voicesData === null ? (
            <p className="mt-4 text-sm text-ink-mute">Carregando vozes…</p>
          ) : (
            <div className="mt-4 flex flex-col gap-6">
              {/* Voz da plataforma — preferência do usuário logado */}
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-ink-soft">
                  Voz da plataforma Helo (a sua preferência — não muda a dos
                  outros usuários)
                </span>
                {voicesData.canSelectPlatformVoice ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      value={voicesData.myPlatformVoiceId ?? ""}
                      onChange={(e) => void choosePlatformVoice(e.target.value)}
                      aria-label="Escolher voz da plataforma"
                      className="w-full flex-1 rounded-2xl border border-line bg-cream px-5 py-3.5 text-lg outline-none focus:border-ink-mute"
                    >
                      <option value="">Voz padrão da Helo</option>
                      {voicesData.voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.displayName}
                          {v.isDefault ? " · padrão" : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        const id =
                          voicesData.myPlatformVoiceId ??
                          voicesData.defaultVoiceId;
                        if (id)
                          void playPreview(
                            "plataforma",
                            { previewPlatformVoiceId: id },
                            "Olá, eu sou a Helo. É assim que eu falo com vocês."
                          );
                      }}
                      disabled={previewing !== null || !voicesData.platformVoiceReady}
                      className="self-start rounded-full border border-line bg-cream px-5 py-2.5 text-sm font-medium hover:border-ink-mute disabled:opacity-40"
                    >
                      {previewing === "plataforma" ? "Falando…" : "🔊 Ouvir"}
                    </button>
                  </div>
                ) : (
                  <p className="rounded-2xl bg-cream px-5 py-3.5 text-ink-soft">
                    {voicesData.voices.find(
                      (v) => v.id === voicesData.defaultVoiceId
                    )?.displayName ?? "Voz padrão da Helo"}
                    <span className="mt-1 block text-xs text-ink-mute">
                      Definida pelo administrador. Peça a permissão “escolher
                      voz da plataforma” para personalizar.
                    </span>
                  </p>
                )}
              </div>

              {/* Voz das falas do paciente — clone dele ou catálogo */}
              {voicesData.patient && (
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-ink-soft">
                    Voz para as falas de {patient?.name ?? "este paciente"}
                    {" "}(Emergência e mensagens confirmadas)
                  </span>
                  {!voicesData.patient.hasClone && (
                    <p className="text-xs text-ink-mute">
                      Voz clonada não configurada para este paciente — a
                      atribuição é feita pelo administrador.
                    </p>
                  )}
                  {voicesData.patient.canSelectPatientVoiceSource ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <select
                        value={
                          voicesData.patient.source === "clone"
                            ? "clone"
                            : voicesData.patient.platformVoiceId ??
                              voicesData.defaultVoiceId ??
                              ""
                        }
                        onChange={(e) => void choosePatientVoice(e.target.value)}
                        aria-label="Escolher voz para as falas do paciente"
                        className="w-full flex-1 rounded-2xl border border-line bg-cream px-5 py-3.5 text-lg outline-none focus:border-ink-mute"
                      >
                        {voicesData.patient.hasClone && (
                          <option value="clone">
                            {voicesData.patient.cloneName ??
                              `Voz clonada de ${patient?.name ?? "paciente"}`}
                          </option>
                        )}
                        {voicesData.voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.displayName}
                            {v.isDefault ? " · padrão" : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const p = voicesData.patient!;
                          const payload =
                            p.source === "clone"
                              ? { previewPatientVoice: { patientId, source: "clone" } }
                              : {
                                  previewPatientVoice: {
                                    patientId,
                                    source: "platform",
                                    platformVoiceId:
                                      p.platformVoiceId ?? voicesData.defaultVoiceId,
                                  },
                                };
                          void playPreview(
                            "paciente",
                            payload,
                            `Olá${patientName ? `, eu sou ${patientName}` : ""}. Esta será a voz das minhas mensagens.`
                          );
                        }}
                        disabled={previewing !== null || !voicesData.platformVoiceReady}
                        className="self-start rounded-full border border-line bg-cream px-5 py-2.5 text-sm font-medium hover:border-ink-mute disabled:opacity-40"
                      >
                        {previewing === "paciente" ? "Falando…" : "🔊 Ouvir"}
                      </button>
                    </div>
                  ) : (
                    <p className="rounded-2xl bg-cream px-5 py-3.5 text-ink-soft">
                      {voicesData.patient.source === "clone"
                        ? voicesData.patient.cloneName ??
                          `Voz clonada de ${patient?.name ?? "paciente"}`
                        : voicesData.voices.find(
                            (v) =>
                              v.id ===
                              (voicesData.patient!.platformVoiceId ??
                                voicesData.defaultVoiceId)
                          )?.displayName ?? "Voz padrão da Helo"}
                      <span className="mt-1 block text-xs text-ink-mute">
                        Somente leitura — a alteração exige a permissão
                        “{"Escolher a voz das falas do paciente"}”.
                      </span>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ——— Rede de pessoas ——— */}
        <section className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Rede de pessoas</h2>
          <p className="text-sm text-ink-soft">
            Pessoas importantes na vida do paciente. Elas aparecem quando ele
            escolhe “Falar com alguém” na conversa.
          </p>

          <ul className="mt-4 flex flex-col gap-2">
            {people.length === 0 && (
              <li className="text-sm text-ink-mute">Ninguém cadastrado ainda.</li>
            )}
            {people.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-2xl bg-cream px-4 py-3"
              >
                <span>
                  <strong className="font-medium">{p.name}</strong>
                  {p.relation && <span className="text-ink-soft"> · {p.relation}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => void removePerson(p.id)}
                  aria-label={`Remover ${p.name}`}
                  className="rounded-full px-3 py-1 text-sm text-ink-soft hover:bg-nao-soft hover:text-nao"
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome (ex.: Ana)"
              className="flex-1 rounded-2xl border border-line bg-cream px-4 py-3 outline-none focus:border-ink-mute"
            />
            <input
              type="text"
              value={newRelation}
              onChange={(e) => setNewRelation(e.target.value)}
              placeholder="Relação (ex.: esposa)"
              className="flex-1 rounded-2xl border border-line bg-cream px-4 py-3 outline-none focus:border-ink-mute"
            />
            <button
              type="button"
              onClick={() => void addPerson()}
              className="rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong"
            >
              Adicionar
            </button>
          </div>
        </section>

        {/* ——— Frases por modo ——— */}
        <ModeItemsEditor
          focusItemId={editContext.mode === "rotina" ? editContext.itemId : null}
          returnTo={editContext.mode === "rotina" ? editContext.returnTo : null}
          mode="rotina"
          title="Frases da Rotina"
          description="As frases rápidas do dia a dia deste paciente. Ficam disponíveis mesmo sem internet e sem IA."
          labelPlaceholder="Título do botão (ex.: Ajustar cadeira)"
          spokenPlaceholder="Frase falada (ex.: Quero ajustar minha cadeira, por favor.)"
        />
        <ModeItemsEditor
          focusItemId={editContext.mode === "emergencia" ? editContext.itemId : null}
          returnTo={editContext.mode === "emergencia" ? editContext.returnTo : null}
          mode="emergencia"
          title="Ações de Emergência"
          description="Mensagens críticas deste paciente. O toque fala na hora — edite com cuidado. Itens padrão podem ser desativados, mas não excluídos."
          labelPlaceholder="Título (ex.: Preciso ser aspirado)"
          spokenPlaceholder="Frase falada (ex.: Preciso de ajuda com a aspiração agora.)"
        />
        <ModeItemsEditor
          focusItemId={editContext.mode === "conversa" ? editContext.itemId : null}
          returnTo={editContext.mode === "conversa" ? editContext.returnTo : null}
          mode="conversa"
          title="Expressões preferidas na Conversa"
          description="O jeito típico deste paciente dizer as coisas. A IA usa como referência de estilo e as expressões aparecem primeiro ao montar mensagens."
          labelPlaceholder="Quando usar (ex.: Pedir descanso)"
          spokenPlaceholder="Como o paciente diria (ex.: Estou cansado, quero ficar quieto um pouco.)"
        />

        {/* Mobile: gruda ACIMA do menu inferior fixo (~71px + safe area) —
            o Salvar nunca fica atrás dele. Desktop segue a 16px do fundo. */}
        <div className="sticky bottom-24 flex items-center gap-3 sm:bottom-4">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!settingsCaps}
            className="rounded-full bg-accent px-8 py-3.5 font-medium text-on-accent shadow-soft hover:bg-accent-strong"
          >
            Salvar ajustes
          </button>
          {saved && <span className="rounded-full bg-card px-3 py-1 text-sim">✓ Salvo</span>}
        </div>
      </main>
    </div>
  );
}

// ——— Editor de itens de um modo, sempre no escopo do paciente ativo ———
// Reordenação por botões ↑/↓ (acessível por toque e teclado — sem depender
// de drag and drop). Excluir só remove itens personalizados; itens padrão
// são desativados e podem voltar com "Restaurar padrão".
function ModeItemsEditor({
  mode,
  title,
  description,
  labelPlaceholder,
  spokenPlaceholder,
  focusItemId = null,
  returnTo = null,
}: {
  mode: HeloItemMode;
  title: string;
  description: string;
  labelPlaceholder: string;
  spokenPlaceholder: string;
  /** Deep link de edição contextual: abre este item já em edição. */
  focusItemId?: string | null;
  /** Tela de origem do deep link — oferecida de volta depois de salvar. */
  returnTo?: string | null;
}) {
  const { patientId } = usePatient();
  const dialog = useHeloDialog();
  const { items, reload, loading } = usePatientItems(mode);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editSpoken, setEditSpoken] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSpoken, setNewSpoken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Deep link: quando o item pedido chega na lista, abre a edição dele e
  // rola a seção até aqui — uma única vez (o usuário segue livre depois).
  const sectionRef = useRef<HTMLElement | null>(null);
  const focusApplied = useRef(false);
  const [savedFromContext, setSavedFromContext] = useState(false);
  useEffect(() => {
    if (!focusItemId || focusApplied.current) return;
    const item = items.find((i) => i.id === focusItemId);
    if (!item) return;
    focusApplied.current = true;
    const frame = window.requestAnimationFrame(() => {
      setEditing(item.id);
      setEditLabel(item.label);
      setEditSpoken(item.spokenText);
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusItemId, items]);

  const api = useCallback(
    async (init: RequestInit): Promise<boolean> => {
      setBusy(true);
      try {
        const r = await fetch("/api/items", {
          headers: { "Content-Type": "application/json" },
          ...init,
        });
        if (!r.ok) {
          setNotice("Não foi possível salvar. Verifique a conexão e tente de novo.");
          return false;
        }
        setNotice(null);
        await reload();
        return true;
      } catch {
        setNotice("Sem conexão — a alteração não foi salva.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  const add = useCallback(async () => {
    if (!newLabel.trim() || !newSpoken.trim() || patientId == null) return;
    const ok = await api({
      method: "POST",
      body: JSON.stringify({
        patientId,
        mode,
        item: { label: newLabel, spokenText: newSpoken },
      }),
    });
    if (ok) {
      setNewLabel("");
      setNewSpoken("");
    }
  }, [api, newLabel, newSpoken, patientId, mode]);

  const startEdit = useCallback((item: ModeItem) => {
    setEditing(item.id);
    setEditLabel(item.label);
    setEditSpoken(item.spokenText);
  }, []);

  const saveEdit = useCallback(async () => {
    if (editing == null || patientId == null) return;
    if (!editLabel.trim() || !editSpoken.trim()) return;
    const ok = await api({
      method: "PATCH",
      body: JSON.stringify({
        patientId,
        itemId: editing,
        item: { label: editLabel, spokenText: editSpoken },
      }),
    });
    if (ok) {
      // Veio por edição contextual e salvou o item pedido: oferece o
      // retorno claro à tela de origem (sem navegar sozinho).
      if (returnTo && editing === focusItemId) setSavedFromContext(true);
      setEditing(null);
    }
  }, [api, editing, editLabel, editSpoken, patientId, returnTo, focusItemId]);

  const toggle = useCallback(
    (item: ModeItem) =>
      api({
        method: "PATCH",
        body: JSON.stringify({
          patientId,
          itemId: item.id,
          item: { enabled: !item.enabled },
        }),
      }),
    [api, patientId]
  );

  const remove = useCallback(
    async (item: ModeItem) => {
      const confirmed = item.isDefault
        ? await dialog.confirm({
            title: "Desativar item padrão?",
            message: `"${item.label}" é um item padrão: ele será desativado, mas pode voltar depois com "Restaurar padrão".`,
            confirmLabel: "Desativar",
            cancelLabel: "Cancelar",
            tone: "warning",
          })
        : await dialog.confirm({
            title: "Excluir item?",
            message: `Excluir "${item.label}" deste paciente? Esta ação não pode ser desfeita.`,
            confirmLabel: "Excluir",
            cancelLabel: "Cancelar",
            tone: "danger",
          });
      if (!confirmed) return;
      await api({
        method: "DELETE",
        body: JSON.stringify({ patientId, itemId: item.id }),
      });
    },
    [api, dialog, patientId]
  );

  const move = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= items.length) return;
      const ids = items.map((i) => i.id);
      [ids[index], ids[target]] = [ids[target], ids[index]];
      void api({
        method: "POST",
        body: JSON.stringify({ patientId, mode, order: ids }),
      });
    },
    [api, items, patientId, mode]
  );

  const restore = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: "Restaurar conteúdo padrão?",
      message:
        "Itens padrão voltam ao texto e à ordem originais; os personalizados são mantidos.",
      confirmLabel: "Restaurar",
      cancelLabel: "Cancelar",
      tone: "warning",
    });
    if (!confirmed) return;
    await api({
      method: "POST",
      body: JSON.stringify({ patientId, mode, action: "restore" }),
    });
  }, [api, dialog, patientId, mode]);

  return (
    <section ref={sectionRef} className="rounded-3xl border border-line bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 max-w-lg text-sm text-ink-soft">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => void restore()}
          disabled={busy}
          className="rounded-full border border-line bg-cream px-4 py-2 text-sm font-medium hover:border-ink-mute disabled:opacity-40"
        >
          Restaurar padrão
        </button>
      </div>

      {notice && (
        <p role="alert" className="mt-3 rounded-2xl bg-talvez-soft px-4 py-2 text-sm text-talvez">
          {notice}
        </p>
      )}

      {savedFromContext && returnTo && (
        <p
          role="status"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-sim-soft px-4 py-2.5 text-sm text-sim"
        >
          <span>✓ Alteração salva.</span>
          <a
            href={returnTo}
            className="rounded-full border border-sim/40 bg-white px-4 py-1.5 font-medium text-sim hover:border-sim"
          >
            ← Voltar para onde eu estava
          </a>
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-2">
        {items.length === 0 && (
          <li className="text-sm text-ink-mute">
            {loading ? "Carregando…" : "Nenhuma frase ainda. Adicione a primeira abaixo."}
          </li>
        )}
        {items.map((item, idx) =>
          editing === item.id ? (
            <li key={item.id} className="flex flex-col gap-2 rounded-2xl bg-cream p-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-ink-soft">Título</span>
                <input
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  className="rounded-xl border border-line bg-card px-3 py-2 outline-none focus:border-ink-mute"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-ink-soft">Frase falada</span>
                <textarea
                  value={editSpoken}
                  onChange={(e) => setEditSpoken(e.target.value)}
                  rows={2}
                  className="rounded-xl border border-line bg-card px-3 py-2 outline-none focus:border-ink-mute"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={busy || !editLabel.trim() || !editSpoken.trim()}
                  className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40"
                >
                  Salvar
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="rounded-full border border-line px-5 py-2 text-sm font-medium hover:border-ink-mute"
                >
                  Cancelar
                </button>
              </div>
            </li>
          ) : (
            <li
              key={item.id}
              className={`flex flex-col gap-3 rounded-2xl bg-cream px-4 py-3 sm:flex-row sm:items-start sm:justify-between ${
                item.enabled ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {item.label}
                  {!item.isDefault && (
                    <span className="ml-2 rounded-full bg-lilas/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                      personalizada
                    </span>
                  )}
                  {!item.enabled && (
                    <span className="ml-2 rounded-full bg-talvez-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-talvez">
                      desativada
                    </span>
                  )}
                </p>
                <p className="truncate text-sm text-ink-soft">“{item.spokenText}”</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={busy || idx === 0}
                  aria-label={`Mover ${item.label} para cima`}
                  className="h-9 w-9 rounded-full border border-line text-sm hover:border-ink-mute disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={busy || idx === items.length - 1}
                  aria-label={`Mover ${item.label} para baixo`}
                  className="h-9 w-9 rounded-full border border-line text-sm hover:border-ink-mute disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(item)}
                  disabled={busy}
                  aria-label={`Editar ${item.label}`}
                  className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-ink-mute disabled:opacity-30"
                >
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => void toggle(item)}
                  disabled={busy}
                  aria-pressed={!item.enabled}
                  className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-ink-mute disabled:opacity-30"
                >
                  {item.enabled ? "Desativar" : "Ativar"}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(item)}
                  disabled={busy}
                  aria-label={`${item.isDefault ? "Desativar" : "Excluir"} ${item.label}`}
                  className="rounded-full px-3 py-1.5 text-sm text-ink-soft hover:bg-nao-soft hover:text-nao disabled:opacity-30"
                >
                  ✕
                </button>
              </div>
            </li>
          )
        )}
      </ul>

      <div className="mt-4 flex flex-col gap-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder={labelPlaceholder}
          className="rounded-2xl border border-line bg-cream px-4 py-3 outline-none focus:border-ink-mute"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={newSpoken}
            onChange={(e) => setNewSpoken(e.target.value)}
            placeholder={spokenPlaceholder}
            className="flex-1 rounded-2xl border border-line bg-cream px-4 py-3 outline-none focus:border-ink-mute"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !newLabel.trim() || !newSpoken.trim()}
            className="rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40"
          >
            Adicionar
          </button>
        </div>
      </div>
    </section>
  );
}
