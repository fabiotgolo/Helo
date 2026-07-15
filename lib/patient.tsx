"use client";

// ——— Paciente ativo: cada paciente tem sua própria Helo ———
// Este provider é a fonte única do paciente ativo no cliente. Tudo que é
// personalizado (frases, gestos, voz, pessoas, preferências) é lido e
// gravado sob o patientId dele — trocar de paciente troca a experiência
// inteira, sem vazar nada de um para o outro.
//
// Disponibilidade: o paciente ativo, as configurações e os itens de cada
// modo ficam espelhados em localStorage. Rotina e Emergência abrem e falam
// mesmo sem rede/IA — a personalização não quebra essa regra do produto.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HeloItemMode, ModeItem, Patient } from "@/lib/types";
import { clearLocalMirrors, redirectToLogin } from "@/lib/use-auth";

export const ACTIVE_PATIENT_KEY = "helo.patientId";
const PATIENTS_CACHE_KEY = "helo.patients";
const settingsCacheKey = (pid: number) => `helo.settings.${pid}`;
const itemsCacheKey = (pid: number, mode: HeloItemMode) =>
  `helo.items.${pid}.${mode}`;

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* armazenamento cheio/indisponível — o app segue com o estado em memória */
  }
}

interface PatientContextValue {
  /** Lista de pacientes ativos (vazia enquanto carrega). */
  patients: Patient[];
  /** Paciente ativo — null só enquanto carrega ou sem nenhum cadastro. */
  patient: Patient | null;
  patientId: number | null;
  loading: boolean;
  selectPatient: (id: number) => void;
  addPatient: (name: string) => Promise<Patient | null>;
  renamePatient: (id: number, name: string) => Promise<boolean>;
  /** Configurações do paciente ativo (nome, voz, gestos, estilo…). */
  settings: Record<string, string>;
  saveSettings: (updates: Record<string, string>) => Promise<boolean>;
  reloadPatients: () => Promise<void>;
}

const PatientContext = createContext<PatientContextValue | null>(null);

export function PatientProvider({ children }: { children: ReactNode }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState<number | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const patientIdRef = useRef<number | null>(null);
  useEffect(() => {
    patientIdRef.current = patientId;
  }, [patientId]);

  const applyPatients = useCallback((list: Patient[]) => {
    setPatients(list);
    writeCache(PATIENTS_CACHE_KEY, list);
    const stored = Number(localStorage.getItem(ACTIVE_PATIENT_KEY));
    setPatientId((current) => {
      const want = current ?? (stored || null);
      const found = list.find((p) => p.id === want) ?? list[0] ?? null;
      return found?.id ?? null;
    });
  }, []);

  const reloadPatients = useCallback(async () => {
    try {
      const r = await fetch("/api/patients");
      if (r.status === 401) {
        // Sem sessão: nada de cache — os pacientes visíveis dependem do
        // usuário autenticado. Os espelhos locais também caem aqui (sessão
        // expirada sem logout explícito não pode deixar dados para trás).
        // Vai para o login (exceto se já está nele).
        setPatients([]);
        clearLocalMirrors();
        redirectToLogin();
        return;
      }
      if (!r.ok) throw new Error();
      const d = (await r.json()) as { patients: Patient[] };
      applyPatients(d.patients);
    } catch {
      // Sem rede: o último paciente conhecido continua valendo.
      const cached = readCache<Patient[]>(PATIENTS_CACHE_KEY);
      if (cached) applyPatients(cached);
    } finally {
      setLoading(false);
    }
  }, [applyPatients]);

  useEffect(() => {
    void reloadPatients();
    // A lista de pacientes visíveis muda fora deste app (Admin cria/exclui
    // pacientes e vínculos): ao voltar o foco para a janela, revalida — o
    // mesmo padrão do Dashboard Geral. Sem isso, um card recém-visível
    // levava a "paciente não encontrado" porque esta lista continuava a da
    // carga inicial. Dedupe de 5s evita rajadas em trocas rápidas de foco.
    let lastLoad = Date.now();
    const reload = () => {
      if (Date.now() - lastLoad < 5000) return;
      lastLoad = Date.now();
      void reloadPatients();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    // Botão voltar após logout: o navegador pode restaurar a página inteira
    // do bfcache, com o estado React (e dados de pacientes) intacto. Aqui a
    // restauração SEMPRE revalida no servidor — sem sessão, /api/patients
    // responde 401 e o usuário volta ao login, sem dados expostos. Sem o
    // dedupe de 5s: a restauração pode acontecer logo após o logout.
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      lastLoad = Date.now();
      void reloadPatients();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [reloadPatients]);

  // Persistência do paciente ativo + carga das configurações dele.
  useEffect(() => {
    if (patientId == null) return;
    localStorage.setItem(ACTIVE_PATIENT_KEY, String(patientId));
    const cached = readCache<Record<string, string>>(settingsCacheKey(patientId));
    setSettings(cached ?? {});
    void fetch(`/api/settings?patientId=${patientId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((s: Record<string, string>) => {
        // Troca rápida de paciente: só aplica se ele ainda é o ativo.
        if (patientIdRef.current !== patientId) return;
        setSettings(s);
        writeCache(settingsCacheKey(patientId), s);
      })
      .catch(() => {});
  }, [patientId]);

  const selectPatient = useCallback((id: number) => {
    setPatientId(id);
  }, []);

  const addPatient = useCallback(
    async (name: string): Promise<Patient | null> => {
      try {
        const r = await fetch("/api/patients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) return null;
        const d = (await r.json()) as { patient: Patient };
        setPatients((list) => {
          const next = [...list, d.patient];
          writeCache(PATIENTS_CACHE_KEY, next);
          return next;
        });
        return d.patient;
      } catch {
        return null;
      }
    },
    []
  );

  const renamePatient = useCallback(
    async (id: number, name: string): Promise<boolean> => {
      try {
        const r = await fetch("/api/patients", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, name }),
        });
        if (!r.ok) return false;
        setPatients((list) => {
          const next = list.map((p) => (p.id === id ? { ...p, name } : p));
          writeCache(PATIENTS_CACHE_KEY, next);
          return next;
        });
        if (patientIdRef.current === id) {
          setSettings((s) => ({ ...s, patient_name: name }));
        }
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const saveSettings = useCallback(
    async (updates: Record<string, string>): Promise<boolean> => {
      const pid = patientIdRef.current;
      if (pid == null) return false;
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId: pid, ...updates }),
        });
        if (!r.ok) return false;
        setSettings((s) => {
          const next = { ...s, ...updates };
          writeCache(settingsCacheKey(pid), next);
          return next;
        });
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const patient = patients.find((p) => p.id === patientId) ?? null;

  return (
    <PatientContext.Provider
      value={{
        patients,
        patient,
        patientId,
        loading,
        selectPatient,
        addPatient,
        renamePatient,
        settings,
        saveSettings,
        reloadPatients,
      }}
    >
      {children}
    </PatientContext.Provider>
  );
}

export function usePatient(): PatientContextValue {
  const ctx = useContext(PatientContext);
  if (!ctx) throw new Error("usePatient precisa estar dentro de <PatientProvider>");
  return ctx;
}

// ——— Itens de modo do paciente ativo, com espelho offline ———
// Carrega primeiro do cache local (Rotina/Emergência nunca esperam a rede)
// e atualiza com o servidor quando disponível.
export function usePatientItems(mode: HeloItemMode): {
  items: ModeItem[];
  /** Só os ativos, na ordem — o que as telas de uso exibem. */
  enabledItems: ModeItem[];
  loading: boolean;
  /**
   * O usuário pode editar os itens deste modo (permissão do vínculo,
   * derivada no servidor). Decide só a EXIBIÇÃO da ação contextual
   * "Editar" nas telas de uso — a autorização real é das rotas. Começa
   * false e só vira true com resposta do servidor (offline não exibe).
   */
  canEdit: boolean;
  reload: () => Promise<void>;
} {
  const { patientId } = usePatient();
  const [items, setItems] = useState<ModeItem[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (patientId == null) return;
    try {
      const r = await fetch(`/api/items?patientId=${patientId}&mode=${mode}`);
      if (!r.ok) throw new Error();
      const d = (await r.json()) as {
        items: ModeItem[];
        caps?: { edit: boolean };
      };
      setItems(d.items);
      setCanEdit(Boolean(d.caps?.edit));
      writeCache(itemsCacheKey(patientId, mode), d.items);
    } catch {
      /* offline — o cache já exibido continua valendo */
    } finally {
      setLoading(false);
    }
  }, [patientId, mode]);

  useEffect(() => {
    if (patientId == null) return;
    const cached = readCache<ModeItem[]>(itemsCacheKey(patientId, mode));
    setItems(cached ?? []);
    setCanEdit(false);
    setLoading(!cached);
    void reload();
  }, [patientId, mode, reload]);

  return {
    items,
    enabledItems: items.filter((i) => i.enabled),
    loading,
    canEdit,
    reload,
  };
}
