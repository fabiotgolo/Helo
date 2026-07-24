"use client";

import { useState } from "react";
import type { HeloVoicePreference } from "@/lib/access-types";
import { isHeloPersistentAssistantEnabled, PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { usePatient } from "@/lib/patient";
import { useHeloAgent } from "@/components/helo-agent-provider";

const OPTIONS: Array<{ value: HeloVoicePreference; label: string; description: string }> = [
  { value: "female", label: "Voz feminina", description: "Será usada na próxima conversa com a Helo deste paciente." },
  { value: "male", label: "Voz masculina", description: "Será usada na próxima conversa com a Helo deste paciente." },
];

/** Preferência compartilhada da voz do Agent Helo para o paciente ativo. */
export function HeloVoiceSettings() {
  const { patient, patientId, settings, saveSettings } = usePatient();
  const { activeSessionPatientId, sessionStatus, restarting, restartForVoiceChange } = useHeloAgent();
  const configured = settings[PATIENT_SETTING_KEYS.heloVoicePreference];
  const current: HeloVoicePreference = configured === "male" ? "male" : "female";
  const [pending, setPending] = useState<{
    patientId: number | null;
    value: HeloVoicePreference;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartPrompt, setRestartPrompt] = useState(false);
  const selected = pending && pending.patientId === patientId ? pending.value : current;
  const hasPersistentSession =
    isHeloPersistentAssistantEnabled(settings) &&
    activeSessionPatientId === patientId &&
    sessionStatus !== "disconnected";

  const choose = async (next: HeloVoicePreference) => {
    if (saving || configured === next) return;
    setPending({ patientId, value: next });
    setSaving(true);
    setNotice(null);
    const ok = await saveSettings({ [PATIENT_SETTING_KEYS.heloVoicePreference]: next });
    setSaving(false);
    if (ok) {
      if (hasPersistentSession) {
        setRestartPrompt(true);
      } else {
        setNotice("Voz salva. Ela será aplicada na próxima conversa.");
      }
    } else {
      setPending(null);
      setNotice("Não foi possível salvar a voz deste paciente.");
    }
  };

  const restartNow = async () => {
    if (patientId == null || restarting) return;
    setNotice(null);
    const result = await restartForVoiceChange(patientId);
    setRestartPrompt(false);
    setNotice(
      result.ok
        ? "A Helo está reconectando com a nova voz."
        : result.error ?? "Não foi possível reiniciar a Helo agora."
    );
  };

  return (
    <section aria-labelledby="helo-voice-title" className="rounded-3xl border border-line bg-card p-6">
      <h2 id="helo-voice-title" className="font-semibold tracking-tight">Voz da Helo para este paciente</h2>
      <p className="text-sm text-ink-soft">
        Esta escolha pertence a {patient?.name ?? "este paciente"}. Outros usuários autorizados usarão a mesma voz na próxima conversa com a Helo.
      </p>
      <div role="radiogroup" aria-label="Voz do Agent Helo" className="mt-4 grid gap-3 sm:grid-cols-2">
        {OPTIONS.map((option) => {
          const isSelected = selected === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={saving || restarting}
              onClick={() => void choose(option.value)}
              className={`rounded-2xl border p-4 text-left transition-colors disabled:opacity-60 ${
                isSelected ? "border-accent ring-2 ring-accent" : "border-line hover:border-ink-mute"
              }`}
            >
              <span className="flex items-center justify-between gap-3 font-medium">
                {option.label}
                <span aria-hidden="true" className={`flex size-5 items-center justify-center rounded-full border text-xs ${isSelected ? "border-accent bg-accent text-on-accent" : "border-line text-transparent"}`}>✓</span>
              </span>
              <span className="mt-1 block text-sm text-ink-soft">{option.description}</span>
            </button>
          );
        })}
      </div>
      {restartPrompt && (
        <section role="dialog" aria-modal="false" aria-labelledby="restart-voice-title" className="mt-4 rounded-2xl border border-line bg-cream p-4">
          <h3 id="restart-voice-title" className="font-medium">Reiniciar Helo para aplicar a nova voz?</h3>
          <p className="mt-1 text-sm text-ink-soft">A voz escolhida será usada após reiniciar a sessão atual da Helo.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => void restartNow()} disabled={restarting} className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-60">
              {restarting ? "Reconectando Helo..." : "Reiniciar agora"}
            </button>
            <button type="button" onClick={() => { setRestartPrompt(false); setNotice("A nova voz será usada na próxima conversa da Helo."); }} disabled={restarting} className="rounded-full border border-line bg-card px-4 py-2 text-sm font-medium text-ink disabled:opacity-60">
              Aplicar na próxima conversa
            </button>
          </div>
        </section>
      )}
      {notice && <p role="status" className="mt-3 text-sm text-ink-soft">{notice}</p>}
    </section>
  );
}
