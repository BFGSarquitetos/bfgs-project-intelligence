import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { parseDxf, parseIfc } from './review.js';

const BUCKET = 'bfgs-project-files';
const now = () => new Date().toISOString();
const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const unique = values => [...new Set(values)];
const dimText = value => String(value || '').replace(/\s+/g, ' ').trim();

async function getProjectFiles(admin, userId, projectId) {
  const { data: project, error: pe } = await admin.from('bfgs_projects')
    .select('*').eq('id', projectId).eq('owner', userId).maybeSingle();
  if (pe) throw pe;
  if (!project) { const e = new Error('Projeto não encontrado ou sem permissão.'); e.status = 404; throw e; }
  const { data: files, error } = await admin.from('bfgs_files').select('*')
    .eq('owner', userId).eq('scope', 'project').eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return { project, files: files || [] };
}
async function readBytes(admin, file) {
  const { data, error } = await admin.storage.from(BUCKET).download(file.storage_path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}
function extractDimensionRecords(text) {
  const lines = text.split(/\r?\n/), result = [];
  let current = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1].trimEnd();
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      if (current?.type === 'DIMENSION') {
        const pairs = current.pairs;
        const get = n => pairs.filter(p => p[0] === n).map(p => p[1]);
        const raw = get(1).join('') || get(42).join('');
        const measured = Number(get(42)[0]);
        result.push({
          type: get(70)[0] || '',
          block: get(2)[0] || '',
          override: dimText(raw),
          measured: Number.isFinite(measured) ? measured : null,
          style: get(3)[0] || '',
          layer: get(8)[0] || '0'
        });
      }
      current = { type: value.trim(), pairs: [] };
    } else if (current) current.pairs.push([code, value]);
  }
  if (current?.type === 'DIMENSION') {
    const pairs = current.pairs, get = n => pairs.filter(p => p[0] === n).map(p => p[1]);
    const measured = Number(get(42)[0]);
    result.push({ type: get(70)[0] || '', block: get(2)[0] || '', override: dimText(get(1).join('') || get(42).join('')), measured: Number.isFinite(measured) ? measured : null, style: get(3)[0] || '', layer: get(8)[0] || '0' });
  }
  return result;
}
function extractNumericNotes(texts) {
  const out = [];
  for (const text of texts) {
    const s = dimText(text);
    if (/\b(?:cota|dimens[aã]o|largura|altura|comprimento|\d+(?:[.,]\d+)\s*(?:mm|cm|m)\b)/i.test(s)) {
      const nums = s.match(/\d+(?:[.,]\d+)?\s*(?:mm|cm|m)?/gi) || [];
      if (nums.length) out.push({ text: s, values: nums.join(' | ') });
    }
  }
  return out;
}
function addFinding(list, item) {
  const key = [item.analysis || item.title, item.source, item.status].join('|');
  if (!list.some(x => [x.analysis || x.title, x.source, x.status].join('|') === key)) list.push(item);
}
function workbookBase64(project, docs, ifc, findings, dims, textRows) {
  const wb = XLSX.utils.book_new();
  const sheet = (name, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map(wch => ({ wch }));
    ws['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_col(rows[0].length - 1) + Math.max(1, rows.length) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const high = findings.filter(x => x.severity === 'Alta' || x.severity === 'Crítica').length;
  sheet('Resumo', [
    ['BFGS PROJECT INTELLIGENCE — REVISÃO DOCUMENTAL DXF'],
    ['Projeto', project.name], ['Código', project.code], ['Cliente', project.client || 'Não informado'],
    ['Fase', project.phase || 'Não informada'], ['Data da análise', now()],
    ['DXFs lidos', docs.length], ['Entidades DXF', docs.reduce((n, d) => n + d.entityCount, 0)],
    ['Entidades DIMENSION nativas', dims.length], ['Elementos IFC com GUID', ifc.elements.length],
    ['Classes IFC distintas', unique(ifc.elements.map(x => x.ifcClass)).length],
    ['Apontamentos / alertas', findings.length], ['Alta / crítica', high],
    [], ['CRITÉRIO'], ['A análise automática registra evidências estruturais e cruzamentos rastreáveis. Não substitui validação visual, normativa ou conferência geométrica especializada.'],
    ['LIMITAÇÃO IFC', ifc.header || 'Cabeçalho de exportação não identificado no arquivo.']
  ], [36, 110]);
  sheet('Incompatibilidades', [
    ['ID','Classificação','Gravidade','Disciplina','Documento / referência','Evidência','Análise','Ação recomendada','Status'],
    ...findings.map((x,i)=>['BFGS-'+String(i+1).padStart(3,'0'),x.kind,x.severity,x.discipline,x.source,x.evidence,x.analysis,x.action,x.status])
  ], [16,24,14,20,36,65,65,60,28]);
  sheet('Inventário DXF', [
    ['Arquivo','Unidades','Versão','Entidades','Layers','Textos','DIMENSION nativas','XREF / Raster','Tipo de entidade','Quantidade'],
    ...docs.flatMap(d => [
      [d.name,d.units,d.version,d.entityCount,d.layerCount,d.textCount,d.dimensions.length,d.references.join(' | '),'',''],
      ...d.entityCounts.map(x=>['','','','','','','','',x[0],x[1]])
    ])
  ], [34,18,16,16,12,14,20,48,28,14]);
  sheet('Cotas DXF', [
    ['Arquivo','Layer','Tipo DIMENSION','Texto / override','Medida real (unidade DXF)','Bloco','Estilo'],
    ...dims.map(x=>[x.file,x.layer,x.type,x.override,x.measured,x.block,x.style])
  ], [34,18,18,34,28,24,20]);
  sheet('Textos e números DXF', [
    ['Arquivo','Texto extraído','Números identificados'],
    ...textRows.map(x=>[x.file,x.text,x.values])
  ], [34,100,48]);
  sheet('Inventário IFC', [
    ['STEP ID','Classe IFC','GlobalId','Nome'],
    ...ifc.elements.map(x=>[x.stepId,x.ifcClass,x.guid,x.name])
  ], [14,32,28,70]);
  const classes = Object.entries(ifc.elements.reduce((o,x)=>{o[x.ifcClass]=(o[x.ifcClass]||0)+1;return o;},{})).sort((a,b)=>b[1]-a[1]);
  sheet('Classes IFC', [['Classe IFC','Quantidade'],...classes], [36,18]);
  sheet('Limitações', [
    ['Tema','Resultado','Impacto'],
    ['Cotas DXF', dims.length ? 'Foram lidas entidades DIMENSION nativas e seus valores de medida quando presentes.' : 'Nenhuma entidade DIMENSION nativa reconhecida nos DXFs.', 'Cotas explodidas em linhas/textos exigem interpretação adicional e não são equivalentes a cotas nativas.'],
    ['Geometria IFC','O extrator identifica classe, GUID e nome dos elementos IFC.', 'Esta versão não executa colisão geométrica 3D nem reconstrói sólidos/aberturas.'],
    ['Quantitativos IFC','Quantidades só são comparáveis se propriedades/quantidades estiverem exportadas no IFC.', 'Ausência de propriedade não significa divergência.'],
    ['Análise normativa','Itens legais, acessibilidade, segurança e aprovação exigem validação profissional.', 'Não emitir aprovação normativa automática.'],
    ['Documentos ausentes','A análise utiliza somente os arquivos armazenados neste projeto.', 'Arquivo não enviado é registrado como não disponível, nunca presumido conforme.']
  ], [26,80,85]);
  return XLSX.write(wb,{type:'base64',bookType:'xlsx'});
}

export function registerIntegratedReviewRoutes(app, { admin, requireUser, fail }) {
  app.post('/api/review/complete', requireUser, async (req,res) => {
    try {
      const { project, files } = await getProjectFiles(admin, req.user.id, String(req.body?.projectId || ''));
      const dxfFiles = files.filter(f => /\.dxf$/i.test(f.name) || f.kind === 'DXF');
      const ifcFiles = files.filter(f => /\.(ifc|ifczip)$/i.test(f.name) || f.kind === 'IFC');
      if (!dxfFiles.length) return fail(res,400,'Envie ao menos um DXF para iniciar a análise documental.');
      const docs=[], allDims=[], textRows=[], findings=[], limitations=[];
      for (const file of dxfFiles) {
        try {
          const bytes=await readBytes(admin,file), source=bytes.toString('latin1'), parsed=parseDxf(source);
          const dimensions=extractDimensionRecords(source);
          const refs=[...(parsed.findings||[]).filter(x=>/refer[eê]ncia|raster/i.test(x.title)).map(x=>x.source)];
          docs.push({name:file.name,units:parsed.units,version:parsed.version,entityCount:parsed.entityCount,layerCount:parsed.layerCount,textCount:parsed.textEntities,dimensions,entityCounts:parsed.entityCounts||[],references:refs,texts:parsed.texts||[]});
          for (const dim of dimensions) allDims.push({...dim,file:file.name});
          for (const note of extractNumericNotes(parsed.texts||[])) textRows.push({file:file.name,...note});
          for (const finding of parsed.findings||[]) addFinding(findings,{kind:'Sinal estrutural DXF',severity:finding.severity||'Baixa',discipline:'A identificar',source:file.name,evidence:finding.source||finding.title,analysis:finding.title,action:finding.recommendation||'Conferir no arquivo de origem.',status:finding.status||'Conferência necessária'});
          const placeholders=(parsed.texts||[]).filter(t=>/A DEFINIR|TBD|MDF\s*XX|MODELO\s*A\s*DEFINIR|\bXX\b/i.test(t));
          if(placeholders.length) addFinding(findings,{kind:'Pendência documental',severity:'Média',discipline:'A identificar',source:file.name,evidence:unique(placeholders).slice(0,20).join(' | '),analysis:'Texto provisório ou campo não definido identificado no DXF.',action:'Completar a especificação e conferir as pranchas relacionadas.',status:'Confirmado no texto extraído'});
        } catch(e) { limitations.push(file.name+': falha de leitura ('+String(e.message||'erro')+').'); }
      }
      // A revisão documental é exclusivamente DXF. O IFC é lido separadamente
      // apenas no fluxo de compatibilização/geração BCF.
      const ifc={projectGuid:'',elements:[]};
      const header='IFC não utilizado nesta etapa. O modelo BIM é reservado para o fluxo BCF.';
      const excel=workbookBase64(project,docs,{...ifc,header},findings,allDims,textRows);
      return res.json({
        project:{name:project.name,code:project.code,phase:project.phase},
        dxfCount:docs.length,ifcFile:null,ifcElements:0,
        dimensions:allDims.length,findings,limitations,base64:excel,
        generatedAt:now(),status:'analysis_complete',
        message:'Revisão documental DXF concluída. O IFC não é necessário nesta etapa e será utilizado somente para vincular elementos e gerar BCF.'
      });
    } catch(e) {
      console.error('[integrated-review]', JSON.stringify({message:e.message||'unknown'}));
      return fail(res,e.status||500,e.message||'Falha ao executar análise integrada.');
    }
  });
}
