import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { registerReviewRoutes } from './review.js';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
// Railway variables can accidentally include pasted line breaks; normalize before creating headers.
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/\s+/g, '');
const BUCKET = 'bfgs-project-files';
const chunks = new Map();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const admin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}
async function requireUser(req, res, next) {
  try {
    if (!admin) return fail(res, 503, 'Backend Supabase não configurado.');
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return fail(res, 401, 'Sessão não informada.');
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) {
      // Log only Supabase's safe error metadata; never log the bearer token.
      console.error('[auth] Supabase rejected bearer token:', JSON.stringify({
        name: error?.name || null,
        code: error?.code || null,
        status: error?.status || null,
        // Supabase error messages may echo header values; never log their raw message.
      }));
      return fail(res, 401, 'Sessão inválida ou expirada.');
    }
    req.user = data.user;
    next();
  } catch (error) {
    return fail(res, 500, error.message || 'Falha ao validar sessão.');
  }
}
function mapProject(row) {
  return {
    id: row.id, name: row.name, code: row.code, client: row.client || '',
    phase: row.phase || 'Anteprojeto', status: row.status || 'Em andamento',
    owner: row.owner, createdAt: row.created_at,
  };
}
function mapFile(row) {
  return {
    id: row.id, name: row.name, size: Number(row.size || 0),
    mimeType: row.mime_type, path: row.storage_path, scope: row.scope,
    projectId: row.project_id || '', kind: row.kind, owner: row.owner,
    createdAt: row.created_at,
  };
}
async function ownedProject(userId, projectId) {
  if (!projectId) return null;
  const { data, error } = await admin.from('bfgs_projects')
    .select('*').eq('id', projectId).eq('owner', userId).maybeSingle();
  if (error) throw error;
  return data;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bfgs-project-intelligence-api', supabaseConfigured: Boolean(admin) });
});

app.get('/api/projects', requireUser, async (req, res) => {
  const { data, error } = await admin.from('bfgs_projects').select('*')
    .eq('owner', req.user.id).order('created_at', { ascending: false });
  if (error) return fail(res, 500, error.message);
  return res.json({ projects: (data || []).map(mapProject) });
});

app.post('/api/projects', requireUser, async (req, res) => {
  const { name, code, client = '', phase = 'Anteprojeto' } = req.body || {};
  if (!String(name || '').trim() || !String(code || '').trim()) {
    return fail(res, 400, 'Nome e código do projeto são obrigatórios.');
  }
  const { data, error } = await admin.from('bfgs_projects').insert({
    name: String(name).trim(), code: String(code).trim(), client: String(client || ''),
    phase: String(phase || 'Anteprojeto'), status: 'Em andamento', owner: req.user.id,
  }).select('*').single();
  if (error) return fail(res, 500, error.message);
  return res.status(201).json({ project: mapProject(data) });
});

app.get('/api/files', requireUser, async (req, res) => {
  const { data, error } = await admin.from('bfgs_files').select('*')
    .eq('owner', req.user.id).order('created_at', { ascending: false });
  if (error) return fail(res, 500, error.message);
  return res.json({ files: (data || []).map(mapFile) });
});

app.post('/api/files/chunk', requireUser, async (req, res) => {
  const body = req.body || {};
  const { scope, projectId = '', fileId, fileName, mimeType, partIndex, totalParts, content } = body;
  if (!['project', 'library'].includes(scope) || !fileId || !fileName ||
      !Number.isInteger(partIndex) || !Number.isInteger(totalParts) ||
      totalParts < 1 || totalParts > 2000 || partIndex < 0 || partIndex >= totalParts ||
      typeof content !== 'string') {
    return fail(res, 400, 'Dados do bloco de arquivo inválidos.');
  }
  if (scope === 'project') {
    const project = await ownedProject(req.user.id, projectId);
    if (!project) return fail(res, 404, 'Projeto não encontrado ou sem permissão.');
  }
  const key = req.user.id + ':' + fileId;
  let entry = chunks.get(key);
  if (!entry) {
    entry = { scope, projectId, fileName, mimeType: mimeType || 'application/octet-stream',
      totalParts, parts: new Map(), kind: String(body.kind || 'Arquivo'), createdAt: Date.now() };
    chunks.set(key, entry);
  }
  if (entry.fileName !== fileName || entry.totalParts !== totalParts || entry.scope !== scope) {
    return fail(res, 409, 'Os blocos enviados não pertencem ao mesmo arquivo.');
  }
  entry.parts.set(partIndex, Buffer.from(content, 'base64'));
  return res.json({ ok: true, received: entry.parts.size, totalParts });
});

app.post('/api/files/complete', requireUser, async (req, res) => {
  const body = req.body || {};
  const { scope, projectId = '', fileId, fileName, mimeType, totalParts } = body;
  const key = req.user.id + ':' + fileId;
  const entry = chunks.get(key);

  if (!entry || entry.parts.size !== totalParts || entry.totalParts !== totalParts) {
    return fail(res, 409, 'Envio incompleto: faltam blocos do arquivo.');
  }
  if (
    scope !== entry.scope ||
    String(projectId || '') !== String(entry.projectId || '') ||
    String(fileName || entry.fileName) !== entry.fileName ||
    String(body.kind || entry.kind) !== entry.kind ||
    !['project', 'library'].includes(scope)
  ) {
    return fail(res, 409, 'Os dados de finalização não correspondem ao arquivo enviado.');
  }

  const uploadedPaths = [];
  const insertedIds = [];
  try {
    if (scope === 'project' && !(await ownedProject(req.user.id, projectId))) {
      return fail(res, 404, 'Projeto não encontrado ou sem permissão.');
    }

    const ordered = [];
    for (let i = 0; i < totalParts; i++) {
      const part = entry.parts.get(i);
      if (!part) return fail(res, 409, 'Bloco ' + i + ' ausente.');
      ordered.push(part);
    }

    const original = Buffer.concat(ordered);
    const originalName = entry.fileName;
    const kind = entry.kind;
    const maxBytes = 512 * 1024 * 1024;
    if (!original.length || original.length > maxBytes) {
      return fail(res, 413, 'Arquivo vazio ou maior que o limite de 512 MB.');
    }

    let candidates = [{ name: originalName, buffer: original, kind }];
    if (kind === 'DXF' && /\\.zip$/i.test(originalName)) {
      const archive = await JSZip.loadAsync(original);
      const entries = Object.values(archive.files).filter(file => !file.dir && /\\.dxf$/i.test(file.name));
      if (!entries.length) return fail(res, 400, 'O ZIP não contém arquivos DXF.');
      if (entries.length > 200) return fail(res, 413, 'O pacote excede o limite de 200 arquivos DXF.');
      candidates = [];
      let expandedBytes = 0;
      for (const file of entries) {
        const buffer = await file.async('nodebuffer');
        expandedBytes += buffer.length;
        if (expandedBytes > maxBytes) {
          return fail(res, 413, 'O conteúdo extraído do ZIP ultrapassa 512 MB.');
        }
        candidates.push({
          name: file.name.split('/').pop() || 'arquivo.dxf',
          buffer,
          kind: 'DXF',
        });
      }
    } else if (kind === 'DXF' && !/\\.dxf$/i.test(originalName)) {
      return fail(res, 400, 'Envie um DXF ou ZIP contendo um ou mais DXFs.');
    }

    const inserted = [];
    for (const item of candidates) {
      const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140);
      const storagePath = req.user.id + '/' +
        (scope === 'project' ? projectId : 'library') + '/' +
        crypto.randomUUID() + '-' + safeName;
      const contentType = item.kind === 'DXF'
        ? 'application/dxf'
        : mimeType || entry.mimeType || 'application/octet-stream';

      const { error: uploadError } = await admin.storage.from(BUCKET)
        .upload(storagePath, item.buffer, { contentType, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPaths.push(storagePath);

      const { data, error } = await admin.from('bfgs_files').insert({
        name: item.name,
        size: item.buffer.length,
        mime_type: contentType,
        storage_path: storagePath,
        scope,
        project_id: scope === 'project' ? projectId : null,
        kind: item.kind,
        owner: req.user.id,
        sha256: crypto.createHash('sha256').update(item.buffer).digest('hex'),
      }).select('*').single();

      if (error) throw error;
      insertedIds.push(data.id);
      inserted.push(mapFile(data));
    }

    chunks.delete(key);
    return res.status(201).json({
      files: inserted,
      file: inserted[0],
      expandedArchive: candidates.length > 1,
    });
  } catch (error) {
    if (insertedIds.length) {
      await admin.from('bfgs_files').delete().in('id', insertedIds).eq('owner', req.user.id);
    }
    if (uploadedPaths.length) {
      await admin.storage.from(BUCKET).remove(uploadedPaths);
    }
    return fail(res, 500, error.message || 'Falha ao finalizar armazenamento.');
  }
});
app.post('/api/files/delete', requireUser, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0,200) : (req.body?.fileId ? [String(req.body.fileId)] : []);
  const projectId = String(req.body?.projectId || '');
  if (!ids.length) return fail(res, 400, 'Selecione ao menos um arquivo.');
  const { data: files, error: findError } = await admin.from('bfgs_files').select('*').in('id',ids).eq('owner',req.user.id);
  if (findError) return fail(res,500,findError.message);
  const owned = (files || []).filter(f => !projectId || (f.scope==='project' && f.project_id===projectId));
  if (owned.length !== ids.length) return fail(res,404,'Não foi possível localizar todos os arquivos selecionados neste projeto.');
  const { error: storageError } = await admin.storage.from(BUCKET).remove(owned.map(f=>f.storage_path));
  if (storageError) return fail(res,500,storageError.message);
  const { error: deleteError } = await admin.from('bfgs_files').delete().in('id',ids).eq('owner',req.user.id);
  if (deleteError) return fail(res,500,deleteError.message);
  return res.json({ok:true,deleted:ids.length,message:ids.length+' arquivo(s) excluído(s) com sucesso.'});
});

registerReviewRoutes(app, { admin, requireUser, fail });

app.post('/api/review/executive', requireUser, (_req, res) => fail(res, 501, 'A revisão executiva com IA ainda depende da migração do serviço de análise.'));
app.use(express.static('dist'));
app.use((req,res,next) => { if(req.method!=='GET'||req.path.startsWith('/api/')||req.path==='/health') return next(); res.sendFile(process.cwd()+'/dist/index.html'); });

app.use((error, _req, res, _next) => {
  console.error(error);
  return fail(res, 500, 'Erro interno do servidor.');
});

app.listen(PORT, () => console.log('BFGS API listening on port ' + PORT));
