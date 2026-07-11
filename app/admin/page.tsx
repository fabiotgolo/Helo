"use client";

// ——— Dashboard Administrativo — exclusivo do papel admin ———
// Gestão global: contas de usuário, pacientes, vínculos usuário↔paciente
// com permissões granulares, e auditoria. A checagem de papel acontece no
// SERVIDOR (toda rota /api/admin/* exige admin); esta tela só reflete.

import { useCallback, useEffect, useMemo, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { Avatar } from "@/components/dashboard-ui";
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
type Tab = "usuarios" | "pacientes" | "acessos" | "auditoria";

const TABS: { id: Tab; label: string }[] = [
  { id: "usuarios", label: "Usuários" },
  { id: "pacientes", label: "Pacientes" },
  { id: "acessos", label: "Acessos" },
  { id: "auditoria", label: "Auditoria" },
];

const input =
  "min-h-11 rounded-2xl border border-line bg-card px-4 py-2.5 outline-none focus:border-ink-mute";
const btnDark =
  "min-h-11 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white hover:bg-black disabled:opacity-40";
const btnLight =
  "min-h-10 rounded-full border border-line bg-card px-4 py-2 text-sm font-medium hover:border-ink-mute disabled:opacity-40";
const btnDanger =
  "min-h-10 rounded-full bg-nao-soft px-4 py-2 text-sm font-medium text-nao hover:opacity-80 disabled:opacity-40";

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
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [uR, pR, lR, aR] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/patients"),
        fetch("/api/admin/access"),
        fetch("/api/admin/audit"),
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
      <div className="flex min-h-dvh flex-col">
        <TopBar right={<PillLink href="/dashboard">← Pacientes</PillLink>} />
        <main role="alert" className="mx-auto flex max-w-xl flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-2xl font-medium">Acesso negado.</p>
          <p className="text-ink-soft">O Dashboard Administrativo é exclusivo do administrador.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        right={
          <>
            <PillLink href="/dashboard">Pacientes</PillLink>
            <PillLink href="/">Início</PillLink>
          </>
        }
      />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
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
                tab === t.id ? "bg-ink text-white" : "text-ink-soft hover:text-ink"
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
  const [name, setName] = useState(u.name);
  const [role, setRole] = useState<UserRole>(u.role);

  const remove = async () => {
    const n = u.links.length;
    const msg =
      `Excluir a conta de ${u.name}?\n\n` +
      `• ${n} vínculo(s) com paciente(s) serão removidos.\n` +
      "• Os pacientes e seus dados NÃO serão apagados.\n" +
      "• As sessões de login serão invalidadas.\n\nEsta ação não pode ser desfeita.";
    if (!window.confirm(msg)) return;
    await run(api("/api/admin/users", "DELETE", { id: u.id }), `Usuário ${u.name} excluído.`);
  };

  return (
    <li className="flex flex-col gap-3 rounded-3xl border border-line bg-card p-4 sm:flex-row sm:items-center">
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
              <button type="button" className={btnDanger} onClick={() => void remove()}>
                Excluir
              </button>
            </>
          )}
        </div>
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
  const [name, setName] = useState(p.name);

  const remove = async (hard: boolean) => {
    const base =
      `${hard ? "EXCLUIR DEFINITIVAMENTE" : "Desativar"} o paciente ${p.name}?\n\n` +
      `• ${authorized.length} usuário(s) possuem acesso a este paciente.\n`;
    const msg = hard
      ? base +
        "• Perfil, Rotinas, Emergências, gestos, configurações de voz e vínculos serão APAGADOS.\n" +
        "• Esta ação NÃO pode ser desfeita.\n\nDigite OK para confirmar."
      : base + "• Os dados são preservados e o paciente pode ser reativado.";
    if (!window.confirm(msg)) return;
    if (hard) {
      const typed = window.prompt(`Confirmação reforçada: digite o nome do paciente (${p.name}) para excluir.`);
      if (typed?.trim() !== p.name) return;
    }
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
            <button type="button" className={btnLight} onClick={() => void remove(false)}>Desativar</button>
            <button type="button" className={btnDanger} onClick={() => void remove(true)}>Excluir</button>
          </div>
        )}
      </div>
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
                    ? "border-ink bg-ink text-white"
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

      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Matriz de acesso</h2>
        <div className="ml-auto flex gap-1 rounded-full border border-line bg-card p-1">
          {(
            [
              ["porUsuario", "Por usuário"],
              ["porPaciente", "Por paciente"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                view === id ? "bg-ink text-white" : "text-ink-soft"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {links.length === 0 ? (
        <p className="rounded-3xl border border-line bg-card p-10 text-center">
          Nenhum vínculo criado ainda.
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
        <button
          type="button"
          className={btnDanger}
          onClick={() => {
            if (
              window.confirm(
                "Remover este vínculo?\n\nO usuário perde o acesso a este paciente imediatamente. Os dados do paciente NÃO são apagados e os demais vínculos continuam valendo."
              )
            ) {
              void run(api("/api/admin/access", "DELETE", { id: link.id }), "Vínculo removido.");
            }
          }}
        >
          Revogar
        </button>
      </div>
      {editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {PERMISSIONS.map((p) => (
            <label
              key={p}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs ${
                perms.includes(p) ? "border-ink bg-ink text-white" : "border-line bg-card text-ink-soft"
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
