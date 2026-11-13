import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseDxf } from './review.js';

const BUCKET = 'bfgs-project-files';
const now = () => new Date().toISOString();
const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
const unique = values => [...new Set(values)];
const clean = value => String(value || '').replace(/\s+/g,' ').trim();

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
  const flush = () => {
    if (current?.type !== 'DIMENSION') return;
    const pairs = current.pairs, get = n => pairs.filter(p => p[0] === n).map(p => p[1]);
    const raw = get(1).join('') || get(42).join('');
    const measured = Number(get(42)[0]);
    result.push({ type:get(70)[0] || '', block:get(2)[0] || '', override:clean(raw),
      measured:Number.isFinite(measured) ? measured : null, style:get(3)[0] || '', layer:get(8)[0] || '0' });
  };
  for (let i=0;i+1<lines.length;i+=2) {
    const code=Number(lines[i].trim()), value=lines[i+1].trimEnd();
    if (!Number.isFinite(code)) continue;
    if (code===0) { flush(); current={type:value.trim(),pairs:[]}; }
    else if(current) current.pairs.push([code,value]);
  }
  flush();
  return result;
}
function extractChecklistRows(checklist, docs) {
  const allTexts = docs.flatMap(d => d.texts.map(text => ({file:d.name,text,normalized:norm(text)})));
  const rows = [];
  for (const section of checklist.sections || []) {
    for (const item of section.items || []) {
      const words = norm(item).split(' ').filter(w => w.length >= 4 && !['para','quando','entre','todos','todas','tipo','nome','dados'].includes(w));
      const matches = allTexts.map(t => {
        const exact = t.normalized.includes(norm(item));
        const hits = words.filter(w => t.normalized.includes(w));
        return {...t,score: exact ? 1 : (words.length ? hits.length / words.length : 0),hits};
      }).filter(t => t.score >= 0.45 || (t.score >= 0.3 && t.hits.length >= 2))
        .sort((a,b)=>b.score-a.score).slice(0,5);
      rows.push({
        section:section.title, item,
        status:matches.length ? 'Indício textual localizado' : 'Não localizado no texto extraído',
        evidence:matches.map(m=>m.file+': '+m.text.slice(0,500)).join(' | '),
        note:matches.length
          ? 'A ocorrência textual não comprova atendimento do requisito; conferir conteúdo gráfico, dimensões e contexto.'
          : 'A ausência no texto extraído não comprova ausência na prancha; exige conferência visual.'
      });
    }
  }
  return rows;
}
function workbookBase64(project, docs, findings, dims, checklistRows, textRows) {
  const wb = XLSX.utils.book_new();
  const sheet = (name, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map(wch => ({ wch }));
    if (rows.length > 1) ws['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_col(rows[0].length - 1) + rows.length };
    ws['!freeze'] = {xSplit:0,ySplit:1};
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const count = status => findings.filter(x=>x.status===status).length;
  const checklistFound = checklistRows.filter(x=>x.status==='Indício textual localizado').length;
  const checklistNotFound = checklistRows.length-checklistFound;
  const high = findings.filter(x => ['Alta','Crítica'].includes(x.severity)).length;
  sheet('Resumo', [
    ['BFGS PROJECT INTELLIGENCE — REVISÃO DOCUMENTAL DXF'],
    ['Projeto', project.name], ['Código', project.code], ['Cliente', project.client || 'Não informado'],
    ['Fase', project.phase || 'Não informada'], ['Data da análise', now()],
    ['DXFs analisados', docs.length], ['Entidades lidas', docs.reduce((n,d)=>n+d.entityCount,0)],
    ['Layers identificados', unique(docs.flatMap(d=>d.layerCounts.map(x=>x[0]))).length],
    ['Textos interpretados', docs.reduce((n,d)=>n+d.texts.length,0)],
    ['Cotas DIMENSION nativas', dims.length],
    ['Itens do Checklist BFGS avaliados por evidência textual', checklistRows.length],
    ['Itens com indício textual', checklistFound], ['Itens sem indício textual extraído', checklistNotFound],
    ['Apontamentos documentais', findings.length], ['Gravidade alta/crítica', high],
    [], ['ESCOPO E CRITÉRIO'],
    ['A análise cruza evidências textuais e estruturais dos DXFs com o Checklist BFGS. “Indício textual localizado” não equivale a conformidade.'],
    ['Itens não encontrados no texto não são tratados como falha: podem estar representados graficamente e exigem conferência visual.'],
    ['Não são realizadas nesta etapa aprovação normativa, leitura visual integral, medição de geometria em tela ou colisão entre modelos.'],
    ['IFC', 'Não é recebido nem utilizado na revisão documental DXF.']
  ], [48,110]);
  sheet('Apontamentos', [
    ['ID','Tipo','Gravidade','Arquivo','Evidência extraída','Interpretação','Ação recomendada','Status'],
    ...findings.map((x,i)=>['BFGS-'+String(i+1).padStart(3,'0'),x.kind,x.severity,x.source,x.evidence,x.analysis,x.action,x.status])
  ], [16,28,14,38,70,70,70,34]);
  sheet('Checklist BFGS', [
    ['Seção','Requisito do checklist','Resultado da busca textual','Evidência localizada','Orientação de validação'],
    ...checklistRows.map(x=>[x.section,x.item,x.status,x.evidence,x.note])
  ], [34,62,34,100,90]);
  sheet('Inventário DXF', [
    ['Arquivo','Unidades','Versão','Entidades','Layers','Textos','Cotas nativas','XREFs','Rasters','Disciplinas reconhecidas'],
    ...docs.map(d=>[d.name,d.units,d.version,d.entityCount,d.layerCount,d.textCount,d.dimensions.length,d.xrefs.join(' | '),d.rasters.join(' | '),d.disciplineEvidence.map(x=>x.discipline).join(', ')])
  ], [38,18,16,14,12,12,16,45,45,55]);
  sheet('Cotas DXF', [
    ['Arquivo','Layer','Tipo DIMENSION','Texto / override','Medida (unidade DXF)','Bloco','Estilo'],
    ...dims.map(x=>[x.file,x.layer,x.type,x.override,x.measured,x.block,x.style])
  ], [38,18,18,42,28,24,20]);
  sheet('Evidências textuais', [
    ['Arquivo','Texto interpretado'],
    ...textRows.map(x=>[x.file,x.text])
  ], [38,140]);
  sheet('Layers e entidades', [
    ['Arquivo','Tipo de registro','Nome','Quantidade'],
    ...docs.flatMap(d=>[
      ...d.layerCounts.map(x=>[d.name,'Layer',x[0],x[1]]),
      ...d.entityCounts.map(x=>[d.name,'Entidade',x[0],x[1]])
    ])
  ], [38,18,45,16]);
  sheet('Referências externas', [
    ['Arquivo','Tipo','Referência','Ação'],
    ...docs.flatMap(d=>[
      ...d.xrefs.map(x=>[d.name,'XREF',x,'Confirmar se o arquivo referenciado acompanha a entrega.']),
      ...d.rasters.map(x=>[d.name,'Raster',x,'Confirmar incorporação ou envio do arquivo externo.'])
    ])
  ], [38,16,65,70]);
  sheet('Limitações', [
    ['Tema','Resultado','Impacto'],
    ['Leitura textual','Textos DXF são normalizados para remover códigos de formatação antes da busca.','Textos em blocos, atributos especiais ou fontes SHX podem exigir validação no CAD.'],
    ['Checklist','Busca de indícios textuais por requisito do Checklist BFGS.','Não comprova dimensões, posicionamento, legibilidade ou atendimento gráfico.'],
    ['Cotas','Leitura de entidades DIMENSION nativas.','Cotas explodidas podem não ser reconhecidas como dimensão; não são consideradas ausentes por isso.'],
    ['Geometria','Inventário de entidades, layers e referências.','Não executa medição geométrica completa nem detecção de colisões.'],
    ['Normas e legislação','Itens normativos são relacionados pelo checklist quando aplicáveis.','Exige análise profissional com legislação e normas vigentes.'],
    ['Documentos ausentes','A análise utiliza somente os DXFs armazenados no projeto.','Não presume conformidade de disciplinas ou arquivos não enviados.']
  ], [28,90,90]);
  return XLSX.write(wb,{type:'base64',bookType:'xlsx'});
}

export function registerIntegratedReviewRoutes(app, { admin, requireUser, fail }) {
  app.post('/api/review/complete', requireUser, async (req,res) => {
    try {
      const { project, files } = await getProjectFiles(admin, req.user.id, String(req.body?.projectId || ''));
      const dxfFiles = files.filter(f => /\.dxf$/i.test(f.name) || f.kind === 'DXF');
      if (!dxfFiles.length) return fail(res,400,'Envie ao menos um DXF para iniciar a revisão documental.');
      const checklistPath = path.join(process.cwd(),'config','checklist-bfgs-revisao-02.json');
      const checklist = JSON.parse(await fs.readFile(checklistPath,'utf8'));
      const docs=[], allDims=[], findings=[], limitations=[], textRows=[];
      for (const file of dxfFiles) {
        try {
          const bytes=await readBytes(admin,file), source=bytes.toString('latin1'), parsed=parseDxf(source);
          const dimensions=extractDimensionRecords(source);
          docs.push({
            name:file.name,units:parsed.units,version:parsed.version,entityCount:parsed.entityCount,
            layerCount:parsed.layerCount,textCount:parsed.textEntities,dimensions,
            entityCounts:parsed.entityCounts||[],layerCounts:parsed.layerCounts||[],texts:parsed.texts||[],
            xrefs:parsed.xrefs||[],rasters:parsed.rasters||[],disciplineEvidence:parsed.disciplineEvidence||[],
            titleBlockEvidence:parsed.titleBlockEvidence||[],scaleMatches:parsed.scaleMatches||[],dateMatches:parsed.dateMatches||[]
          });
          for (const dim of dimensions) allDims.push({...dim,file:file.name});
          for (const text of parsed.texts||[]) textRows.push({file:file.name,text});
          for (const finding of parsed.findings||[]) {
            const key=[finding.title,file.name,finding.source].join('|');
            if(!findings.some(x=>x.key===key)) findings.push({
              key,kind:'Verificação de arquivo',severity:finding.severity||'Informativa',
              source:file.name,evidence:finding.source||finding.title,analysis:finding.title,
              action:finding.recommendation||'Conferir no arquivo de origem.',status:finding.status||'Conferência necessária'
            });
          }
          const textNorm=(parsed.texts||[]).map(norm);
          const placeholders=(parsed.texts||[]).filter(t=>/\b(?:A DEFINIR|MODELO A DEFINIR|TBD|PENDENTE|XXXX+)\b/i.test(t)||/\b(?:D|E|J|P|R)-XX\b/i.test(t));
          if(placeholders.length) {
            const evidence=unique(placeholders).slice(0,25).join(' | ');
            const key=['Campos provisórios',file.name,evidence].join('|');
            if(!findings.some(x=>x.key===key)) findings.push({
              key,kind:'Pendência documental',severity:'Média',source:file.name,evidence,
              analysis:'Foram encontrados campos ou especificações explicitamente provisórios.',
              action:'Verificar a aplicabilidade à fase do projeto e completar os campos antes da emissão final.',
              status:'Possível pendência — validar fase'
            });
          }
          const scales=parsed.scaleMatches||[];
          if(scales.length>1 && unique(scales.map(norm)).length>1) findings.push({
            key:'scale-'+file.name,kind:'Consistência documental',severity:'Baixa',source:file.name,
            evidence:unique(scales).join(' | '),analysis:'Foram identificadas indicações textuais de escala diferentes na mesma prancha.',
            action:'Conferir se as escalas distintas correspondem a vistas/detalhes diferentes ou se há divergência no carimbo.',
            status:'Possível divergência — requer conferência'
          });
          if(!parsed.texts.length) limitations.push(file.name+': nenhum texto legível foi extraído; revisão textual insuficiente.');
        } catch(e) {
          limitations.push(file.name+': falha de leitura ('+String(e.message||'erro')+'). O arquivo foi excluído dos apontamentos.');
        }
      }
      if(!docs.length) return fail(res,422,'Nenhum DXF pôde ser interpretado. Verifique os arquivos e tente novamente.');
      const checklistRows=extractChecklistRows(checklist,docs);
      const excel=workbookBase64(project,docs,findings,allDims,checklistRows,textRows);
      return res.json({
        project:{name:project.name,code:project.code,phase:project.phase},
        dxfCount:docs.length,dimensions:allDims.length,findings:findings.map(({key,...x})=>x),
        checklist:{total:checklistRows.length,textualEvidence:checklistRows.filter(x=>x.status==='Indício textual localizado').length,notLocated:checklistRows.filter(x=>x.status!=='Indício textual localizado').length},
        limitations,base64:excel,generatedAt:now(),status:'analysis_complete',
        message:'Revisão documental DXF concluída com leitura textual normalizada, inventário técnico e cruzamento de evidências com o Checklist BFGS. Os indícios não substituem conferência gráfica.'
      });
    } catch(e) {
      console.error('[integrated-review]', JSON.stringify({message:e.message||'unknown'}));
      return fail(res,e.status||500,e.message||'Falha ao executar revisão documental DXF.');
    }
  });
}