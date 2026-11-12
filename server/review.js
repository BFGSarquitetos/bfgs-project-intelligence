import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import crypto from 'node:crypto';

const now = () => new Date().toISOString();
const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

export function parseDxf(text) {
  const lines = text.split(/\r?\n/), entities = [];
  let cur = null;
  for (let i=0;i+1<lines.length;i+=2) {
    const code=Number(lines[i].trim()), val=lines[i+1].trimEnd();
    if (!Number.isFinite(code)) continue;
    if (code===0) { if(cur) entities.push(cur); cur={type:val.trim(),pairs:[]}; }
    else if(cur) cur.pairs.push([code,val]);
  }
  if(cur) entities.push(cur);
  const counts={}, layers={}, texts=[], xrefs=[], rasters=[];
  let dims=0,textCount=0;
  for(const e of entities) {
    if(['SECTION','ENDSEC','EOF','TABLE','ENDTAB','ENDBLK','SEQEND'].includes(e.type)) continue;
    counts[e.type]=(counts[e.type]||0)+1;
    const layer=e.pairs.find(p=>p[0]===8)?.[1]||'0'; layers[layer]=(layers[layer]||0)+1;
    if(e.type==='DIMENSION') dims++;
    if(['TEXT','MTEXT','ATTRIB','ATTDEF'].includes(e.type)) {
      textCount++; const t=e.pairs.filter(p=>p[0]===1||p[0]===3).map(p=>p[1]).join('').replace(/\\P/g,' ').trim(); if(t) texts.push(t);
    }
    if(e.type==='IMAGE'||e.type==='IMAGEDEF'){const p=e.pairs.find(x=>x[0]===1)?.[1];if(p)rasters.push(p);}
    if(e.type==='BLOCK'){const flags=Number(e.pairs.find(p=>p[0]===70)?.[1]||0);if(flags&12)xrefs.push(e.pairs.find(p=>p[0]===1)?.[1]||'XREF sem caminho');}
  }
  const header=(key,group)=>{const at=lines.findIndex(x=>x.trim()===key);if(at<0)return '';for(let i=at+1;i<Math.min(at+8,lines.length-1);i+=2)if(Number(lines[i].trim())===group)return lines[i+1].trim();return '';};
  const version=header('$ACADVER',1), unit=Number(header('$INSUNITS',70)||0);
  const unitNames={0:'Não definida',1:'Polegadas',2:'Pés',4:'Milímetros',5:'Centímetros',6:'Metros'};
  const placeholders=texts.filter(t=>/<(NOME|DATA|CLIENTE)|TBD|A DEFINIR|REVISÃO\s*#|####|\{\{/.test(t));
  const findings=[];
  if(xrefs.length)findings.push({title:'Referências externas ainda vinculadas',severity:'Alta',status:'Corrigir antes da emissão',source:xrefs.join(', '),recommendation:'Incorporar as referências ou publicar o DXF consolidado e repetir a leitura.'});
  if(placeholders.length)findings.push({title:'Campos ou textos provisórios encontrados',severity:'Média',status:'Conferência necessária',source:placeholders.slice(0,10).join(' | '),recommendation:'Conferir carimbo, data, revisão, identificação e notas antes da emissão.'});
  if(!dims&&textCount)findings.push({title:'Cotas nativas não identificadas',severity:'Baixa',status:'Não verificável automaticamente',source:'Há textos/anotações, mas nenhuma entidade DIMENSION nativa foi reconhecida.',recommendation:'As cotas podem estar explodidas em linhas e textos. Conferir medidas críticas; não classificar ausência como erro confirmado.'});
  if(rasters.length)findings.push({title:'Referências raster vinculadas',severity:'Baixa',status:'Conferência de pacote',source:rasters.join(', '),recommendation:'Incluir imagens vinculadas no pacote ou confirmar incorporação.'});
  if(!findings.length)findings.push({title:'Leitura estrutural concluída',severity:'Informativo',status:'Sem alerta automático nesta leitura',source:'Não foram detectados XREFs ou campos provisórios pelos critérios básicos.',recommendation:'A ausência de alertas não significa aprovação técnica da prancha.'});
  return {version,units:unitNames[unit]||'Código '+unit,entityCount:Object.values(counts).reduce((a,b)=>a+b,0),layerCount:Object.keys(layers).length,dimensionCount:dims,textEntities:textCount,entityCounts:Object.entries(counts).sort((a,b)=>b[1]-a[1]),layerCounts:Object.entries(layers).sort((a,b)=>b[1]-a[1]),findings,texts:texts.slice(0,300)};
}

export function parseIfc(text) {
  const elements=[]; let projectGuid='';
  const pattern=/#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\(\s*'([0-9A-Za-z_$]{22})'\s*,\s*[^,]*,\s*('(?:[^']|'')*'|\$)/g;
  let m;
  while((m=pattern.exec(text))!==null){const ifcClass=m[2].toUpperCase(),guid=m[3],raw=m[4],name=raw==='$'?'':raw.slice(1,-1).replace(/''/g,"'");if(ifcClass==='IFCPROJECT'){if(!projectGuid)projectGuid=guid;continue;}elements.push({stepId:m[1],ifcClass,guid,name});}
  return {projectGuid,elements};
}
async function getFile(admin,userId,fileId) {
  const {data,error}=await admin.from('bfgs_files').select('*').eq('id',fileId).eq('owner',userId).maybeSingle();
  if(error)throw error;if(!data)throw new Error('Arquivo não encontrado ou sem permissão.');return data;
}
async function getBytes(admin,file) {
  const {data,error}=await admin.storage.from('bfgs-project-files').download(file.storage_path);
  if(error)throw error;return Buffer.from(await data.arrayBuffer());
}
async function ifcSource(bytes,name) {
  if(/\.(ifczip|zip)$/i.test(name)){const z=await JSZip.loadAsync(bytes);const entries=Object.values(z.files).filter(x=>!x.dir&&/\.ifc$/i.test(x.name));if(entries.length!==1)throw new Error(entries.length?'O pacote contém mais de um IFC. Envie um arquivo por vez.':'O pacote não contém um IFC.');return {text:await entries[0].async('string'),fileName:entries[0].name.split('/').pop()};}
  if(!/\.ifc$/i.test(name))throw new Error('Envie um arquivo IFC ou IFCZIP válido.');
  return {text:bytes.toString('utf8'),fileName:name};
}
function bcfXml(issue,topicId,viewId,project,index) {
  const guids=[...new Set([String(issue.guid||'').trim(),...(Array.isArray(issue.relatedGuids)?issue.relatedGuids:String(issue.relatedGuids||'').split(/[;,\s]+/)).map(v=>String(v).trim()).filter(Boolean)])];
  const priority=({'Crítica':'Critical','Alta':'Major','Média':'Normal','Baixa':'Minor','Informativo':'Trivial'})[String(issue.severity||'Média')]||'Normal';
  const desc=[String(issue.description||'').trim(),issue.elementName?'Elemento principal IFC: '+issue.elementName:'','Componentes IFC vinculados: '+guids.length,'Recibo da revisão: '+project.receipt].filter(Boolean).join('\n\n');
  const header='<Header><File'+(project.ifcProjectGuid?' IfcProject="'+esc(project.ifcProjectGuid)+'"':'')+' IsExternal="true"><Filename>'+esc(project.ifcFileName)+'</Filename></File></Header>';
  const components=guids.map((g,i)=>'<Component IfcGuid="'+esc(g)+'" Selected="'+(i===0?'true':'false')+'"><OriginatingSystem>Archicad</OriginatingSystem><AuthoringToolId>'+esc(issue.elementName||'BFGS')+'</AuthoringToolId></Component>').join('');
  const c=issue.camera||{},num=(v,d)=>Number.isFinite(Number(v))?Number(v):d;
  const cx=num(c.centerX,0),cy=num(c.centerY,0),cz=num(c.centerZ,0),dist=Math.max(1,Math.min(100000,num(c.distance,10000))),off=dist/Math.sqrt(3);
  const vx=num(c.x,cx+off),vy=num(c.y,cy-off),vz=num(c.z,cz+off),dx=cx-vx,dy=cy-vy,dz=cz-vz,len=Math.max(.000001,Math.hypot(dx,dy,dz));
  const view='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<VisualizationInfo Guid="'+viewId+'" xmlns="http://www.buildingsmart-tech.org/bcf/visinfo/2.1"><Components DefaultVisibility="true">'+components+'</Components><PerspectiveCamera><CameraViewPoint><X>'+vx+'</X><Y>'+vy+'</Y><Z>'+vz+'</Z></CameraViewPoint><CameraDirection><X>'+dx/len+'</X><Y>'+dy/len+'</Y><Z>'+dz/len+'</Z></CameraDirection><CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>60</FieldOfView></PerspectiveCamera><Lines/><ClippingPlanes/></VisualizationInfo>';
  const markup='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Markup xmlns="http://www.buildingsmart-tech.org/bcf/markup/2.1">'+header+'<Topic Guid="'+topicId+'" TopicType="Issue" TopicStatus="Open"><ReferenceLinks/><Title>'+esc(issue.title||'Apontamento BFGS')+'</Title><Priority>'+priority+'</Priority><Index>'+index+'</Index><Labels><Label>'+esc(issue.discipline||'Arquitetura')+'</Label><Label>BFGS</Label></Labels><CreationDate>'+now()+'</CreationDate><CreationAuthor>BFGS</CreationAuthor><Description>'+esc(desc||issue.title)+'</Description><Viewpoints Guid="'+viewId+'"><Viewpoint>viewpoint.bcfv</Viewpoint><Index>0</Index></Viewpoints></Topic></Markup>';
  return {markup,view,linkedComponents:guids.length};
}

export function registerReviewRoutes(app,{admin,requireUser,fail}) {
  app.post('/api/review/dxf',requireUser,async(req,res)=>{
    try{const f=await getFile(admin,req.user.id,req.body.fileId);if(f.kind!=='DXF'||f.scope!=='project'||f.project_id!==String(req.body.projectId||''))return fail(res,400,'Selecione um DXF armazenado neste projeto.');const b=await getBytes(admin,f);return res.json({report:{...parseDxf(b.toString('latin1')),fileName:f.name,projectId:f.project_id,reviewedAt:now()}});}catch(e){return fail(res,404,e.message);}
  });
  app.post('/api/review/ifc',requireUser,async(req,res)=>{
    try{const f=await getFile(admin,req.user.id,req.body.fileId);if(f.kind!=='IFC'||f.scope!=='project'||f.project_id!==String(req.body.projectId||''))return fail(res,400,'Selecione um IFC armazenado neste projeto.');const src=await ifcSource(await getBytes(admin,f),f.name),p=parseIfc(src.text);if(!p.elements.length)return fail(res,422,'Nenhum elemento com GUID válido foi identificado.');return res.json({fileName:src.fileName,projectGuid:p.projectGuid,totalElements:p.elements.length,elements:p.elements.slice(0,2000),truncated:p.elements.length>2000});}catch(e){return fail(res,400,e.message);}
  });
  app.post('/api/review/excel',requireUser,async(req,res)=>{
    const reports=Array.isArray(req.body.reports)?req.body.reports:req.body.report?[req.body.report]:[];
    if(!reports.length||reports.some(r=>!Array.isArray(r.findings)))return fail(res,400,'Nenhum relatório DXF válido foi informado.');
    const {data:p,error}=await admin.from('bfgs_projects').select('*').eq('id',req.body.projectId).eq('owner',req.user.id).maybeSingle();
    if(error||!p)return fail(res,404,'Projeto não encontrado.');
    const wb=XLSX.utils.book_new(),signals=reports.flatMap((r,i)=>r.findings.map((finding,j)=>({id:'BFGS-'+String(i+1).padStart(2,'0')+'-'+String(j+1).padStart(3,'0'),fileName:r.fileName||'Arquivo sem nome',finding})));
    const sheet=(name,rows,widths)=>{const ws=XLSX.utils.aoa_to_sheet(rows);ws['!cols']=widths.map(wch=>({wch}));if(rows.length>1)ws['!autofilter']={ref:'A1:'+XLSX.utils.encode_col(rows[0].length-1)+rows.length};XLSX.utils.book_append_sheet(wb,ws,name);};
    sheet('Capa',[['BFGS ARQUITETURA — CONTROLE DE PROJETO'],['RELATÓRIO DE REVISÃO DOCUMENTAL'],['Projeto',p.name],['Código',p.code],['Cliente',p.client||'Não informado'],['Fase',p.phase],['Emissão',now()],['DXFs analisados',reports.length],['Sinais para conferência',signals.length],[],['ESCOPO'],['Evidências estruturais extraídas dos DXFs; não representa aprovação técnica nem auditoria completa do checklist.']],[38,100]);
    sheet('Resumo',[['Indicador','Resultado'],['Projeto',p.name],['Arquivos analisados',reports.length],['Sinais automáticos',signals.length],['Não conformidades confirmadas',0],['Itens não verificáveis',signals.length],['Zero significa que não houve confirmação automática, não que o projeto esteja conforme.']],[55,100]);
    sheet('Auditoria',[['ID','Prancha/localização','Disciplina','Item checklist','Status','Verificação','Evidência','Arquivo','Padrão BFGS','Gravidade','Prioridade','Justificativa','Recomendação','BCF/GUID'],...signals.map(x=>[x.id,'Não identificada automaticamente','A confirmar','Pendente de cruzamento','Não verificável',x.finding.title,x.finding.source||'',x.fileName,'Não cruzado','Não classificada','A definir','Sinal estrutural requer validação do requisito e fase.','Conferir prancha e arquivo.','Pendente de GUID IFC'])],[18,28,24,35,20,36,55,35,35,18,20,55,50,35]);
    sheet('Sinais DXF',[['Arquivo','Sinal','Gravidade heurística','Status','Evidência','Recomendação'],...signals.map(x=>[x.fileName,x.finding.title,x.finding.severity,x.finding.status,x.finding.source,x.finding.recommendation])],[35,40,24,30,60,60]);
    sheet('Evidências DXF',[['Arquivo','Data','Versão','Unidades declaradas','Entidades','Layers','Cotas DIMENSION','Textos'],...reports.map(r=>[r.fileName,r.reviewedAt,r.version,r.units,r.entityCount,r.layerCount,r.dimensionCount,r.textEntities])],[35,24,18,22,18,18,20,18]);
    sheet('Layers',[['Arquivo','Layer','Entidades'],...reports.flatMap(r=>(r.layerCounts||[]).map(x=>[r.fileName,x[0],x[1]]))],[35,50,20]);
    sheet('Entidades',[['Arquivo','Tipo','Quantidade'],...reports.flatMap(r=>(r.entityCounts||[]).map(x=>[r.fileName,x[0],x[1]]))],[35,30,20]);
    sheet('Critérios BFGS',[['Status','Definição'],['Conforme','Somente após verificação efetiva do requisito e referência aplicável.'],['Não conforme','Somente com evidência objetiva de descumprimento aplicável à fase.'],['Divergência checklist × referência','Registrar como ponto de decisão, não como erro automático.'],['Não verificável','Arquivos não permitem confirmar requisito ou evidência.'],['Excel','Auditoria documental.'],['BCF','Incompatibilidade geométrica/modelagem com GUID IFC validado.']],[40,110]);
    return res.json({base64:XLSX.write(wb,{type:'base64',bookType:'xlsx'}),signals:signals.length,verifiedFindings:0});
  });
  app.post('/api/bcf/generate',requireUser,async(req,res)=>{
    try{
      const b=req.body||{}, {data:p}=await admin.from('bfgs_projects').select('*').eq('id',b.projectId).eq('owner',req.user.id).maybeSingle();
      if(!p)return fail(res,404,'Projeto não encontrado.');
      if(!String(b.receipt||'').trim()||!Array.isArray(b.issues)||!b.issues.length)return fail(res,400,'Recibo e apontamentos são obrigatórios.');
      const f=await getFile(admin,req.user.id,b.ifcFileId);if(f.kind!=='IFC'||f.scope!=='project'||f.project_id!==b.projectId)return fail(res,400,'O IFC selecionado não pertence a este projeto.');
      const src=await ifcSource(await getBytes(admin,f),f.name),parsed=parseIfc(src.text),valid=new Set(parsed.elements.map(x=>x.guid));if(!valid.size)return fail(res,400,'Nenhum GUID IFC válido encontrado.');
      for (const issue of b.issues) {
        const related = Array.isArray(issue.relatedGuids)
          ? issue.relatedGuids
          : String(issue.relatedGuids || '').split(/[;,\\s]+/);
        const gs = [String(issue.guid || '').trim(), ...related]
          .map(value => String(value).trim())
          .filter(Boolean);
        if (
          !String(issue.title || '').trim() ||
          !gs.length ||
          gs.some(guid => !/^[0-9A-Za-z_$]{22}$/.test(guid) || !valid.has(guid))
        ) {
          return fail(res, 400, 'Título ou GUID ausente/inválido no IFC selecionado.');
        }
      }
      const zip=new JSZip();zip.file('bcf.version','<?xml version="1.0" encoding="UTF-8"?><Version VersionId="2.1"/>');
      let linked=0;
      for(let i=0;i<b.issues.length;i++){const issue=b.issues[i],topic=crypto.randomUUID(),view=crypto.randomUUID(),x=bcfXml(issue,topic,view,{ifcProjectGuid:parsed.projectGuid,ifcFileName:src.fileName,receipt:String(b.receipt).trim()},i);zip.folder(topic).file('markup.bcf',x.markup);zip.folder(topic).file('viewpoint.bcfv',x.view);linked+=x.linkedComponents;}
      return res.json({zipBase64:await zip.generateAsync({type:'base64',compression:'DEFLATE'}),receipt:String(b.receipt).trim(),topics:b.issues.length,linkedComponents:linked,snapshots:0,snapshotPolicy:'Nenhuma imagem fictícia é incluída; viewpoint contém câmera e componentes IFC.',ifcFileName:src.fileName});
    }catch(e){return fail(res,400,e.message);}
  });
}
