// Resolve o alias "@/..." do tsconfig fora do Next, para que os testes de
// domínio possam importar os módulos de lib/ diretamente (Node roda .ts por
// type stripping). Só mapeia o prefixo do alias e acrescenta a extensão que
// o TypeScript deixa implícita; todo o resto segue o resolvedor padrão.

const ROOT = new URL("../", import.meta.url);
const EXTENSOES = [".ts", ".tsx", ".mjs", ".js", "/index.ts", ""];

export async function resolve(specifier, context, next) {
  if (!specifier.startsWith("@/")) return next(specifier, context);
  const base = specifier.slice(2);
  for (const ext of EXTENSOES) {
    const candidato = new URL(`${base}${ext}`, ROOT).href;
    try {
      // `next` é assíncrono: sem o await, a falha escaparia deste try e a
      // próxima extensão nunca seria tentada.
      return await next(candidato, context);
    } catch {
      // Tenta a próxima extensão.
    }
  }
  throw new Error(`não foi possível resolver o alias "${specifier}"`);
}
