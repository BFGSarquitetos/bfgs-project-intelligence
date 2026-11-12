import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { parseDxf, parseIfc } from './review.js';

const BUCKET = 'bfgs-project-files';
const MAX_TEXT = 90000;

function outputText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  return (payload.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text).join('\n');
}

async function readStoredFile(admin, row) {
  const { data, error } = await admin.storage.from(BUCKET).download(row.storage_path);
  if (error) throw error;
  const bytes = Buffer.from(await data.arrayBuffer());
  const ext = path.extname(row.name).toLowerCase();
  if (ext === '.dxf') {
    const parsed = parseDxf(bytes.toString('latin1'));
    return { name: row.name, type: 'DXF', extracted: true, evidence: {
      version: parsed.version, units: parsed.units, entityCount: parsed.entityCount,
      layerCounts: parsed.layerCounts.slice(0, 100), entityCounts: parsed.entityCounts.slice(0, 60),
      dimensionCount: parsed.dimensionCount, textEntities: parsed.textEntities,
      findings: parsed.findings, textSamples: parsed.texts.slice(0, 100)
    }};
  }
  if (ext === '.ifc' || ext === '.ifczip' || ext === '.zip') {
    let source = bytes.toString('utf8');
    let sourceName = row.name;
    if (ext !== '.ifc') {
      const zip = await JSZip.loadAsync(bytes);
      const files = Object.values(zip.files).filter(f => !f.dir && /\.ifc$/i.test(f.name));
      if (!files.length) return { name: row.name, type: 'IFC/ZIP', extracted: false, limitation: 'Pacote sem arquivo IFC.' };
      if (files.length > 1) return { name: row.name, type: 'IFC/ZIP', extracted: false, limitation: 'Pacote contém mais de um IFC; análise individual necessária.' };
      source = await files[0].async('string');
      sourceName = files[0].name;
    }
    const parsed = parseIfc(source);
    const classes = {};
    for (const element of parsed.elements) classes[element.ifcClass] = (classes[element.ifcClass] || 0) + 1;
    return { name: row.name, type: 'IFC', extracted: true, evidence: {
      sourceName, projectGuid: parsed.projectGuid, totalElements: parsed.elements.length,
      classCounts: Object.entries(classes).sort((a,b) => b[1]-a[1]).slice(0,100),
      elementsSample: parsed.elements.slice(0,250)
    }};
  }
  return { name: row.name, type: ext.replace('.','').toUpperCase() || 'Arquivo', extracted: false,
    limitation: 'Formato ainda não possui extrator textual nesta versão; o arquivo está armazenado, mas seu conteúdo não foi interpretado.' };
}

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    executiveSummary: { type: 'string' },
    crossChecks: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { pair: {type:'string'}, result:{type:'string'}, evidence:{type:'string'} },
      required:['pair','result','evidence'] } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        id:{type:'string'}, title:{type:'string'}, description:{type:'string'},
        status:{type:'string',enum:['confirmada','possivel','pendencia_informacao','problema_arquivo_diagnostico']},
        severity:{type:'string',enum:['critica','alta','media','baixa','informativa']},
        discipline:{type:'string'}, checklistSection:{type:'string'}, checklistItem:{type:'string'},
        documents:{type:'array',items:{type:'string'}}, evidence:{type:'string'},
        impact:{type:'string'}, recommendation:{type:'string'}, verificationMode:{type:'string',enum:['automatica','cruzada','normativa','visual_tecnica']}
      },
      required:['id','title','description','status','severity','discipline','checklistSection','checklistItem','documents','evidence','impact','recommendation','verificationMode']
    }},
    limitations:{type:'array',items:{type:'string'}},
    warning:{type:'string'}
  },
  required:['executiveSummary','crossChecks','findings','limitations','warning']
};

export async function runExecutiveReview({ admin, userId, projectId }) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('A análise integrada está preparada, mas falta configurar OPENAI_API_KEY nas variáveis do Railway.');
    error.status = 503; throw error;
  }
  const { data: project, error: projectError } = await admin.from('bfgs_projects')
    .select('*').eq('id', projectId).eq('owner', userId).maybeSingle();
  if (projectError) throw projectError;
  if (!project) { const error = new Error('Projeto não encontrado ou sem permissão.'); error.status=404; throw error; }
  const { data: rows, error: filesError } = await admin.from('bfgs_files').select('*')
    .eq('owner', userId).eq('scope','project').eq('project_id',projectId).order('created_at',{ascending:true});
  if (filesError) throw filesError;
  if (!rows?.length) { const error = new Error('Este projeto ainda não possui documentos armazenados.'); error.status=400; throw error; }
  const checklistPath = path.join(process.cwd(),'config','checklist-bfgs-revisao-02.json');
  const checklist = JSON.parse(await fs.readFile(checklistPath,'utf8'));
  const documents = [];
  const limitations = [];
  for (const row of rows.slice(0,80)) {
    try {
      const doc = await readStoredFile(admin,row);
      documents.push(doc);
      if (!doc.extracted && doc.limitation) limitations.push(row.name + ': ' + doc.limitation);
    } catch (e) {
      limitations.push(row.name + ': falha de leitura (' + String(e.message || 'erro') + '). O erro foi excluído dos apontamentos do projeto.');
    }
  }
  const input = {
    project: { name:project.name, code:project.code, client:project.client || '', phase:project.phase || '' },
    checklist,
    documents
  };
  const serialized = JSON.stringify(input);
  const clipped = serialized.length > MAX_TEXT ? serialized.slice(0,MAX_TEXT) + '\n[CONTEXTO TRUNCADO POR LIMITE DE SEGURANÇA]' : serialized;
  const instructions = [
    'Você é o revisor técnico documental do escritório BFGS Arquitetura.',
    'Use exclusivamente os dados de projeto, documentos e Checklist BFGS fornecidos. Não invente normas, dimensões, evidências ou conteúdo de arquivos não extraídos.',
    'O checklist é a referência de verificação. Considere a fase do projeto ao avaliar aplicabilidade.',
    'Só marque confirmada quando houver evidência objetiva direta. Use possivel quando houver indício, pendencia_informacao quando faltar documento/dado e problema_arquivo_diagnostico apenas para falha técnica de arquivo que impeça leitura.',
    'Não transforme ausência de extração em não conformidade do projeto. Registre-a em limitations.',
    'Para julgamento normativo, visual, acessibilidade, segurança e geometria, sinalize revisão humana e não declare aprovação.',
    'Não afirme compatibilização geométrica DXF-IFC: os dados fornecidos são resumos estruturais e amostras, sem motor de colisão.',
    'Faça cruzamentos somente quando os documentos realmente fornecerem evidência compatível. Cada apontamento deve citar documento e evidência observável.',
    'Retorne JSON estruturado, conciso, em português brasileiro. Se não houver evidência suficiente, findings pode ficar vazio.'
  ].join('\n');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{'Authorization':'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({
      model:process.env.OPENAI_MODEL || 'gpt-5.5',
      input:[{role:'system',content:[{type:'input_text',text:instructions}]},{role:'user',content:[{type:'input_text',text:clipped}]}],
      text:{format:{type:'json_schema',name:'bfgs_executive_review',strict:true,schema}},
      max_output_tokens:7000
    }),
    signal:AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const details = await response.text();
    const error = new Error('O provedor de IA recusou a análise (HTTP '+response.status+'). Verifique a chave, o modelo e os limites da conta.');
    error.status = response.status === 401 || response.status === 403 ? 503 : 502;
    error.providerStatus = response.status;
    throw error;
  }
  const payload = await response.json();
  const raw = outputText(payload);
  if (!raw) { const error = new Error('O provedor não retornou uma resposta estruturada completa.'); error.status=502; throw error; }
  let result;
  try { result = JSON.parse(raw); } catch { const error = new Error('A resposta da IA não passou na validação JSON.'); error.status=502; throw error; }
  result.analyzedSourceCount = documents.filter(d=>d.extracted).length;
  result.project = { name:project.name, code:project.code, phase:project.phase };
  result.documentInventory = documents.map(d=>({name:d.name,type:d.type,extracted:d.extracted}));
  result.limitations = [...new Set([...(result.limitations||[]),...limitations])];
  result.warning = (result.warning || '') + ' A análise é assistiva e exige validação profissional; não substitui aprovação legal, normativa, visual ou compatibilização geométrica.';
  return result;
}
