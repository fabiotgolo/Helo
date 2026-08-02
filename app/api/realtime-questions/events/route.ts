import { requirePatientAccess } from "@/lib/auth";
import { listAuditEvents } from "@/lib/realtime-question-store";

// Trilha de auditoria de uma sessão de Perguntas em tempo real.
//
// SOMENTE LEITURA, por construção: não existe POST, PATCH nem DELETE aqui.
// Os eventos nascem exclusivamente dentro das transações do domínio, com
// autoria e horário do servidor — o cliente não cria, não edita e não apaga
// nenhum evento.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  if (!sessionId) {
    return Response.json({ error: "sessionId obrigatório" }, { status: 400 });
  }
  // Recortes opcionais: uma pergunta, um caminho, um nível ou uma frase.
  // Sem nenhum, vem a sessão inteira.
  const events = await listAuditEvents(patientId, sessionId, {
    turnId: url.searchParams.get("turnId"),
    pathId: url.searchParams.get("pathId"),
    nodeId: url.searchParams.get("nodeId"),
    statementId: url.searchParams.get("statementId"),
  });
  if (!events) {
    return Response.json({ error: "sessão não encontrada" }, { status: 404 });
  }
  return Response.json({ events });
}
