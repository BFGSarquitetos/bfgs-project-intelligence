import { router, json, error, requireAuth, db, storage, ai } from '@appdeploy/sdk';
import { Buffer } from 'node:buffer';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

type Project = {
  id: string;
  name: string;
  code: string;
  client: string;
  phase: string;
  status: string;
  owner: string;
  createdAt: string;
};
type FileRecord = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  path: string;
  scope: string;
  projectId: string;
  kind: string;
  createdAt: string;
  owner: string;
};
type ChunkBody = {
  scope: string;
  projectId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  partIndex: number;
  totalParts: number;
  content: string;
  kind?: string;
};
const uid = (s: string) =>
  s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'item';
const safe = (s: string) =>
  s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
const now = () => new Date().toISOString();
const decode = (s: string) => Buffer.from(s, 'base64');
const encode = (b: Uint8Array) => Buffer.from(b).toString('base64');
function parseDxf(text: string) {
  const lines = text.split(/\r?\n/),
    entities: { type: string; pairs: [number, string][] }[] = [];
  let cur: { type: string; pairs: [number, string][] } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()),
      val = lines[i + 1].trimEnd();
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      if (cur) entities.push(cur);
      cur = { type: val.trim(), pairs: [] };
    } else if (cur) cur.pairs.push([code, val]);
  }
  if (cur) entities.push(cur);
  const counts: Record<string, number> = {},
    layers: Record<string, number> = {},
    texts: string[] = [],
    xrefs: string[] = [],
    rasters: string[] = [];
  let dims = 0,
    textCount = 0;
  for (const e of entities) {
    if (
      [
        'SECTION',
        'ENDSEC',
        'EOF',
        'TABLE',
        'ENDTAB',
        'ENDBLK',
        'SEQEND',
      ].includes(e.type)
    )
      continue;
    counts[e.type] = (counts[e.type] || 0) + 1;
    const layer = e.pairs.find(p => p[0] === 8)?.[1] || '0';
    layers[layer] = (layers[layer] || 0) + 1;
    if (e.type === 'DIMENSION') dims++;
    if (['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(e.type)) {
      textCount++;
      const t = e.pairs
        .filter(p => p[0] === 1 || p[0] === 3)
        .map(p => p[1])
        .join('')
        .replace(/\\P/g, ' ')
        .trim();
      if (t) texts.push(t);
    }
    if (e.type === 'IMAGE' || e.type === 'IMAGEDEF') {
      const p = e.pairs.find(x => x[0] === 1)?.[1];
      if (p) rasters.push(p);
    }
    if (e.type === 'BLOCK') {
      const flags = Number(e.pairs.find(p => p[0] === 70)?.[1] || 0);
      if (flags & 12)
        xrefs.push(e.pairs.find(p => p[0] === 1)?.[1] || 'XREF sem caminho');
    }
  }
  const header = (key: string, group: number) => {
    const at = lines.findIndex(x => x.trim() === key);
    if (at < 0) return '';
    for (let i = at + 1; i < Math.min(at + 8, lines.length - 1); i += 2)
      if (Number(lines[i].trim()) === group) return lines[i + 1].trim();
    return '';
  };
  const version = header('$ACADVER', 1),
    unit = Number(header('$INSUNITS', 70) || 0),
    unitNames: Record<number, string> = {
      0: 'Não definida',
      1: 'Polegadas',
      2: 'Pés',
      4: 'Milímetros',
      5: 'Centímetros',
      6: 'Metros',
    };
  const placeholders = texts.filter(t =>
    /<(NOME|DATA|CLIENTE)|TBD|A DEFINIR|REVISÃO\\s*#|####|\\{\\{/.test(t)
  );
  const findings: any[] = [];
  if (xrefs.length)
    findings.push({
      title: 'Referências externas ainda vinculadas',
      severity: 'Alta',
      status: 'Corrigir antes da emissão',
      source: xrefs.join(', '),
      recommendation:
        'Incorporar as referências ou publicar o DXF consolidado e repetir a leitura.',
    });
  if (placeholders.length)
    findings.push({
      title: 'Campos ou textos provisórios encontrados',
      severity: 'Média',
      status: 'Conferência necessária',
      source: placeholders.slice(0, 10).join(' | '),
      recommendation:
        'Conferir carimbo, data, revisão, identificação e notas antes da emissão.',
    });
  if (!dims && textCount)
    findings.push({
      title: 'Cotas nativas não identificadas',
      severity: 'Baixa',
      status: 'Não verificável automaticamente',
      source:
        'Há textos/anotações, mas nenhuma entidade DIMENSION nativa foi reconhecida.',
      recommendation:
        'As cotas podem estar explodidas em linhas e textos. Conferir medidas críticas; não classificar ausência como erro confirmado.',
    });
  if (rasters.length)
    findings.push({
      title: 'Referências raster vinculadas',
      severity: 'Baixa',
      status: 'Conferência de pacote',
      source: rasters.join(', '),
      recommendation:
        'Incluir imagens vinculadas no pacote ou confirmar incorporação.',
    });
  if (!findings.length)
    findings.push({
      title: 'Leitura estrutural concluída',
      severity: 'Informativo',
      status: 'Sem alerta automático nesta leitura',
      source:
        'Não foram detectados XREFs ou campos provisórios pelos critérios básicos.',
      recommendation:
        'A ausência de alertas não significa aprovação técnica da prancha.',
    });
  return {
    version,
    units: unitNames[unit] || 'Código ' + unit,
    entityCount: Object.values(counts).reduce((a, b) => a + b, 0),
    layerCount: Object.keys(layers).length,
    dimensionCount: dims,
    textEntities: textCount,
    entityCounts: Object.entries(counts).sort((a, b) => b[1] - a[1]),
    layerCounts: Object.entries(layers).sort((a, b) => b[1] - a[1]),
    findings,
    texts: texts.slice(0, 300),
  };
}
async function readStored(path: string) {
  const [f] = await storage.read([path]);
  if (!f?.content) throw new Error('Arquivo não encontrado no armazenamento.');
  return f.content;
}
async function readIfcText(file: FileRecord) {
  const encoded = await readStored(file.path);
  const binary = decode(encoded);
  if (/\.ifczip$|\.zip$/i.test(file.name)) {
    const archive = await JSZip.loadAsync(binary);
    const entries = (Object.values(archive.files) as any[]).filter(
      entry => !entry.dir && /\.ifc$/i.test(entry.name)
    );
    if (entries.length !== 1) {
      throw new Error(entries.length
        ? 'O pacote contém mais de um IFC. Envie um arquivo por vez.'
        : 'O pacote não contém um arquivo .ifc.');
    }
    const entry = entries[0];
    return { text: await entry.async('string'), fileName: entry.name.split('/').pop() || 'modelo.ifc' };
  }
  if (!/\.ifc$/i.test(file.name)) throw new Error('Envie um arquivo .ifc ou um .ifczip com um único IFC.');
  return { text: binary.toString('utf8'), fileName: file.name };
}
function parseIfc(text: string) {
  const elements: { stepId: string; ifcClass: string; guid: string; name: string }[] = [];
  let projectGuid = '';
  const pattern = /#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\(\s*'([0-9A-Za-z_$]{22})'\s*,\s*[^,]*,\s*('(?:[^']|'')*'|\$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const ifcClass = match[2].toUpperCase();
    const guid = match[3];
    const rawName = match[4];
    const name = rawName === '$' ? '' : rawName.slice(1, -1).replace(/''/g, "'");
    if (ifcClass === 'IFCPROJECT') {
      if (!projectGuid) projectGuid = guid;
      continue;
    }
    elements.push({ stepId: match[1], ifcClass, guid, name });
  }
  return { projectGuid, elements };
}
async function fileRecord(id: string, owner: string) {
  if (!id) throw new Error('Arquivo não encontrado ou sem permissão.');
  // Leitura consistente evita falso "não encontrado" logo após o upload.
  const [direct] = await db.get<FileRecord>('bfgs_files', [id], { consistent: true });
  if (direct && direct.owner === owner) return direct;

  // Compatibilidade com índices legados: usa o ID físico retornado pela listagem,
  // sem confiar no ID lógico armazenado no conteúdo do registro.
  const page = await db.list<FileRecord>('bfgs_files', { limit: 200 });
  const listed = page.items.find(file => file.id === id && file.owner === owner);
  if (listed) return listed;
  throw new Error('Arquivo não encontrado ou sem permissão.');
}
async function ownedProject(id: string, owner: string) {
  // Primeiro tenta a chave física do banco, usada nos registros novos.
  const [direct] = await db.get<Project>('bfgs_projects', [id]);
  if (direct && direct.owner === owner) return direct;

  // Compatibilidade com projetos antigos, criados antes da correção do ID:
  // neles o ID guardado no conteúdo pode diferir da chave física do registro.
  const page = await db.list<Project>('bfgs_projects', { limit: 200 });
  const legacy = page.items.find(
    project =>
      project.owner === owner &&
      (project.id === id || (project as any).legacyId === id)
  );
  return legacy || null;
}
function bcfXml(issue: any, topicId: string, viewId: string, project: any, index: number) {
  const title = String(issue.title || 'Apontamento BFGS');
  const guids = [...new Set([
    String(issue.guid || '').trim(),
    ...(Array.isArray(issue.relatedGuids) ? issue.relatedGuids : String(issue.relatedGuids || '').split(/[;,\\s]+/))
      .map((value: any) => String(value).trim())
      .filter(Boolean),
  ])];
  const priorityBySeverity: Record<string, string> = {
    'Crítica': 'Critical', 'Alta': 'Major', 'Média': 'Normal', 'Baixa': 'Minor', 'Informativo': 'Trivial',
  };
  const priority = priorityBySeverity[String(issue.severity || 'Média')] || 'Normal';
  const description = [
    String(issue.description || '').trim(),
    issue.elementName ? 'Elemento principal IFC: ' + String(issue.elementName) : '',
    'Componentes IFC vinculados: ' + guids.length,
    project.receipt ? 'Recibo da revisão: ' + String(project.receipt) : '',
  ].filter(Boolean).join('\\n\\n');
  const header = `<Header><File${project.ifcProjectGuid ? ' IfcProject="' + esc(String(project.ifcProjectGuid)) + '"' : ''} IsExternal="true"><Filename>${esc(String(project.ifcFileName || 'modelo.ifc'))}</Filename></File></Header>`;
  const components = guids.map((guid: string, componentIndex: number) =>
    `<Component IfcGuid="${esc(guid)}" Selected="${componentIndex === 0 ? 'true' : 'false'}"><OriginatingSystem>Archicad</OriginatingSystem><AuthoringToolId>${esc(String(issue.elementName || 'BFGS'))}</AuthoringToolId></Component>`
  ).join('');
  const camera = issue.camera || {};
  const numberOr = (value: any, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const cx = numberOr(camera.centerX, 0), cy = numberOr(camera.centerY, 0), cz = numberOr(camera.centerZ, 0);
  const distance = Math.max(1, Math.min(100000, numberOr(camera.distance, 10000)));
  const offset = distance / Math.sqrt(3);
  const vx = numberOr(camera.x, cx + offset), vy = numberOr(camera.y, cy - offset), vz = numberOr(camera.z, cz + offset);
  const dx = cx - vx, dy = cy - vy, dz = cz - vz;
  const length = Math.max(0.000001, Math.sqrt(dx * dx + dy * dy + dz * dz));
  const view = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<VisualizationInfo Guid="${viewId}" xmlns="http://www.buildingsmart-tech.org/bcf/visinfo/2.1"><Components DefaultVisibility="true">${components}</Components><PerspectiveCamera><CameraViewPoint><X>${vx}</X><Y>${vy}</Y><Z>${vz}</Z></CameraViewPoint><CameraDirection><X>${dx / length}</X><Y>${dy / length}</Y><Z>${dz / length}</Z></CameraDirection><CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>60</FieldOfView></PerspectiveCamera><Lines/><ClippingPlanes/></VisualizationInfo>`;
  return {
    markup: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<Markup xmlns="http://www.buildingsmart-tech.org/bcf/markup/2.1">${header}<Topic Guid="${topicId}" TopicType="Issue" TopicStatus="Open"><ReferenceLinks/><Title>${esc(title)}</Title><Priority>${priority}</Priority><Index>${index}</Index><Labels><Label>${esc(String(issue.discipline || 'Arquitetura'))}</Label><Label>BFGS</Label></Labels><CreationDate>${now()}</CreationDate><CreationAuthor>BFGS</CreationAuthor><Description>${esc(description || title)}</Description><Viewpoints Guid="${viewId}"><Viewpoint>viewpoint.bcfv</Viewpoint><Index>0</Index></Viewpoints></Topic></Markup>`,
    view,
    linkedComponents: guids.length,
  };
}
function esc(v: string) {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
export const handler = router({
  'GET /api/projects': [
    requireAuth(),
    async ({ user }) => {
      const r = await db.list<Project>('bfgs_projects', { limit: 100 });
      return json({
        projects: r.items
          .filter(p => p.owner === user!.userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    },
  ],
  'POST /api/projects': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      if (!b?.name?.trim() || !b?.code?.trim())
        return error('Nome e código são obrigatórios.', 400);
      const id = crypto.randomUUID();
      const p = {
        id,
        name: String(b.name).trim(),
        code: String(b.code).trim(),
        client: String(b.client || ''),
        phase: String(b.phase || 'Anteprojeto'),
        status: 'Em andamento',
        owner: user!.userId,
        createdAt: now(),
      };
      // db.tx.add respeita record.id como chave física, evitando divergência.
      const [savedId] = await db.tx.add('bfgs_projects', [p]);
      if (!savedId) return error('Não foi possível criar o projeto.', 500);
      return json({ project: p }, 201);
    },
  ],
  'POST /api/files/delete': [
    requireAuth(),
    async ({ body, user }) => {
      const ids = Array.isArray((body as any)?.ids)
        ? [...new Set((body as any).ids.map(String))].slice(0, 200)
        : [];
      const projectId = String((body as any)?.projectId || '');
      if (!ids.length) return error('Selecione ao menos um arquivo.', 400);
      const page = await db.list<FileRecord>('bfgs_files', { limit: 200 });
      const owned = page.items.filter(
        f => ids.includes(f.id) && f.owner === user!.userId &&
          f.scope === 'project' && (!projectId || f.projectId === projectId)
      );
      if (owned.length !== ids.length) {
        return error(
          'Não foi possível localizar todos os arquivos selecionados neste projeto. Atualize a página e selecione novamente.',
          404
        );
      }
      // Exclusão transacional: só prossegue para remover o binário após o banco confirmar.
      const deleted = await db.tx.delete('bfgs_files', owned.map(f => f.id));
      const failedRecords = deleted.filter(ok => !ok).length;
      if (failedRecords) {
        return error(
          'O banco não confirmou a exclusão de ' + failedRecords + ' registro(s). Nenhum arquivo físico foi removido.',
          500
        );
      }
      let failedStorage = 0;
      try {
        const storageResults = await storage.delete(owned.map(f => f.path));
        failedStorage = storageResults.filter(ok => !ok).length;
      } catch {
        failedStorage = owned.length;
      }
      return json({
        ok: true,
        deleted: owned.length,
        message: failedStorage
          ? owned.length + ' arquivo(s) removido(s) da lista. A limpeza física de ' + failedStorage + ' item(ns) ficou pendente.'
          : owned.length + ' arquivo(s) excluído(s) com sucesso.'
      });
    },
  ],
  'GET /api/files': [
    requireAuth(),
    async ({ user }) => {
      const r = await db.list<FileRecord>('bfgs_files', { limit: 200 });
      const owned = r.items.filter(f => f.owner === user!.userId);
      // Confirma a existência pela chave física; registros já excluídos não reaparecem
      // por uma leitura eventual da listagem.
      const current = owned.length
        ? await db.get<FileRecord>('bfgs_files', owned.map(f => f.id), { consistent: true })
        : [];
      return json({ files: owned.filter((_, index) => current[index] !== null && current[index] !== undefined) });
    },
  ],
  'POST /api/files/chunk': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as ChunkBody;
      if (
        !b.fileId ||
        !b.content ||
        !Number.isInteger(b.partIndex) ||
        b.totalParts < 1 ||
        b.totalParts > 200
      )
        return error('Parte de arquivo inválida.', 400);
      if (b.scope === 'project') {
        const p = await ownedProject(String(b.projectId || ''), user!.userId);
        if (!p) return error('Projeto não encontrado para este usuário. Atualize a lista de projetos e tente novamente.', 404);
      }
      if (b.scope !== 'project' && b.scope !== 'library')
        return error('Destino inválido.', 400);
      const path =
        'uploads/' +
        user!.userId +
        '/' +
        uid(b.fileId) +
        '/part-' +
        b.partIndex;
      const [ok] = await storage.write([
        { path, content: b.content, contentType: 'text/plain' },
      ]);
      if (!ok) return error('Falha ao armazenar parte do arquivo.', 500);
      return json({ ok: true });
    },
  ],
  'POST /api/files/complete': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      const id = String(b.fileId || '');
      const n = Number(b.totalParts);
      if (!id || !Number.isInteger(n) || n < 1 || n > 200)
        return error('Dados de conclusão inválidos.', 400);
      if (b.scope !== 'project' && b.scope !== 'library')
        return error('Destino inválido.', 400);
      if (b.scope === 'project') {
        const p = await ownedProject(String(b.projectId || ''), user!.userId);
        if (!p) return error('Projeto não encontrado para este usuário. Atualize a lista de projetos e tente novamente.', 404);
      }
      const paths = Array.from(
        { length: n },
        (_, i) => 'uploads/' + user!.userId + '/' + uid(id) + '/part-' + i
      );
      const chunks = await storage.read(paths);
      if (chunks.some(x => !x.content))
        return error('Upload incompleto. Reenvie o arquivo.', 400);
      const content = chunks.map(x => x.content || '').join('');
      let binary = decode(content);
      let storedFileName = String(b.fileName || 'arquivo');

      if (b.kind === 'DXF' && /\.zip$/i.test(storedFileName)) {
        try {
          const archive = await JSZip.loadAsync(binary);
          const dxfEntries = (Object.values(archive.files) as any[]).filter(
            (entry: any) => !entry.dir && /\.dxf$/i.test(entry.name)
          );
          if (dxfEntries.length === 0)
            return error('O ZIP não contém nenhum arquivo .dxf. Compacte o DXF dentro de um arquivo ZIP e tente novamente.', 400);
          if (dxfEntries.length > 1)
            return error('O ZIP contém mais de um DXF. Envie um ZIP com apenas o DXF consolidado do projeto.', 400);
          const entry = dxfEntries[0];
          binary = await entry.async('nodebuffer');
          storedFileName = entry.name.split('/').pop() || 'projeto.dxf';
        } catch (e: any) {
          if (String(e?.message || '').includes('ZIP não contém') || String(e?.message || '').includes('mais de um DXF'))
            throw e;
          return error('Não foi possível abrir esse ZIP. Verifique se o arquivo não está corrompido e tente novamente.', 400);
        }
      } else if (b.kind === 'DXF' && /\.rar$/i.test(storedFileName)) {
        return error('Formato RAR não é compatível. Extraia o arquivo no WinRAR e envie o .dxf, ou compacte o DXF como .zip.', 400);
      } else if (b.kind === 'DXF' && !/\.dxf$/i.test(storedFileName)) {
        return error('Envie um arquivo .dxf ou um .zip contendo exatamente um DXF.', 400);
      }

      const path =
        (b.scope === 'library'
          ? 'library/'
          : 'projects/' + uid(String(b.projectId)) + '/') +
        uid(id) +
        '-' +
        safe(storedFileName);
      const [ok] = await storage.write([
        {
          path,
          content: encode(binary),
          contentType: b.kind === 'DXF' ? 'application/dxf' : String(b.mimeType || 'application/octet-stream'),
        },
      ]);
      if (!ok) return error('Não foi possível finalizar o armazenamento.', 500);
      const record = {
        id,
        name: storedFileName,
        size: binary.length,
        mimeType: String(b.mimeType || 'application/octet-stream'),
        path,
        scope: String(b.scope),
        projectId: String(b.projectId || ''),
        kind: String(b.kind || 'Arquivo'),
        createdAt: now(),
        owner: user!.userId,
      };
      // Use transação para preservar record.id como chave física, assim como
      // no cadastro de projetos. Isso mantém GET, leitura, exclusão e vínculo
      // do arquivo consistentes entre sessões.
      const [savedId] = await db.tx.add('bfgs_files', [record]);
      if (!savedId) {
        await storage.delete([path]);
        return error(
          'Arquivo armazenado, mas o índice persistente não foi criado. Tente novamente.',
          500
        );
      }
      await storage.delete(paths);
      return json({ file: { ...record, id: savedId } }, 201);
    },
  ],
  'POST /api/review/dxf': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      let f: FileRecord;
      try { f = await fileRecord(String(b.fileId || ''), user!.userId); }
      catch { return error('Arquivo DXF não encontrado ou sem permissão. Atualize os documentos do projeto e tente novamente.', 404); }
      if (f.kind !== 'DXF' || f.scope !== 'project' || f.projectId !== String(b.projectId || ''))
        return error('Selecione um DXF armazenado neste projeto.', 400);
      const content = await readStored(f.path);
      const report = parseDxf(decode(content).toString('latin1'));
      const result = {
        ...report,
        fileName: f.name,
        projectId: f.projectId,
        reviewedAt: now(),
      };
      return json({ report: result });
    },
  ],
  'POST /api/review/ifc': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      let f: FileRecord;
      try { f = await fileRecord(String(b.fileId || ''), user!.userId); }
      catch { return error('Arquivo IFC não encontrado ou sem permissão.', 404); }
      if (f.kind !== 'IFC' || f.scope !== 'project' || f.projectId !== String(b.projectId || ''))
        return error('Selecione um IFC armazenado neste projeto.', 400);
      let source: { text: string; fileName: string };
      try { source = await readIfcText(f); }
      catch (e: any) { return error(e?.message || 'Não foi possível ler o IFC.', 400); }
      const parsed = parseIfc(source.text);
      if (!parsed.elements.length)
        return error('O IFC foi aberto, mas nenhum elemento com GUID válido foi identificado.', 422);
      return json({
        fileName: source.fileName,
        projectGuid: parsed.projectGuid,
        totalElements: parsed.elements.length,
        elements: parsed.elements.slice(0, 2000),
        truncated: parsed.elements.length > 2000,
      });
    },
  ],
  'POST /api/review/executive': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      const projectId = String(b.projectId || '');
      const project = await ownedProject(projectId, user!.userId);
      if (!project) return error('Projeto não encontrado.', 404);
      const page = await db.list<FileRecord>('bfgs_files', { limit: 200 });
      const files = page.items.filter(f => f.owner === user!.userId &&
        ((f.scope === 'project' && f.projectId === projectId) || f.scope === 'library'));
      const sources: any[] = [];
      const limitations: string[] = [];
      for (const f of files) {
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        try {
          const encoded = await readStored(f.path);
          const binary = decode(encoded);
          let content = '';
          if (ext === 'dxf') {
            const parsed = parseDxf(binary.toString('latin1'));
            content = 'DXF ' + f.name + '\nLayers: ' + JSON.stringify(parsed.layerCounts) +
              '\nEntidades: ' + JSON.stringify(parsed.entityCounts) +
              '\nTextos/anotações: ' + (parsed.texts || []).join(' | ') +
              '\nSinais preliminares: ' + JSON.stringify(parsed.findings);
          } else if (ext === 'ifc') {
            const parsed = parseIfc(binary.toString('utf8'));
            content = 'IFC ' + f.name + '\nProject GUID: ' + parsed.projectGuid +
              '\nElementos: ' + parsed.elements.slice(0, 1000).map(e =>
                e.ifcClass + ' | ' + e.name + ' | GUID ' + e.guid).join('\n');
          } else if (ext === 'ifczip' || ext === 'zip') {
            const archive = await JSZip.loadAsync(binary);
            const entries = Object.values(archive.files) as any[];
            const ifcEntry = entries.find(e => !e.dir && /\.ifc$/i.test(e.name));
            if (ifcEntry) {
              const parsed = parseIfc(await ifcEntry.async('string'));
              content = 'IFC ' + f.name + '\nProject GUID: ' + parsed.projectGuid +
                '\nElementos: ' + parsed.elements.slice(0, 1000).map(e =>
                  e.ifcClass + ' | ' + e.name + ' | GUID ' + e.guid).join('\n');
            } else limitations.push(f.name + ': ZIP sem IFC reconhecido.');
          } else if (['xlsx', 'xls', 'csv'].includes(ext)) {
            const wb = XLSX.read(binary, { type: 'buffer' });
            content = wb.SheetNames.map(name => 'ABA ' + name + '\n' +
              XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n\n').slice(0, 16000);
          } else if (ext === 'txt') content = binary.toString('utf8').slice(0, 16000);
          else limitations.push(f.name + ': armazenado, mas ainda sem extração textual nesta etapa (' + ext.toUpperCase() + ').');
          if (content) sources.push({
            fileName: f.name, scope: f.scope, sourceType: ext.toUpperCase(),
            content: content.slice(0, 16000)
          });
        } catch (e: any) {
          limitations.push(f.name + ': falha de leitura — ' + (e?.message || 'erro desconhecido'));
        }
      }
      if (!sources.length) return error('Não há conteúdo textual extraível. Envie DXF, IFC ou XLSX/CSV.', 422);
      const combined = sources.map(s => '### ' + s.fileName + ' [' + s.sourceType + ']\n' + s.content).join('\n\n');
      const schema = {
        type: 'object',
        properties: {
          executiveSummary: { type: 'string' },
          coverage: { type: 'array', items: { type: 'object', properties: {
            discipline: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
            status: { type: 'string' }, notes: { type: 'string' }
          }, required: ['discipline', 'files', 'status', 'notes'] } },
          findings: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' },
            status: { type: 'string' }, severity: { type: 'string' },
            documents: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'string' }, technicalReason: { type: 'string' },
            impact: { type: 'string' }, recommendation: { type: 'string' },
            confidence: { type: 'string' }, validationNeeded: { type: 'boolean' }
          }, required: ['id','title','category','status','severity','documents','evidence','technicalReason','impact','recommendation','confidence','validationNeeded'] } },
          crossChecks: { type: 'array', items: { type: 'object', properties: {
            pair: { type: 'string' }, result: { type: 'string' }, evidence: { type: 'string' }
          }, required: ['pair','result','evidence'] } },
          notVerifiable: { type: 'array', items: { type: 'string' } }
        },
        required: ['executiveSummary','coverage','findings','crossChecks','notVerifiable']
      };
      try {
        const { data } = await ai.extract({
          prompt: 'Faça revisão crítica executiva BFGS e cruze documentos entre si: desenhos de disciplinas, plantas com tabelas, tabelas entre si, cortes, elevações, detalhes, notas e especificações. Só aponte incompatibilidades sustentadas pelo conteúdo fornecido. Cite nomes exatos dos documentos e evidência observável. Não invente cotas, normas, GUIDs, localização ou requisitos; não infira conformidade pela ausência de alerta. Use status: Conflito comprovado, Divergência documental, Possível conflito — validar ou Não verificável. Registre lacunas em notVerifiable. Diferencie padrão de escritório de requisito normativo. Projeto: ' + project.name + '; fase: ' + project.phase + '. Referências da biblioteca não são regras universais.',
          content: combined, schema, thinkingMode: 'DEEP', maxTokens: 6500
        });
        const result = data as any;
        const findings = Array.isArray(result.findings) ? result.findings : [];
        return json({
          project: { name: project.name, code: project.code, phase: project.phase },
          generatedAt: now(),
          sourceFiles: sources.map(s => ({ fileName: s.fileName, scope: s.scope, type: s.sourceType })),
          analyzedSourceCount: sources.length,
          limitations,
          ...result,
          findings: findings.map((f: any, i: number) => ({
            ...f, id: f.id || 'BFGS-CR-' + String(i + 1).padStart(3, '0')
          })),
          warning: 'Análise assistida por IA baseada somente no conteúdo extraído dos arquivos listados. PDFs, imagens e DOCX ainda não são extraídos nesta etapa. Não substitui conferência visual, validação normativa ou revisão técnica responsável.'
        });
      } catch (e: any) {
        return error('Falha na análise crítica: ' + (e?.message || 'serviço de IA indisponível'), 502);
      }
    },
  ],
  'POST /api/review/excel': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      const reports = Array.isArray(b.reports) ? b.reports : b.report ? [b.report] : [];
      if (!reports.length || reports.some((r: any) => !Array.isArray(r.findings)))
        return error('Nenhum relatório DXF válido foi informado.', 400);
      const p = await ownedProject(String(b.projectId || ''), user!.userId);
      if (!p)
        return error('Projeto não encontrado para este usuário.', 404);
      const wb = XLSX.utils.book_new();
      const signals = reports.flatMap((r: any, reportIndex: number) =>
        r.findings.map((finding: any, findingIndex: number) => ({
          id: 'BFGS-' + String(reportIndex + 1).padStart(2, '0') + '-' + String(findingIndex + 1).padStart(3, '0'),
          fileName: String(r.fileName || 'Arquivo sem nome'),
          finding,
        }))
      );
      const makeSheet = (rows: any[][], widths: number[]) => {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws['!cols'] = widths.map(wch => ({ wch }));
        if (rows.length > 1) {
          ws['!autofilter'] = {
            ref: 'A1:' + XLSX.utils.encode_col(rows[0].length - 1) + rows.length,
          };
        }
        return ws;
      };
      const cover = [
        ['BFGS ARQUITETURA — CONTROLE DE PROJETO'],
        ['RELATÓRIO DE REVISÃO DOCUMENTAL'],
        ['Projeto', p.name],
        ['Código', p.code],
        ['Cliente', p.client || 'Não informado'],
        ['Fase recebida', p.phase || 'Não informada'],
        ['Data de emissão', now()],
        ['Arquivos DXF analisados', reports.length],
        ['Sinais automáticos para conferência', signals.length],
        [],
        ['ESCOPO DESTA EMISSÃO'],
        ['Esta planilha organiza evidências estruturais extraídas dos DXFs. Ela NÃO representa aprovação técnica nem auditoria completa do checklist BFGS.'],
        ['A classificação depende do cruzamento documental com o Checklist BFGS Rev.02 e com os projetos de referência aprovados.'],
        ['A leitura automática atual não identifica, por si só, localização em prancha, requisito aplicável ou correspondência entre elementos DXF e itens do checklist.'],
        ['Problemas geométricos/modelagem que comprometam o modelo devem ser registrados no fluxo BCF, associados a GUID IFC validado.'],
        [],
        ['DOCUMENTOS DE REFERÊNCIA'],
        ['Checklist BFGS Rev.02', 'Não vinculado automaticamente a esta execução'],
        ['Padrão de referência do escritório', 'Não cruzado automaticamente nesta execução'],
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(cover, [38, 110]), 'Capa');

      const summary = [
        ['RESUMO DA REVISÃO'],
        ['Indicador', 'Resultado'],
        ['Projeto', p.name],
        ['Fase', p.phase || 'Não informada'],
        ['Arquivos analisados', reports.length],
        ['Sinais automáticos', signals.length],
        ['Itens conformes confirmados', 0],
        ['Não conformidades confirmadas', 0],
        ['Divergências checklist × referência confirmadas', 0],
        ['Itens não verificáveis / aguardando cruzamento', signals.length],
        [],
        ['IMPORTANTE', 'Os zeros significam que esta execução automática não confirmou esses estados; não significam que o projeto esteja conforme.'],
        ['Próxima etapa', 'Cruzar cada evidência com o checklist, a fase do projeto e o padrão BFGS antes de emitir parecer técnico.'],
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(summary, [52, 110]), 'Resumo');

      const audit = [
        ['ID', 'Prancha / localização', 'Disciplina', 'Item do checklist', 'Status', 'Descrição da verificação', 'Evidência observada', 'Arquivo de origem', 'Comparação com padrão BFGS', 'Gravidade', 'Prioridade', 'Justificativa', 'Recomendação', 'Vínculo BCF / GUID IFC'],
        ...signals.map((item: any) => [
          item.id,
          'Não identificada automaticamente no DXF',
          'A confirmar pelo arquivo/prancha',
          'Não vinculado — requer cruzamento com Checklist BFGS Rev.02',
          'Não verificável',
          item.finding.title || 'Sinal estrutural detectado',
          item.finding.source || 'Sem evidência textual detalhada',
          item.fileName,
          'Não cruzado com referência aprovada do escritório',
          'Não classificada',
          'A definir após validação',
          'O parser identificou um sinal no arquivo, mas não verificou o requisito aplicável nem a fase do projeto. Portanto, não é possível afirmar conformidade ou não conformidade.',
          item.finding.recommendation || 'Conferir manualmente a prancha e o arquivo de origem.',
          'Pendente de associação manual a um GUID IFC validado no módulo BCF',
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(audit, [18, 30, 26, 44, 20, 38, 60, 36, 44, 18, 24, 65, 60, 52]), 'Auditoria');

      const evidence = [
        ['ID', 'Arquivo de origem', 'Sinal automático', 'Gravidade heurística (não é prioridade)', 'Status do parser', 'Evidência bruta', 'Recomendação de conferência'],
        ...signals.map((item: any) => [
          item.id,
          item.fileName,
          item.finding.title,
          item.finding.severity || 'Não classificada',
          item.finding.status || 'Conferência necessária',
          item.finding.source || '',
          item.finding.recommendation || '',
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(evidence, [18, 36, 44, 42, 36, 72, 68]), 'Sinais DXF');

      const metrics = [
        ['Arquivo de origem', 'Data da leitura', 'Versão DXF', 'Unidades declaradas', 'Total de entidades', 'Quantidade de layers', 'Cotas DIMENSION nativas', 'Textos identificados'],
        ...reports.map((r: any) => [
          r.fileName,
          r.reviewedAt,
          r.version || 'Não identificada',
          r.units || 'Não identificadas',
          r.entityCount || 0,
          r.layerCount || 0,
          r.dimensionCount || 0,
          r.textEntities || 0,
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(metrics, [38, 24, 20, 24, 22, 20, 26, 22]), 'Evidências DXF');

      const layers = [
        ['Arquivo de origem', 'Layer', 'Quantidade de entidades'],
        ...reports.flatMap((r: any) =>
          (r.layerCounts || []).map((x: any) => [r.fileName, x[0], x[1]])
        ),
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(layers, [38, 52, 26]), 'Layers');

      const entities = [
        ['Arquivo de origem', 'Tipo de entidade DXF', 'Quantidade'],
        ...reports.flatMap((r: any) =>
          (r.entityCounts || []).map((x: any) => [r.fileName, x[0], x[1]])
        ),
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(entities, [38, 34, 20]), 'Entidades');

      const criteria = [
        ['CRITÉRIO DE CLASSIFICAÇÃO — PADRÃO BFGS'],
        ['Status', 'Definição de uso'],
        ['Conforme', 'Somente quando o requisito do checklist e a referência aplicável forem efetivamente verificados na documentação.'],
        ['Não conforme', 'Somente quando houver evidência objetiva de descumprimento de requisito aplicável à fase analisada.'],
        ['Divergência checklist × referência', 'Quando checklist e padrão aprovado do escritório divergirem; registrar como ponto de decisão, não como erro automático.'],
        ['Não verificável', 'Quando os arquivos disponíveis não permitem confirmar o requisito, a localização ou a evidência necessária.'],
        [],
        ['REGRA DE FASE'],
        ['A análise deve considerar a fase cadastrada do projeto. Não cobrar detalhamento executivo de anteprojeto, salvo requisito explicitamente aplicável.'],
        [],
        ['SEPARAÇÃO EXCEL × BCF'],
        ['Excel', 'Auditoria documental, evidências, rastreabilidade, comparação com checklist/referência e recomendações.'],
        ['BCF', 'Incompatibilidades geométricas/de modelagem que comprometem o modelo, sempre associadas a GUID IFC real e validado.'],
        [],
        ['LIMITAÇÃO DESTA EXECUÇÃO'],
        ['A biblioteca de referências ainda não está conectada a uma rotina automática de extração e comparação. Nenhum item foi marcado como conforme ou não conforme sem esse cruzamento.'],
      ];
      XLSX.utils.book_append_sheet(wb, makeSheet(criteria, [44, 115]), 'Critérios BFGS');

      const out = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      return json({ base64: out, signals: signals.length, verifiedFindings: 0 });
    },
  ],
  'POST /api/bcf/generate': [
    requireAuth(),
    async ({ body, user }) => {
      const b = body as any;
      const projectId = String(b.projectId || '');
      const p = await ownedProject(projectId, user!.userId);
      if (!p) return error('Projeto não encontrado.', 404);
      if (!String(b.receipt || '').trim() || !Array.isArray(b.issues) || !b.issues.length)
        return error('Recibo e apontamentos são obrigatórios.', 400);
      let ifc: FileRecord;
      try { ifc = await fileRecord(String(b.ifcFileId || ''), user!.userId); }
      catch { return error('Envie e analise um IFC do projeto antes de gerar o BCF.', 400); }
      if (ifc.kind !== 'IFC' || ifc.scope !== 'project' || ifc.projectId !== projectId)
        return error('O IFC selecionado não pertence a este projeto.', 400);
      let ifcSource: { text: string; fileName: string };
      try { ifcSource = await readIfcText(ifc); }
      catch (e: any) { return error(e?.message || 'Não foi possível ler o IFC selecionado.', 400); }
      const parsedIfc = parseIfc(ifcSource.text);
      const validGuids = new Set(parsedIfc.elements.map(element => element.guid));
      if (!validGuids.size) return error('Nenhum elemento com GUID IFC válido foi identificado no arquivo.', 400);
      for (const issue of b.issues) {
        const linkedGuids = [...new Set([
          String(issue?.guid || '').trim(),
          ...(Array.isArray(issue?.relatedGuids) ? issue.relatedGuids : String(issue?.relatedGuids || '').split(/[;,\\s]+/))
            .map((value: any) => String(value).trim()).filter(Boolean),
        ])];
        if (!String(issue?.title || '').trim())
          return error('Todos os apontamentos precisam de título.', 400);
        if (!linkedGuids.length || linkedGuids.some(guid => !/^[0-9A-Za-z_$]{22}$/.test(guid)))
          return error('Cada componente vinculado precisa de um GUID IFC válido com 22 caracteres.', 400);
        const missing = linkedGuids.filter(guid => !validGuids.has(guid));
        if (missing.length)
          return error('GUID(s) não encontrado(s) no IFC selecionado: ' + missing.join(', '), 400);
        if (issue?.camera && ['x', 'y', 'z', 'centerX', 'centerY', 'centerZ', 'distance'].some(key =>
          issue.camera[key] !== undefined && !Number.isFinite(Number(issue.camera[key]))))
          return error('Os parâmetros de câmera precisam ser numéricos.', 400);
      }
      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0" encoding="UTF-8"?><Version VersionId="2.1"/>');
      for (let i = 0; i < b.issues.length; i++) {
        const issue = { ...b.issues[i], guid: String(b.issues[i].guid).trim() };
        const topic = crypto.randomUUID();
        const view = crypto.randomUUID();
        const x = bcfXml(issue, topic, view, {
          code: p.code,
          ifcProjectGuid: parsedIfc.projectGuid,
          ifcFileName: ifcSource.fileName,
          receipt: String(b.receipt).trim(),
        }, i);
        zip.folder(topic)!.file('markup.bcf', x.markup);
        zip.folder(topic)!.file('viewpoint.bcfv', x.view);
      }
      const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
      return json({
        zipBase64: base64,
        receipt: String(b.receipt).trim(),
        topics: b.issues.length,
        linkedComponents: b.issues.reduce((total: number, issue: any) =>
          total + new Set([
            String(issue.guid || '').trim(),
            ...(Array.isArray(issue.relatedGuids) ? issue.relatedGuids : String(issue.relatedGuids || '').split(/[;,\\s]+/))
              .map((value: any) => String(value).trim()).filter(Boolean),
          ]).size, 0),
        snapshots: 0,
        snapshotPolicy: 'Nenhuma imagem fictícia é incluída; o viewpoint contém câmera e componentes IFC.',
        ifcFileName: ifcSource.fileName,
      });
    },
  ],
});
