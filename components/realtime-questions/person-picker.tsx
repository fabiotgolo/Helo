"use client";

// ——— Seletor de interlocutor (Fase 4.8, §2) ———
// Escolher com quem o paciente vai conversar: uma pessoa já cadastrada na rede
// dele, ou um nome/função digitado só para esta conversa.
//
// A regra que dá forma a este componente: informar um nome à mão **não cria
// contato**. A rede de pessoas do paciente é gerida em Ajustes, e uma conversa
// não é lugar de cadastrar ninguém pelas costas do cuidador. Por isso não há
// nenhum POST aqui — só leitura.
//
// A rota /api/people não filtra: devolve a lista inteira do paciente. O filtro
// é local, e é o suficiente — uma rede de pessoas é curta por natureza.

import { useEffect, useMemo, useState } from "react";
import type { Person } from "@/lib/store";

export interface InterlocutorValue {
  personId: number | null;
  name: string;
  relation: string;
}

export const EMPTY_INTERLOCUTOR: InterlocutorValue = {
  personId: null,
  name: "",
  relation: "",
};

export function PersonPicker({
  patientId,
  value,
  onChange,
  disabled,
}: {
  patientId: number;
  value: InterlocutorValue;
  onChange: (v: InterlocutorValue) => void;
  disabled?: boolean;
}) {
  // A lista guarda de QUAL paciente ela é: assim "carregando" é derivado, e o
  // efeito não precisa chamar setState de forma síncrona só para ligar o
  // indicador — trocar de paciente já mostra o carregamento sozinho.
  const [carregado, setCarregado] = useState<{
    forPatient: number | null;
    people: Person[];
  }>({ forPatient: null, people: [] });
  const [busca, setBusca] = useState("");
  const carregando = carregado.forPatient !== patientId;
  const people = useMemo(
    () => (carregando ? [] : carregado.people),
    [carregando, carregado.people]
  );

  useEffect(() => {
    let vivo = true;
    fetch(`/api/people?patientId=${patientId}`)
      .then((r) => (r.ok ? r.json() : { people: [] }))
      .then((d: { people?: Person[] }) => {
        if (vivo) setCarregado({ forPatient: patientId, people: d.people ?? [] });
      })
      // A rede de pessoas é um conforto, não um requisito: se falhar, o
      // cuidador ainda escreve o nome à mão e a conversa começa.
      .catch(() => {
        if (vivo) setCarregado({ forPatient: patientId, people: [] });
      });
    return () => {
      vivo = false;
    };
  }, [patientId]);

  const filtradas = useMemo(() => {
    const alvo = busca.trim().toLowerCase();
    if (!alvo) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(alvo) ||
        (p.relation ?? "").toLowerCase().includes(alvo)
    );
  }, [people, busca]);

  const livre = value.personId == null;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium text-ink">
        Com quem o paciente vai conversar?
      </legend>

      {people.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-soft">Buscar na rede do paciente</span>
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            disabled={disabled}
            placeholder="nome ou relação"
            className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
          />
        </label>
      )}

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Interlocutor">
        {carregando && <p className="text-sm text-ink-soft">Carregando a rede…</p>}

        {filtradas.map((p) => (
          <label
            key={p.id}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2"
          >
            <input
              type="radio"
              name="interlocutor"
              checked={value.personId === p.id}
              disabled={disabled}
              onChange={() =>
                onChange({
                  personId: p.id,
                  name: p.name,
                  relation: p.relation ?? "",
                })
              }
            />
            <span className="text-ink">
              {p.name}
              {p.relation && (
                <span className="text-ink-soft"> · {p.relation}</span>
              )}
            </span>
          </label>
        ))}

        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2">
          <input
            type="radio"
            name="interlocutor"
            checked={livre}
            disabled={disabled}
            onChange={() => onChange({ ...EMPTY_INTERLOCUTOR })}
          />
          <span className="text-ink">Outra pessoa (não cadastrada)</span>
        </label>
      </div>

      {livre && (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-bg/40 px-3 py-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-soft">Nome ou função</span>
            <input
              type="text"
              value={value.name}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, personId: null, name: e.target.value })}
              placeholder="médica, esposa, fisioterapeuta…"
              className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-soft">Relação com o paciente</span>
            <input
              type="text"
              value={value.relation}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, personId: null, relation: e.target.value })}
              className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
            />
          </label>
          <p className="text-xs text-ink-soft">
            Não cria um contato novo — fica registrado só nesta conversa.
          </p>
        </div>
      )}
    </fieldset>
  );
}
