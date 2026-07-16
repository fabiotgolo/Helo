// A sessão do Agent Helo vive no HeloAgentProvider global. Esta rota mantém
// somente o ponto visual onde o provider monta os controles da conversa.
export default function HeloPage() {
  return <div id="helo-agent-stage" className="flex min-h-0 flex-1" />;
}
