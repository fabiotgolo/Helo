"use client";

// ——— Dashboard Administrativo — exclusivo do papel admin ———
// Gestão global: contas de usuário, pacientes, vínculos usuário↔paciente
// com permissões granulares, e auditoria. A checagem de papel acontece no
// SERVIDOR (toda rota /api/admin/* exige admin); esta tela só reflete.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { Avatar } from "@/components/dashboard-ui";
import AdminFeedbackTab from "@/components/admin-feedback-tab";
import { useAuthUser, redirectToLogin } from "@/lib/use-auth";
import { usePatient } from "@/lib/patient";
import type {
  AccessLink,
  AppUser,
  AuditEvent,
  Permission,
  ProfessionalType,
  UserRole,
} from "@/lib/access-types";
import {
  PERMISSIONS,
  PERMISSION_LABELS,
  PROFESSIONAL_TYPE_LABELS,
  ROLE_LABELS,
  defaultPermissionsFor,
} from "@/lib/access-types";
import type { Patient } from "@/lib/types";

type UserWithLinks = AppUser & { links: AccessLink[] };
type Tab = "usuarios" | "pacientes" | "acessos" | "vozes" | "feedback" | "auditoria";

const TABS: { id: Tab; label: string }[] = [
  { id: "usuarios", label: "Usuários" },
  { id: "pacientes", label: "Pacientes" },
  { id: "acessos", label: "Acessos" },
  { id: "vozes", label: "Vozes" },
  { id: "feedback", label: "Feedback" },
  { id: "auditoria", label: "Auditoria" },
];

// ——— Vozes (catálogo controlado) ———
// Só o Admin vê e gerencia estes dados: o catálogo interno de vozes da
// plataforma (cadastradas por ElevenLabs voiceId) e a voz clonada de cada
// paciente. Usuários comuns nunca recebem voiceIds — só nomes amigáveis.
type PlatformVoiceAdmin = {
  id: string;
  elevenLabsVoiceId: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  isDefault: boolean;
};
type VoiceUsage = { userIds: string[]; patientIds: number[] };
type PatientVoiceAdmin = {
  patientId: number;
  name: string;
  hasClone: boolean;
  cloneName: string | null;
  cloneIdMasked: string | null;
  source: "clone" | "platform";
  platformVoiceId: string | null;
};
type VoicesAdminData = {
  voices: PlatformVoiceAdmin[];
  usage: Record<string, VoiceUsage>;
  patientVoices: PatientVoiceAdmin[];
};

const input =
  "min-h-11 rounded-2xl border border-line bg-card px-4 py-2.5 outline-none focus:border-ink-mute";
const btnDark =
  "min-h-11 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40";
const btnLight =
  "min-h-10 rounded-full border border-line bg-card px-4 py-2 text-sm font-medium hover:border-ink-mute disabled:opacity-40";
const btnDanger =
  "min-h-10 rounded-full bg-nao-soft px-4 py-2 text-sm font-medium text-nao hover:opacity-80 disabled:opacity-40";

// Confirmação inline no lugar de window.confirm/prompt: diálogos nativos
// bloqueantes não existem em webviews e no browser de preview — e a versão
// inline é acessível e testável. `requireText` cobre a confirmação reforçada
// (digitar o nome exato) da exclusão definitiva.
function ConfirmBox({
  lines,
  requireText,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  lines: string[];
  requireText?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = !requireText || typed.trim() === requireText;
  return (
    <div
      role="alertdialog"
      aria-label={confirmLabel}
      className="flex w-full flex-col gap-3 rounded-2xl border border-nao/30 bg-nao-soft p-4"
    >
      {lines.map((l) => (
        <p key={l} className="text-sm">{l}</p>
      ))}
      {requireText && (
        <input
          className={`${input} w-full`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={requireText}
          aria-label={`Confirmação reforçada: digite ${requireText}`}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="min-h-10 rounded-full bg-nao px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          disabled={!ready}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className={btnLight} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

async function api(
  url: string,
  method: string,
  body?: unknown
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: d.error ?? `erro ${r.status}` };
  } catch {
    return { ok: false, error: "falha de conexão" };
  }
}

export default function AdminPage() {
  const { user: me, loading: meLoading } = useAuthUser();
  const { reloadPatients } = usePatient();

  const [tab, setTab] = useState<Tab>("usuarios");
  const [users, setUsers] = useState<UserWithLinks[] | null>(null);
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [links, setLinks] = useState<AccessLink[] | null>(null);
  const [voicesAdmin, setVoicesAdmin] = useState<VoicesAdminData | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [uR, pR, lR, aR, vR] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/patients"),
        fetch("/api/admin/access"),
        fetch("/api/admin/audit"),
        fetch("/api/admin/voices"),
      ]);
      if (uR.status === 401) {
        redirectToLogin();
        return;
      }
      if (uR.status === 403) return; // tela de negado abaixo (via papel)
      if (!uR.ok || !pR.ok || !lR.ok || !aR.ok) throw new Error();
      setUsers(((await uR.json()) as { users: UserWithLinks[] }).users);
      setPatients(((await pR.json()) as { patients: Patient[] }).patients);
      setLinks(((await lR.json()) as { links: AccessLink[] }).links);
      setAudit(((await aR.json()) as { events: AuditEvent[] }).events);
      setVoicesAdmin(vR.ok ? ((await vR.json()) as VoicesAdminData) : null);
    } catch {
      setError("Não foi possível carregar os dados administrativos.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const run = useCallback(
    async (p: Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
      const r = await p;
      if (r.ok) {
        flash(okMsg);
        await load();
        await reloadPatients();
      } else {
        setError(r.error ?? "operação falhou");
        window.setTimeout(() => setError(null), 6000);
      }
      return r.ok;
    },
    [flash, load, reloadPatients]
  );

  const userById = useMemo(
    () => new Map((users ?? []).map((u) => [u.id, u])),
    [users]
  );
  const patientById = useMemo(
    () => new Map((patients ?? []).map((p) => [p.id, p])),
    [patients]
  );

  // ——— Guarda de papel (o servidor já nega; aqui é só a mensagem) ———
  if (!meLoading && me && me.role !== "admin") {
    return (
      <div className="flex min-h-dvh flex-col pb-24 sm:pb-0">
        <TopBar right={<PillLink href="/dashboard">← Pacientes</PillLink>} />
        <main role="alert" className="mx-auto flex max-w-xl flex-1 flex-col items-center justify-center gap-3 px-6 pl-14 text-center sm:pl-20 xl:pl-6">
          <p className="text-2xl font-medium">Acesso negado.</p>
          <p className="text-ink-soft">O Dashboard Administrativo é exclusivo do administrador.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col pb-24 sm:pb-0">
      <TopBar
        right={
          <>
            <PillLink href="/dashboard">Pacientes</PillLink>
            <PillLink href="/">Início</PillLink>
          </>
        }
      />
      {/* pl-14 no mobile: deixa livre o vão da coluna de temas (bolinhas
          ocupam x≈20–48px sob a marca). Desktop volta ao px original. */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        <div>
          <h1 className="text-3xl font-medium tracking-tight">Administração</h1>
          <p className="mt-1 text-ink-soft">
            Contas, pacientes, vínculos e permissões — quem acessa o quê.
          </p>
        </div>

        <div role="tablist" aria-label="Seções" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-card p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id ? "bg-accent text-on-accent" : "text-ink-soft hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {notice && (
          <p role="status" className="rounded-2xl bg-sim-soft px-4 py-3 text-sm text-sim">{notice}</p>
        )}
        {error && (
          <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">{error}</p>
        )}

        {users === null || patients === null || links === null ? (
          <p className="py-16 text-center text-ink-soft">Carregando…</p>
        ) : tab === "usuarios" ? (
          <UsersTab users={users} meId={me?.id ?? ""} run={run} />
        ) : tab === "pacientes" ? (
          <PatientsTab patients={patients} links={links} userById={userById} run={run} />
        ) : tab === "acessos" ? (
          <AccessTab users={users} patients={patients} links={links} userById={userById} patientById={patientById} run={run} />
        ) : tab === "vozes" ? (
          <VoicesTab data={voicesAdmin} run={run} />
        ) : tab === "feedback" ? (
          <AdminFeedbackTab />
        ) : (
          <AuditTab audit={audit ?? []} />
        )}
      </main>
    </div>
  );
}

// ============================== Usuários ==============================

function UsersTab({
  users,
  meId,
  run,
}: {
  users: UserWithLinks[];
  meId: string;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("cuidador");
  const [profType, setProfType] = useState<ProfessionalType>("enfermeiro");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const ok = await run(
      api("/api/admin/users", "POST", {
        name,
        email,
        password,
        role,
        professionalType: role === "profissional" ? profType : null,
      }),
      `Usuário ${name} criado.`
    );
    setBusy(false);
    if (ok) {
      setName("");
      setEmail("");
      setPassword("");
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        aria-label="Criar usuário"
        className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-5"
      >
        <h2 className="text-lg font-semibold">Criar usuário</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input className={input} placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className={input} type="password" placeholder="Senha (mín. 8)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoComplete="new-password" />
          <div className="flex gap-2">
            <select className={`${input} flex-1`} value={role} onChange={(e) => setRole(e.target.value as UserRole)} aria-label="Papel">
              {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            {role === "profissional" && (
              <select className={`${input} flex-1`} value={profType} onChange={(e) => setProfType(e.target.value as ProfessionalType)} aria-label="Especialidade">
                {(Object.keys(PROFESSIONAL_TYPE_LABELS) as ProfessionalType[]).map((t) => (
                  <option key={t} value={t}>{PROFESSIONAL_TYPE_LABELS[t]}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        <button type="submit" disabled={busy} className={`${btnDark} self-start`}>
          {busy ? "Criando…" : "+ Criar usuário"}
        </button>
      </form>

      {users.length === 0 ? (
        <p className="rounded-3xl border border-line bg-card p-10 text-center">Nenhum usuário cadastrado.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {users.map((u) => (
            <UserRow key={u.id} u={u} isMe={u.id === meId} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UserRow({
  u,
  isMe,
  run,
}: {
  u: UserWithLinks;
  isMe: boolean;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(u.name);
  const [role, setRole] = useState<UserRole>(u.role);

  const remove = async () => {
    setConfirming(false);
    await run(api("/api/admin/users", "DELETE", { id: u.id }), `Usuário ${u.name} excluído.`);
  };

  return (
    <li className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={u.name} />
        <div className="min-w-0">
          <p className="truncate font-semibold">
            {u.name} {isMe && <span className="text-xs font-normal text-ink-soft">(você)</span>}
          </p>
          <p className="truncate text-sm text-ink-soft">
            {u.email} · {ROLE_LABELS[u.role]}
            {u.professionalType ? ` · ${PROFESSIONAL_TYPE_LABELS[u.professionalType]}` : ""}
            {" · "}
            {u.links.length} paciente(s)
          </p>
        </div>
        <span
          className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
            u.status === "active" ? "bg-sim-soft text-sim" : "bg-cream text-ink-soft"
          }`}
        >
          {u.status === "active" ? "ativo" : "desativado"}
        </span>
      </div>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              api("/api/admin/users", "PATCH", { id: u.id, name, role }),
              "Usuário atualizado."
            ).then((ok) => ok && setEditing(false));
          }}
        >
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome" />
          <select className={input} value={role} onChange={(e) => setRole(e.target.value as UserRole)} aria-label="Papel" disabled={isMe}>
            {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
          <button type="submit" className={btnLight}>Salvar</button>
          <button type="button" className={btnLight} onClick={() => setEditing(false)}>Cancelar</button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnLight} onClick={() => setEditing(true)}>Editar</button>
          {!isMe && (
            <>
              <button
                type="button"
                className={btnLight}
                onClick={() =>
                  void run(
                    api("/api/admin/users", "PATCH", {
                      id: u.id,
                      status: u.status === "active" ? "inactive" : "active",
                    }),
                    u.status === "active" ? `${u.name} desativado.` : `${u.name} reativado.`
                  )
                }
              >
                {u.status === "active" ? "Desativar" : "Reativar"}
              </button>
              <button type="button" className={btnDanger} onClick={() => setConfirming(true)}>
                Excluir
              </button>
            </>
          )}
        </div>
      )}
      </div>
      {confirming && (
        <ConfirmBox
          lines={[
            `Excluir a conta de ${u.name}?`,
            `${u.links.length} vínculo(s) com paciente(s) serão removidos.`,
            "Os pacientes e seus dados NÃO serão apagados.",
            "As sessões de login serão invalidadas.",
            "Esta ação não pode ser desfeita.",
            `Para confirmar, digite o nome do usuário: ${u.name}`,
          ]}
          requireText={u.name}
          confirmLabel="Excluir usuário"
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

// ============================== Pacientes ==============================

function PatientsTab({
  patients,
  links,
  userById,
  run,
}: {
  patients: Patient[];
  links: AccessLink[];
  userById: Map<string, UserWithLinks>;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const ok = await run(api("/api/patients", "POST", { name }), `Paciente ${name} criado.`);
    setBusy(false);
    if (ok) setName("");
  };

  return (
    <section className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        aria-label="Criar paciente"
        className="flex flex-col gap-2 rounded-3xl border border-line bg-card p-5 sm:flex-row sm:items-center"
      >
        <input className={`${input} flex-1`} placeholder="Nome do novo paciente" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit" disabled={busy || !name.trim()} className={btnDark}>
          {busy ? "Criando…" : "+ Criar paciente"}
        </button>
      </form>

      {patients.length === 0 ? (
        <p className="rounded-3xl border border-line bg-card p-10 text-center">Nenhum paciente cadastrado.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {patients.map((p) => {
            const authorized = links.filter((l) => l.patientId === p.id);
            return (
              <PatientRow key={p.id} p={p} authorized={authorized} userById={userById} run={run} />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PatientRow({
  p,
  authorized,
  userById,
  run,
}: {
  p: Patient;
  authorized: AccessLink[];
  userById: Map<string, UserWithLinks>;
  run: (pr: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"soft" | "hard" | null>(null);
  const [name, setName] = useState(p.name);

  const remove = async (hard: boolean) => {
    setConfirming(null);
    await run(
      api("/api/patients", "DELETE", { id: p.id, hard }),
      hard ? `Paciente ${p.name} excluído.` : `Paciente ${p.name} desativado.`
    );
  };

  return (
    <li className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={p.name} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  api("/api/patients", "PATCH", { id: p.id, name }),
                  "Paciente atualizado."
                ).then((ok) => ok && setEditing(false));
              }}
            >
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome do paciente" />
              <button type="submit" className={btnLight}>Salvar</button>
              <button type="button" className={btnLight} onClick={() => setEditing(false)}>Cancelar</button>
            </form>
          ) : (
            <>
              <p className="truncate font-semibold">{p.name}</p>
              <p className="text-sm text-ink-soft">
                {authorized.length === 0
                  ? "nenhum usuário vinculado"
                  : `acesso de: ${authorized
                      .map((l) => userById.get(l.userId)?.name ?? "?")
                      .join(", ")}`}
              </p>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/dashboard/${p.id}`} className={btnLight}>Dashboard</a>
            <button type="button" className={btnLight} onClick={() => setEditing(true)}>Renomear</button>
            <button type="button" className={btnLight} onClick={() => setConfirming("soft")}>Desativar</button>
            <button type="button" className={btnDanger} onClick={() => setConfirming("hard")}>Excluir</button>
          </div>
        )}
      </div>
      {confirming === "soft" && (
        <ConfirmBox
          lines={[
            `Desativar o paciente ${p.name}?`,
            `${authorized.length} usuário(s) possuem acesso a este paciente.`,
            "Os dados são preservados e o paciente pode ser reativado.",
          ]}
          confirmLabel="Desativar paciente"
          onConfirm={() => void remove(false)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "hard" && (
        <ConfirmBox
          lines={[
            `EXCLUIR DEFINITIVAMENTE o paciente ${p.name}?`,
            `${authorized.length} usuário(s) possuem acesso a este paciente.`,
            "Perfil, Rotinas, Emergências, gestos, configurações de voz e vínculos serão APAGADOS.",
            "Esta ação NÃO pode ser desfeita.",
            `Para confirmar, digite o nome do paciente: ${p.name}`,
          ]}
          requireText={p.name}
          confirmLabel="Excluir definitivamente"
          onConfirm={() => void remove(true)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </li>
  );
}

// ============================== Acessos ==============================

function AccessTab({
  users,
  patients,
  links,
  userById,
  patientById,
  run,
}: {
  users: UserWithLinks[];
  patients: Patient[];
  links: AccessLink[];
  userById: Map<string, UserWithLinks>;
  patientById: Map<number, Patient>;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [userId, setUserId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [perms, setPerms] = useState<Permission[]>([]);
  const [view, setView] = useState<"porUsuario" | "porPaciente">("porUsuario");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const u = userById.get(userId);
    if (u) setPerms(defaultPermissionsFor(u.role));
  }, [userId, userById]);

  const grant = async () => {
    setBusy(true);
    const ok = await run(
      api("/api/admin/access", "POST", {
        userId,
        patientId: Number(patientId),
        permissions: perms,
      }),
      "Vínculo criado — o paciente já aparece no Dashboard Geral do usuário."
    );
    setBusy(false);
    if (ok) {
      setUserId("");
      setPatientId("");
    }
  };

  const togglePerm = (p: Permission) =>
    setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <section className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void grant();
        }}
        aria-label="Criar vínculo"
        className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-5"
      >
        <h2 className="text-lg font-semibold">Vincular usuário a paciente</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select className={input} value={userId} onChange={(e) => setUserId(e.target.value)} required aria-label="Usuário">
            <option value="">Usuário…</option>
            {users
              .filter((u) => u.status === "active")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {ROLE_LABELS[u.role]}
                </option>
              ))}
          </select>
          <select className={input} value={patientId} onChange={(e) => setPatientId(e.target.value)} required aria-label="Paciente">
            <option value="">Paciente…</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {userId && (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-sm text-ink-soft">Permissões deste vínculo</legend>
            {PERMISSIONS.map((p) => (
              <label
                key={p}
                className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm ${
                  perms.includes(p)
                    ? "border-accent bg-accent text-on-accent"
                    : "border-line bg-card text-ink-soft"
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={perms.includes(p)}
                  onChange={() => togglePerm(p)}
                />
                {PERMISSION_LABELS[p]}
              </label>
            ))}
          </fieldset>
        )}
        <button type="submit" disabled={busy || !userId || !patientId} className={`${btnDark} self-start`}>
          {busy ? "Salvando…" : "Criar vínculo"}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2
            className="text-lg font-semibold"
            title="Você pode visualizar os mesmos vínculos agrupados por usuário ou por paciente."
          >
            Matriz de acesso
          </h2>
          <p className="text-sm text-ink-soft">
            {view === "porUsuario"
              ? "Veja todos os pacientes vinculados a cada usuário."
              : "Veja todos os usuários autorizados para cada paciente."}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1 rounded-full border border-line bg-card p-1">
          {(
            [
              ["porUsuario", "Ver por usuário"],
              ["porPaciente", "Ver por paciente"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={`min-h-11 rounded-full px-3 py-1.5 text-sm font-medium ${
                view === id ? "bg-accent text-on-accent" : "text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {links.length === 0 ? (
        <p className="rounded-3xl border border-line bg-card p-10 text-center text-ink-soft">
          {view === "porUsuario"
            ? "Nenhum vínculo criado ainda. Quando um usuário for vinculado a um paciente, ele aparecerá aqui com os pacientes que pode acessar."
            : "Nenhum vínculo criado ainda. Quando um paciente receber usuários autorizados, eles aparecerão aqui."}
        </p>
      ) : view === "porUsuario" ? (
        <ul className="flex flex-col gap-3">
          {users
            .filter((u) => links.some((l) => l.userId === u.id))
            .map((u) => (
              <li key={u.id} className="rounded-3xl border border-line bg-card p-4">
                <p className="font-semibold">
                  {u.name} <span className="text-sm font-normal text-ink-soft">— {ROLE_LABELS[u.role]}</span>
                </p>
                <p className="mt-1 text-xs text-ink-soft">Pacientes que este usuário pode acessar</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {links
                    .filter((l) => l.userId === u.id)
                    .map((l) => (
                      <LinkRow key={l.id} link={l} title={patientById.get(l.patientId)?.name ?? `Paciente ${l.patientId}`} run={run} />
                    ))}
                </ul>
              </li>
            ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-3">
          {patients
            .filter((p) => links.some((l) => l.patientId === p.id))
            .map((p) => (
              <li key={p.id} className="rounded-3xl border border-line bg-card p-4">
                <p className="font-semibold">{p.name}</p>
                <p className="mt-1 text-xs text-ink-soft">Usuários autorizados para este paciente</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {links
                    .filter((l) => l.patientId === p.id)
                    .map((l) => {
                      const u = userById.get(l.userId);
                      return (
                        <LinkRow
                          key={l.id}
                          link={l}
                          title={u ? `${u.name} — ${ROLE_LABELS[u.role]}` : l.userId}
                          run={run}
                        />
                      );
                    })}
                </ul>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function LinkRow({
  link,
  title,
  run,
}: {
  link: AccessLink;
  title: string;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [perms, setPerms] = useState<Permission[]>(link.permissions);

  return (
    <li className="rounded-2xl bg-cream px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {!editing && (
          <span className="text-xs text-ink-soft">
            {link.permissions.length} permissão(ões)
          </span>
        )}
        <button type="button" className={btnLight} onClick={() => setEditing((v) => !v)}>
          {editing ? "Fechar" : "Permissões"}
        </button>
        <button type="button" className={btnDanger} onClick={() => setConfirming(true)}>
          Revogar
        </button>
      </div>
      {confirming && (
        <div className="mt-3">
          <ConfirmBox
            lines={[
              "Remover este vínculo?",
              "O usuário perde o acesso a este paciente imediatamente.",
              "Os dados do paciente NÃO são apagados e os demais vínculos continuam valendo.",
            ]}
            confirmLabel="Revogar vínculo"
            onConfirm={() => {
              setConfirming(false);
              void run(api("/api/admin/access", "DELETE", { id: link.id }), "Vínculo removido.");
            }}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}
      {editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {PERMISSIONS.map((p) => (
            <label
              key={p}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs ${
                perms.includes(p) ? "border-accent bg-accent text-on-accent" : "border-line bg-card text-ink-soft"
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={perms.includes(p)}
                onChange={() =>
                  setPerms((cur) =>
                    cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]
                  )
                }
              />
              {PERMISSION_LABELS[p]}
            </label>
          ))}
          <button
            type="button"
            className={btnDark}
            onClick={() =>
              void run(
                api("/api/admin/access", "PATCH", { id: link.id, permissions: perms }),
                "Permissões atualizadas."
              ).then((ok) => ok && setEditing(false))
            }
          >
            Salvar permissões
          </button>
        </div>
      )}
    </li>
  );
}

// ============================== Vozes ==============================
// Catálogo da plataforma + voz clonada por paciente + concessão da escolha
// de voz da plataforma por usuário. Toda ação passa pelas rotas de Admin
// (o servidor nega quem não é admin — esta tela só reflete).

function VoicesTab({
  data,
  run,
}: {
  data: VoicesAdminData | null;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
}) {
  const [voiceId, setVoiceId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  // Prévia de áudio: um player único para a aba inteira — iniciar uma
  // prévia interrompe a anterior. O cliente só referencia ids do catálogo
  // ou o clone de um paciente; o voiceId técnico segue no servidor.
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const preview = useCallback(
    async (key: string, payload: Record<string, unknown>, text: string) => {
      setPreviewingId(key);
      try {
        audioRef.current?.pause();
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ...payload }),
        });
        if (!r.ok) return;
        const audio = new Audio(URL.createObjectURL(await r.blob()));
        audioRef.current = audio;
        await audio.play();
      } catch {
        /* prévia é melhor-esforço — a falha não interrompe a gestão */
      } finally {
        setPreviewingId(null);
      }
    },
    []
  );

  if (data === null) {
    return (
      <p className="rounded-3xl border border-line bg-card p-10 text-center">
        Não foi possível carregar o catálogo de vozes.
      </p>
    );
  }

  const add = async () => {
    setBusy(true);
    const ok = await run(
      api("/api/admin/voices", "POST", {
        elevenLabsVoiceId: voiceId,
        displayName,
        description,
        isDefault: makeDefault,
      }),
      `Voz "${displayName}" adicionada ao catálogo.`
    );
    setBusy(false);
    if (ok) {
      setVoiceId("");
      setDisplayName("");
      setDescription("");
      setMakeDefault(false);
    }
  };

  return (
    <section className="flex flex-col gap-6">
      {/* ——— Cadastro no catálogo ——— */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        aria-label="Adicionar voz ao catálogo"
        className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-5"
      >
        <h2 className="text-lg font-semibold">Catálogo de vozes da plataforma</h2>
        <p className="text-sm text-ink-soft">
          Somente as vozes cadastradas aqui (por ElevenLabs Voice ID) ficam
          disponíveis para os usuários — eles veem apenas o nome amigável,
          nunca a biblioteca completa da conta.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input className={input} placeholder="ElevenLabs Voice ID" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} required aria-label="ElevenLabs Voice ID" />
          <input className={input} placeholder="Nome amigável (ex.: Helo Serena)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required aria-label="Nome amigável" />
          <input className={`${input} sm:col-span-2`} placeholder="Descrição (opcional)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Descrição" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          Definir como voz padrão da Helo
        </label>
        <button type="submit" disabled={busy || !voiceId.trim() || !displayName.trim()} className={`${btnDark} self-start`}>
          {busy ? "Validando…" : "+ Adicionar voz"}
        </button>
      </form>

      {/* ——— Lista do catálogo ——— */}
      {data.voices.length === 0 ? (
        <p className="rounded-3xl border border-line bg-card p-10 text-center">
          Nenhuma voz no catálogo ainda. Sem catálogo, o app usa a voz de
          fallback aprovada.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.voices.map((v) => (
            <CatalogVoiceRow
              key={v.id}
              v={v}
              usage={data.usage[v.id]}
              run={run}
              previewing={previewingId === v.id}
              previewBusy={previewingId !== null}
              onPreview={() =>
                void preview(
                  v.id,
                  { previewPlatformVoiceId: v.id },
                  `Olá, eu sou a voz ${v.displayName}. É assim que eu falo na Helo.`
                )
              }
            />
          ))}
        </ul>
      )}

      {/* ——— Voz clonada por paciente ——— */}
      <div className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-5">
        <h2 className="text-lg font-semibold">Voz clonada por paciente</h2>
        <p className="text-sm text-ink-soft">
          A atribuição do clone é exclusiva do administrador e vale só para o
          paciente indicado — o clone de um paciente nunca aparece para outro.
        </p>
        <ul className="flex flex-col gap-2">
          {data.patientVoices.map((p) => (
            <PatientCloneRow
              key={p.patientId}
              p={p}
              run={run}
              previewing={previewingId === `clone-${p.patientId}`}
              previewBusy={previewingId !== null}
              onPreview={() =>
                void preview(
                  `clone-${p.patientId}`,
                  {
                    previewPatientVoice: {
                      patientId: p.patientId,
                      source: "clone",
                    },
                  },
                  `Olá, esta é a voz configurada para as mensagens de ${p.name}.`
                )
              }
            />
          ))}
        </ul>
      </div>

      {/* ——— Escolha da voz da plataforma ——— */}
      <div className="flex flex-col gap-2 rounded-3xl border border-line bg-card p-5">
        <h2 className="text-lg font-semibold">Escolha da voz da plataforma</h2>
        <p className="text-sm text-ink-soft">
          Todo usuário pode escolher, nos Ajustes, entre as vozes ativas deste
          catálogo para a voz da própria interface — a escolha vale só para ele
          e não altera a experiência dos outros. As vozes que aparecem são as
          cadastradas aqui; para tirar uma de circulação, desative-a acima. A
          voz das falas do PACIENTE é uma configuração à parte: para paciente
          sem voz clonada, qualquer usuário vinculado escolhe uma voz do
          catálogo; havendo clone, trocar a fonte exige a permissão “escolher
          a voz das falas do paciente”.
        </p>
      </div>
    </section>
  );
}

function CatalogVoiceRow({
  v,
  usage,
  run,
  previewing,
  previewBusy,
  onPreview,
}: {
  v: PlatformVoiceAdmin;
  usage: VoiceUsage | undefined;
  run: (p: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
  previewing: boolean;
  previewBusy: boolean;
  onPreview: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(v.displayName);
  const [desc, setDesc] = useState(v.description ?? "");
  const inUse = (usage?.userIds.length ?? 0) + (usage?.patientIds.length ?? 0);

  return (
    <li className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {v.displayName}
            {v.isDefault && (
              <span className="ml-2 rounded-full bg-sim-soft px-2 py-0.5 text-xs font-medium text-sim">padrão</span>
            )}
            {!v.enabled && (
              <span className="ml-2 rounded-full bg-talvez-soft px-2 py-0.5 text-xs font-medium text-talvez">desativada</span>
            )}
          </p>
          <p className="truncate text-sm text-ink-soft">
            {v.description ? `${v.description} · ` : ""}
            <code className="text-xs">{v.elevenLabsVoiceId}</code>
            {" · "}
            {inUse === 0
              ? "sem uso"
              : `em uso: ${usage?.userIds.length ?? 0} usuário(s), ${usage?.patientIds.length ?? 0} paciente(s)`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnLight}
            onClick={onPreview}
            disabled={previewBusy}
            aria-label={`Ouvir prévia de ${v.displayName}`}
          >
            {previewing ? "Falando…" : "🔊 Ouvir"}
          </button>
          <button type="button" className={btnLight} onClick={() => setEditing((e) => !e)}>
            {editing ? "Fechar" : "Editar"}
          </button>
          {!v.isDefault && v.enabled && (
            <button
              type="button"
              className={btnLight}
              onClick={() =>
                void run(
                  api("/api/admin/voices", "PATCH", { id: v.id, isDefault: true }),
                  `"${v.displayName}" agora é a voz padrão da Helo.`
                )
              }
            >
              Tornar padrão
            </button>
          )}
          {!v.isDefault && (
            <button
              type="button"
              className={btnLight}
              onClick={() =>
                void run(
                  api("/api/admin/voices", "PATCH", { id: v.id, enabled: !v.enabled }),
                  v.enabled
                    ? `"${v.displayName}" desativada — some dos combos dos usuários.`
                    : `"${v.displayName}" reativada.`
                )
              }
            >
              {v.enabled ? "Desativar" : "Reativar"}
            </button>
          )}
          {!v.isDefault && (
            <button type="button" className={btnDanger} onClick={() => setConfirming(true)}>
              Remover
            </button>
          )}
        </div>
      </div>
      {editing && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              api("/api/admin/voices", "PATCH", { id: v.id, displayName: name, description: desc }),
              "Voz atualizada."
            ).then((ok) => ok && setEditing(false));
          }}
        >
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome amigável" />
          <input className={`${input} flex-1`} value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Descrição" placeholder="Descrição" />
          <button type="submit" className={btnLight}>Salvar</button>
        </form>
      )}
      {confirming && (
        <ConfirmBox
          lines={[
            `Remover "${v.displayName}" do catálogo?`,
            inUse > 0
              ? `Em uso por ${usage?.userIds.length ?? 0} usuário(s) e ${usage?.patientIds.length ?? 0} paciente(s) — quem a usava passa a ouvir a voz padrão da Helo.`
              : "Ela deixa de existir para todos os usuários.",
          ]}
          confirmLabel="Remover do catálogo"
          onConfirm={() => {
            setConfirming(false);
            void run(
              api("/api/admin/voices", "DELETE", { id: v.id }),
              inUse > 0
                ? `"${v.displayName}" removida — ${inUse} preferência(s) voltaram à voz padrão.`
                : "Voz removida do catálogo."
            );
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

function PatientCloneRow({
  p,
  run,
  previewing,
  previewBusy,
  onPreview,
}: {
  p: PatientVoiceAdmin;
  run: (pr: Promise<{ ok: boolean; error?: string }>, m: string) => Promise<boolean>;
  previewing: boolean;
  previewBusy: boolean;
  onPreview: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [cloneId, setCloneId] = useState("");
  const [cloneName, setCloneName] = useState("");

  const submitClone = async () => {
    const ok = await run(
      api("/api/admin/patient-voice", "POST", {
        patientId: p.patientId,
        elevenLabsVoiceId: cloneId,
        displayName: cloneName,
      }),
      `Voz clonada ${p.hasClone ? "substituída" : "atribuída"} para ${p.name}.`
    );
    if (ok) {
      setAssigning(false);
      setConfirmingReplace(false);
      setCloneId("");
      setCloneName("");
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-2xl bg-cream px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {p.name}
          <span className="ml-2 font-normal text-ink-soft">
            {p.hasClone
              ? `${p.cloneName ?? "voz clonada"} · ${p.cloneIdMasked}`
              : "sem voz clonada"}
          </span>
        </span>
        {p.hasClone && (
          <button
            type="button"
            className={btnLight}
            onClick={onPreview}
            disabled={previewBusy}
            aria-label={`Ouvir a voz clonada de ${p.name}`}
          >
            {previewing ? "Falando…" : "🔊 Ouvir"}
          </button>
        )}
        <button type="button" className={btnLight} onClick={() => setAssigning((a) => !a)}>
          {assigning ? "Fechar" : p.hasClone ? "Substituir" : "Atribuir clone"}
        </button>
        {p.hasClone && (
          <button type="button" className={btnDanger} onClick={() => setConfirmingRemove(true)}>
            Remover
          </button>
        )}
      </div>
      {assigning && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            // Substituição afeta a voz que fala EM NOME do paciente —
            // confirmação reforçada mostrando o paciente afetado.
            if (p.hasClone) setConfirmingReplace(true);
            else void submitClone();
          }}
        >
          <input className={`${input} flex-1`} placeholder="ElevenLabs Voice ID do clone" value={cloneId} onChange={(e) => setCloneId(e.target.value)} required aria-label={`Voice ID do clone de ${p.name}`} />
          <input className={`${input} flex-1`} placeholder={`Nome (ex.: Voz clonada de ${p.name})`} value={cloneName} onChange={(e) => setCloneName(e.target.value)} aria-label="Nome de exibição do clone" />
          <button type="submit" disabled={!cloneId.trim()} className={btnDark}>
            Salvar
          </button>
        </form>
      )}
      {confirmingReplace && (
        <ConfirmBox
          lines={[
            `Substituir a voz clonada de ${p.name}?`,
            `Voz atual: ${p.cloneName ?? "voz clonada"} (${p.cloneIdMasked}).`,
            "Todas as falas do paciente passarão a usar o novo clone.",
          ]}
          confirmLabel="Substituir voz clonada"
          onConfirm={() => void submitClone()}
          onCancel={() => setConfirmingReplace(false)}
        />
      )}
      {confirmingRemove && (
        <ConfirmBox
          lines={[
            `Remover a voz clonada de ${p.name}?`,
            "As falas do paciente passam a usar o catálogo aprovado da plataforma.",
          ]}
          confirmLabel="Remover voz clonada"
          onConfirm={() => {
            setConfirmingRemove(false);
            void run(
              api("/api/admin/patient-voice", "DELETE", { patientId: p.patientId }),
              `Voz clonada removida de ${p.name}.`
            );
          }}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </li>
  );
}

// ============================== Auditoria ==============================

function AuditTab({ audit }: { audit: AuditEvent[] }) {
  return audit.length === 0 ? (
    <p className="rounded-3xl border border-line bg-card p-10 text-center">
      Nenhum evento registrado ainda.
    </p>
  ) : (
    <div className="overflow-x-auto rounded-3xl border border-line bg-card p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-ink-soft">
            <th className="py-2 pr-4 font-medium">Quando</th>
            <th className="py-2 pr-4 font-medium">Quem</th>
            <th className="py-2 pr-4 font-medium">Ação</th>
            <th className="py-2 font-medium">Paciente</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((e) => (
            <tr key={e.id} className="border-b border-line/60">
              <td className="whitespace-nowrap py-2 pr-4 text-ink-soft">
                {new Date(e.ts).toLocaleString("pt-BR")}
              </td>
              <td className="py-2 pr-4">{e.userName ?? "—"}</td>
              <td className="py-2 pr-4"><code className="text-xs">{e.action}</code></td>
              <td className="py-2 tabular-nums">{e.patientId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
