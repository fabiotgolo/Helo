import {
  listItems,
  addItem,
  updateItem,
  deleteItem,
  reorderItems,
  restoreDefaults,
  getItemMode,
} from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";
import type { Permission } from "@/lib/access-types";
import type { HeloItemMode, ModeItemInput } from "@/lib/types";

// Itens de modo personalizados por paciente (Rotina, Emergência e
// expressões de Conversa). Toda operação exige patientId — nenhum conteúdo
// personalizado é global. Leitura exige vínculo; edição exige a permissão
// do modo correspondente (editRoutine / editEmergency / editConversation).

const MODES: HeloItemMode[] = ["rotina", "emergencia", "conversa"];

const EDIT_PERMISSION: Record<HeloItemMode, Permission> = {
  rotina: "editRoutine",
  emergencia: "editEmergency",
  conversa: "editConversation",
};

function parseMode(v: unknown): HeloItemMode | null {
  return MODES.includes(v as HeloItemMode) ? (v as HeloItemMode) : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const mode = parseMode(url.searchParams.get("mode"));
  if (!patientId || !mode) {
    return Response.json(
      { error: "patientId e mode obrigatórios" },
      { status: 400 }
    );
  }
  // Ler itens exige vínculo ativo (qualquer permissão) — é o mínimo para
  // operar a Helo com o paciente.
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  const items = await listItems(patientId, mode);
  return Response.json({ items });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    mode?: string;
    item?: ModeItemInput;
    /** ação especial: "restore" recompõe o conteúdo padrão do modo */
    action?: "restore";
    /** ação especial: "reorder" aplica a nova sequência de ids */
    order?: string[];
  };
  const mode = parseMode(body.mode);
  if (!body.patientId || !mode) {
    return Response.json(
      { error: "patientId e mode obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(
    request,
    body.patientId,
    EDIT_PERMISSION[mode]
  );
  if (auth instanceof Response) return auth;
  if (body.action === "restore") {
    await restoreDefaults(body.patientId, mode);
    return Response.json({ ok: true });
  }
  if (body.order) {
    await reorderItems(body.patientId, body.order);
    return Response.json({ ok: true });
  }
  if (!body.item?.label?.trim() || !body.item?.spokenText?.trim()) {
    return Response.json(
      { error: "título e frase falada são obrigatórios" },
      { status: 400 }
    );
  }
  const item = await addItem(body.patientId, mode, body.item);
  return Response.json({ item });
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    itemId?: string;
    item?: ModeItemInput;
  };
  if (!body.patientId || !body.itemId || !body.item) {
    return Response.json(
      { error: "patientId, itemId e item obrigatórios" },
      { status: 400 }
    );
  }
  const mode = await getItemMode(body.patientId, body.itemId);
  if (!mode) {
    return Response.json({ error: "item não encontrado" }, { status: 404 });
  }
  const auth = await requirePatientAccess(
    request,
    body.patientId,
    EDIT_PERMISSION[mode]
  );
  if (auth instanceof Response) return auth;
  try {
    await updateItem(body.patientId, body.itemId, body.item);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    itemId?: string;
  };
  if (!body.patientId || !body.itemId) {
    return Response.json(
      { error: "patientId e itemId obrigatórios" },
      { status: 400 }
    );
  }
  const mode = await getItemMode(body.patientId, body.itemId);
  if (!mode) {
    return Response.json({ error: "item não encontrado" }, { status: 404 });
  }
  const auth = await requirePatientAccess(
    request,
    body.patientId,
    EDIT_PERMISSION[mode]
  );
  if (auth instanceof Response) return auth;
  const result = await deleteItem(body.patientId, body.itemId);
  return Response.json(result);
}
