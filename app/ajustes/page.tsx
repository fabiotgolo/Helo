"use client";

// ——— Ajustes: a área de configuração, separada do fluxo de comunicação ———
// Tudo aqui é POR PACIENTE: identidade, estilo de comunicação, gestos, voz,
// rede de pessoas e as frases de Rotina, Emergência e expressões de Conversa.
// A edição nunca acontece nas telas de uso — só aqui, por quem cuida.

import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { GESTURES, type Gesture, type HeloItemMode, type ModeItem } from "@/lib/types";
import { GESTURE_EMOJI_KEYS } from "@/lib/gestures";
import { usePatient, usePatientItems } from "@/lib/patient";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";

type Voice = { id: string; name: string; labels: Record<string, string> };
type Person = { id: number; name: string; relation: string | null };

const GESTURE_ORDER: Gesture[] = ["sim", "talvez", "nao"];

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

  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesError, setVoicesError] = useState(false);
  const [voiceId, setVoiceId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [speechStyle, setSpeechStyle] = useState("");
  const [avoidedTopics, setAvoidedTopics] = useState("");
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
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // O formulário espelha as configurações do paciente ativo; trocar de
  // paciente recarrega tudo — nada de um vaza para o outro.
  useEffect(() => {
    setVoiceId(settings[PATIENT_SETTING_KEYS.voiceId] ?? "");
    setPatientName(settings[PATIENT_SETTING_KEYS.name] ?? "");
    setSpeechStyle(settings[PATIENT_SETTING_KEYS.speechStyle] ?? "");
    setAvoidedTopics(settings[PATIENT_SETTING_KEYS.avoidedTopics] ?? "");
    setGestureEmojis({
      sim: settings[GESTURE_EMOJI_KEYS.sim] ?? "",
      talvez: settings[GESTURE_EMOJI_KEYS.talvez] ?? "",
      nao: settings[GESTURE_EMOJI_KEYS.nao] ?? "",
    });
  }, [settings]);

  useEffect(() => {
    void fetch("/api/voices")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { voices: Voice[] }) => setVoices(d.voices))
      .catch(() => setVoicesError(true));
  }, []);

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
    setPeople([]);
    void loadPeople();
  }, [loadPeople]);

  const save = useCallback(async () => {
    const ok = await saveSettings({
      [PATIENT_SETTING_KEYS.voiceId]: voiceId,
      [PATIENT_SETTING_KEYS.name]: patientName,
      [PATIENT_SETTING_KEYS.speechStyle]: speechStyle.trim(),
      [PATIENT_SETTING_KEYS.avoidedTopics]: avoidedTopics.trim(),
      [GESTURE_EMOJI_KEYS.sim]: gestureEmojis.sim.trim(),
      [GESTURE_EMOJI_KEYS.talvez]: gestureEmojis.talvez.trim(),
      [GESTURE_EMOJI_KEYS.nao]: gestureEmojis.nao.trim(),
    });
    if (ok && patientId != null && patientName.trim()) {
      await renamePatient(patientId, patientName.trim());
    }
    setSaved(ok);
    setTimeout(() => setSaved(false), 2500);
  }, [
    saveSettings,
    renamePatient,
    patientId,
    voiceId,
    patientName,
    speechStyle,
    avoidedTopics,
    gestureEmojis,
  ]);

  const preview = useCallback(
    async (id: string) => {
      setPreviewing(true);
      try {
        audioRef.current?.pause();
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `Olá${patientName ? `, ${patientName}` : ""}. Eu sou a voz do Helo. O elo entre sentir e dizer.`,
            voiceId: id || undefined,
            patientId,
          }),
        });
        if (!res.ok) return;
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        audioRef.current = audio;
        await audio.play();
      } finally {
        setPreviewing(false);
      }
    },
    [patientName, patientId]
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
    <div className="flex min-h-dvh flex-col">
      <TopBar right={<PillLink href="/conversa">Conversa</PillLink>} />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div>
          <h1 className="text-4xl font-medium tracking-tight">Ajustes</h1>
          <p className="mt-2 text-lg text-ink-soft">
            Cada paciente tem sua própria Helo: frases, gestos, voz e pessoas.
          </p>
        </div>

        {/* ——— Paciente ativo ——— */}
        <section className="rounded-3xl border border-line bg-card p-6">
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
                    ? "border-ink bg-ink text-white"
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

        {/* ——— Estilo de comunicação ——— */}
        <section className="rounded-3xl border border-line bg-card p-6">
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
        <section className="rounded-3xl border border-line bg-card p-6">
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
                            ? "border-ink bg-cream"
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
        <section className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Voz do Helo</h2>
          <p className="text-sm text-ink-soft">
            Vozes da sua conta ElevenLabs — incluindo a clonagem autorizada da
            voz deste paciente.
          </p>
          {voicesError ? (
            <p className="mt-4 rounded-2xl bg-talvez-soft px-4 py-3 text-sm text-talvez">
              Sem conexão com a ElevenLabs. Verifique a chave em <code>.env</code>. Enquanto
              isso, o app usa a voz local do navegador.
            </p>
          ) : voices === null ? (
            <p className="mt-4 text-sm text-ink-mute">Carregando vozes…</p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                aria-label="Escolher voz"
                className="w-full rounded-2xl border border-line bg-cream px-5 py-3.5 text-lg outline-none focus:border-ink-mute"
              >
                <option value="">Padrão (definida no .env)</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.labels.language ? ` · ${v.labels.language}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void preview(voiceId)}
                disabled={previewing}
                className="self-start rounded-full border border-line bg-cream px-5 py-2.5 text-sm font-medium hover:border-ink-mute disabled:opacity-40"
              >
                {previewing ? "Falando…" : "🔊 Ouvir prévia"}
              </button>
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
              className="rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black"
            >
              Adicionar
            </button>
          </div>
        </section>

        {/* ——— Frases por modo ——— */}
        <ModeItemsEditor
          mode="rotina"
          title="Frases da Rotina"
          description="As frases rápidas do dia a dia deste paciente. Ficam disponíveis mesmo sem internet e sem IA."
          labelPlaceholder="Título do botão (ex.: Ajustar cadeira)"
          spokenPlaceholder="Frase falada (ex.: Quero ajustar minha cadeira, por favor.)"
        />
        <ModeItemsEditor
          mode="emergencia"
          title="Ações de Emergência"
          description="Mensagens críticas deste paciente. O toque fala na hora — edite com cuidado. Itens padrão podem ser desativados, mas não excluídos."
          labelPlaceholder="Título (ex.: Preciso ser aspirado)"
          spokenPlaceholder="Frase falada (ex.: Preciso de ajuda com a aspiração agora.)"
        />
        <ModeItemsEditor
          mode="conversa"
          title="Expressões preferidas na Conversa"
          description="O jeito típico deste paciente dizer as coisas. A IA usa como referência de estilo e as expressões aparecem primeiro ao montar mensagens."
          labelPlaceholder="Quando usar (ex.: Pedir descanso)"
          spokenPlaceholder="Como o paciente diria (ex.: Estou cansado, quero ficar quieto um pouco.)"
        />

        <div className="sticky bottom-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            className="rounded-full bg-ink px-8 py-3.5 font-medium text-white shadow-[var(--shadow-soft)] hover:bg-black"
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
}: {
  mode: HeloItemMode;
  title: string;
  description: string;
  labelPlaceholder: string;
  spokenPlaceholder: string;
}) {
  const { patientId } = usePatient();
  const { items, reload, loading } = usePatientItems(mode);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editSpoken, setEditSpoken] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSpoken, setNewSpoken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
    if (ok) setEditing(null);
  }, [api, editing, editLabel, editSpoken, patientId]);

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
      const question = item.isDefault
        ? `"${item.label}" é um item padrão: ele será desativado (pode voltar com Restaurar padrão). Continuar?`
        : `Excluir "${item.label}" deste paciente?`;
      if (!window.confirm(question)) return;
      await api({
        method: "DELETE",
        body: JSON.stringify({ patientId, itemId: item.id }),
      });
    },
    [api, patientId]
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
    if (
      !window.confirm(
        "Restaurar o conteúdo padrão? Itens padrão voltam ao texto e à ordem originais; os personalizados são mantidos."
      )
    )
      return;
    await api({
      method: "POST",
      body: JSON.stringify({ patientId, mode, action: "restore" }),
    });
  }, [api, patientId, mode]);

  return (
    <section className="rounded-3xl border border-line bg-card p-6">
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
                  className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-40"
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
            className="rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black disabled:opacity-40"
          >
            Adicionar
          </button>
        </div>
      </div>
    </section>
  );
}
