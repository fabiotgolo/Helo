"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { GESTURES, type Gesture } from "@/lib/types";
import { GESTURE_EMOJI_KEYS, GESTURES_UPDATED_EVENT } from "@/lib/gestures";

type Voice = { id: string; name: string; labels: Record<string, string> };
type Person = { id: number; name: string; relation: string | null };

const GESTURE_ORDER: Gesture[] = ["sim", "talvez", "nao"];

// Painel de emojis SÓ com as mãos, para representar os gestos.
const HAND_EMOJIS = ["👍", "👎", "✊", "✋", "🤚", "🖐️", "👊", "✌️", "👌"];

export default function AjustesPage() {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesError, setVoicesError] = useState(false);
  const [voiceId, setVoiceId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [gestureEmojis, setGestureEmojis] = useState<Record<Gesture, string>>({
    sim: "",
    talvez: "",
    nao: "",
  });
  const [people, setPeople] = useState<Person[]>([]);
  const [newName, setNewName] = useState("");
  const [newRelation, setNewRelation] = useState("");
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => r.json())
      .then((s: Record<string, string>) => {
        setVoiceId(s.voice_id ?? "");
        setPatientName(s.patient_name ?? "");
        setGestureEmojis({
          sim: s[GESTURE_EMOJI_KEYS.sim] ?? "",
          talvez: s[GESTURE_EMOJI_KEYS.talvez] ?? "",
          nao: s[GESTURE_EMOJI_KEYS.nao] ?? "",
        });
      })
      .catch(() => {});
    void fetch("/api/voices")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { voices: Voice[] }) => setVoices(d.voices))
      .catch(() => setVoicesError(true));
    void loadPeople();
  }, []);

  const loadPeople = async () => {
    try {
      const r = await fetch("/api/people");
      const d = (await r.json()) as { people: Person[] };
      setPeople(d.people);
    } catch {
      /* segue sem rede */
    }
  };

  const save = useCallback(async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_id: voiceId,
        patient_name: patientName,
        [GESTURE_EMOJI_KEYS.sim]: gestureEmojis.sim.trim(),
        [GESTURE_EMOJI_KEYS.talvez]: gestureEmojis.talvez.trim(),
        [GESTURE_EMOJI_KEYS.nao]: gestureEmojis.nao.trim(),
      }),
    });
    // Avisa o provider de gestos para recarregar os emojis na hora.
    window.dispatchEvent(new Event(GESTURES_UPDATED_EVENT));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }, [voiceId, patientName, gestureEmojis]);

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
    [patientName]
  );

  const addPerson = useCallback(async () => {
    if (!newName.trim()) return;
    await fetch("/api/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, relation: newRelation }),
    });
    setNewName("");
    setNewRelation("");
    await loadPeople();
  }, [newName, newRelation]);

  const removePerson = useCallback(async (id: number) => {
    await fetch("/api/people", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await loadPeople();
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar right={<PillLink href="/conversa">Conversa</PillLink>} />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-8">
        <div>
          <h1 className="text-4xl font-medium tracking-tight">Ajustes</h1>
          <p className="mt-2 text-lg text-ink-soft">
            Identidade do paciente, gestos, voz e rede de pessoas.
          </p>
        </div>

        {/* ——— Paciente ——— */}
        <section className="rounded-3xl border border-line bg-card p-6">
          <h2 className="font-semibold tracking-tight">Paciente</h2>
          <p className="text-sm text-ink-soft">
            Como o Helo deve se dirigir ao paciente (ex.: “Dr. Fábio, você está com dor?”).
          </p>
          <input
            type="text"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            placeholder="Nome ou tratamento (ex.: Dr. Fábio)"
            className="mt-4 w-full rounded-2xl border border-line bg-cream px-5 py-3.5 text-lg outline-none focus:border-ink-mute"
          />
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
                    {HAND_EMOJIS.map((e) => (
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
            Vozes da sua conta ElevenLabs — incluindo a clonagem autorizada da voz do paciente.
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
            Pessoas importantes na vida do paciente. Elas aparecem quando ele escolhe
            “Falar com alguém” na conversa.
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

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            className="rounded-full bg-ink px-8 py-3.5 font-medium text-white hover:bg-black"
          >
            Salvar ajustes
          </button>
          {saved && <span className="text-sim">✓ Salvo</span>}
        </div>
      </main>
    </div>
  );
}
