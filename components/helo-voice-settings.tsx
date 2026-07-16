"use client";

import { useEffect, useState } from "react";
import type { HeloVoicePreference } from "@/lib/access-types";

const OPTIONS: Array<{ value: HeloVoicePreference; label: string; description: string }> = [
  { value: "female", label: "Voz feminina", description: "A voz feminina será usada na próxima conversa com a Helo." },
  { value: "male", label: "Voz masculina", description: "A voz masculina será usada na próxima conversa com a Helo." },
];

/** Preferência pessoal da voz do Agent Helo — nunca pertence ao paciente. */
export function HeloVoiceSettings() {
  const [value, setValue] = useState<HeloVoicePreference>("female");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: { heloVoicePreference?: HeloVoicePreference | null } } | null) => {
        if (data?.user?.heloVoicePreference) setValue(data.user.heloVoicePreference);
      })
      .catch(() => {});
  }, []);

  const choose = async (next: HeloVoicePreference) => {
    if (saving || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/voice-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heloVoicePreference: next }),
      });
      if (!response.ok) throw new Error();
      setNotice("Preferência salva. Ela será aplicada na próxima conversa.");
    } catch {
      setValue(previous);
      setNotice("Não foi possível salvar a preferência de voz.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="helo-voice-title" className="rounded-3xl border border-line bg-card p-6">
      <h2 id="helo-voice-title" className="font-semibold tracking-tight">Voz da Helo</h2>
      <p className="text-sm text-ink-soft">
        Esta é a sua preferência pessoal. Ela não altera a voz do paciente nem a escolha de outros usuários.
      </p>
      <div role="radiogroup" aria-label="Voz do Agent Helo" className="mt-4 grid gap-3 sm:grid-cols-2">
        {OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              onClick={() => void choose(option.value)}
              className={`rounded-2xl border p-4 text-left transition-colors disabled:opacity-60 ${
                selected ? "border-accent ring-2 ring-accent" : "border-line hover:border-ink-mute"
              }`}
            >
              <span className="flex items-center justify-between gap-3 font-medium">
                {option.label}
                <span aria-hidden="true" className={`flex size-5 items-center justify-center rounded-full border text-xs ${selected ? "border-accent bg-accent text-on-accent" : "border-line text-transparent"}`}>✓</span>
              </span>
              <span className="mt-1 block text-sm text-ink-soft">{option.description}</span>
            </button>
          );
        })}
      </div>
      {notice && <p role="status" className="mt-3 text-sm text-ink-soft">{notice}</p>}
    </section>
  );
}
