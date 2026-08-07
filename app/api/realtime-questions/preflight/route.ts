import { requirePatientAccess } from "@/lib/auth";

// ——— Preflight da fila offline (Fase 4.9.4, complemento pré-Fase E) ———
//
// Uma pergunta só: "posso enviar, sob esta identidade, para este paciente,
// AGORA?" — sem gravar nada, sem devolver dado de ninguém.
//
// Esta rota NÃO decide nada por conta própria. `requirePatientAccess` é a
// MESMA função que toda escrita da fila já usa — a mesma que confere
// autenticação vigente (a sessão do cookie ainda existe e não expirou),
// identidade (o `expectedUserId` da fila ainda é quem está logado — R6) e
// vínculo ativo com o paciente. Zero regra de autorização nova; só um lugar
// pequeno e barato para perguntar isso ANTES de consumir a fila, em vez de
// só reativamente, no meio de um envio de verdade.
//
// A permissão exigida é "createSession" — a mesma que TODA escrita da fila
// pede. Perguntar com uma permissão mais fraca (por exemplo, "viewSessions")
// devolveria "pode enviar" para quem, de fato, não pode.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const expectedUserId = url.searchParams.get("expectedUserId");
  const auth = await requirePatientAccess(
    request,
    patientId,
    "createSession",
    expectedUserId
  );
  if (auth instanceof Response) return auth;
  // Nada além de "sim" e de quem: o corpo não pode virar uma segunda rota
  // de leitura de dado nenhum.
  return Response.json({ ok: true, userId: auth.user.id });
}
