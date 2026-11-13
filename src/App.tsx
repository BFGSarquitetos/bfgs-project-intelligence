import { useEffect, useMemo, useState } from 'react';
import { api } from './lib/api';
import { auth } from './lib/supabase';
import {
  FolderPlus,
  Files,
  Cloud,
  ClipboardCheck,
  Boxes,
  Search,
  Upload,
  Plus,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  FileText,
  LogOut,
  LoaderCircle,
  X,
  Download,
  Trash2,
  Building2,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';

type Project = {
  id: string;
  name: string;
  code: string;
  client: string;
  phase: string;
  status: string;
  createdAt: string;
};
type Asset = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  path: string;
  scope: string;
  projectId: string;
  kind: string;
  createdAt: string;
};
type Finding = {
  title: string;
  severity: string;
  status: string;
  source: string;
  recommendation: string;
};
type Issue = {
  title: string;
  description: string;
  discipline: string;
  severity: string;
  status: string;
  guid: string;
  elementName: string;
};
const fmt = (n: number) =>
  n < 1024
    ? n + ' B'
    : n < 1048576
      ? (n / 1024).toFixed(1) + ' KB'
      : (n / 1048576).toFixed(1) + ' MB';
const date = (s: string) => new Date(s).toLocaleDateString('pt-BR');
const ext = (s: string) => s.split('.').pop()?.toUpperCase() || 'FILE';
const referenceKind = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (extension === 'pdf') return 'PDF de referência';
  if (['dxf', 'dwg'].includes(extension)) return 'CAD de referência';
  if (['ifc', 'ifczip', 'zip'].includes(extension)) return 'BIM de referência';
  if (['xlsx', 'xls', 'csv'].includes(extension)) return 'Planilha de referência';
  if (['docx', 'doc'].includes(extension)) return 'Documento de referência';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return 'Imagem de referência';
  return 'Arquivo de referência';
};

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [active, setActive] = useState('overview');
  const [selected, setSelected] = useState<Project | null>(null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [client, setClient] = useState('');
  const [phase, setPhase] = useState('Anteprojeto');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dxfResults, setDxfResults] = useState<any[]>([]);
  const [integratedReview, setIntegratedReview] = useState<any>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issueDraft, setIssueDraft] = useState({
    title: '',
    description: '',
    guid: '',
    discipline: 'Arquitetura',
    severity: 'Média',
    elementName: '',
  });
  const [ifcElements, setIfcElements] = useState<any[]>([]);
  const [ifcFileId, setIfcFileId] = useState('');
  const [ifcProjectGuid, setIfcProjectGuid] = useState('');
  const [ifcFileName, setIfcFileName] = useState('');
  const [ifcTotalElements, setIfcTotalElements] = useState(0);
  const [ifcSearch, setIfcSearch] = useState('');
  const [receipt, setReceipt] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [removedFileIds, setRemovedFileIds] = useState<string[]>([]);

  async function refresh() {
    const [p, a] = await Promise.all([
      api.get('/api/projects'),
      api.get('/api/files'),
    ]);
    setProjects(p.data.projects || []);
    setAssets(a.data.files || []);
  }

  async function openProject(project: Project) {
    setSelected(project);
    setActive('project');
    setDxfResults([]);
    setIntegratedReview(null);
    setIssues([]);
    setIssueDraft({
      title: '',
      description: '',
      guid: '',
      discipline: 'Arquitetura',
      severity: 'Média',
      elementName: '',
    });
    setReceipt('');
    setIfcElements([]);
    setIfcFileId('');
    setIfcProjectGuid('');
    setIfcFileName('');
    setIfcTotalElements(0);
    setIfcSearch('');
    setSelectedFileIds([]);
    setRemovedFileIds([]);
    try {
      // Recarrega o índice persistente ao entrar no projeto; a lista não depende
      // da memória da página nem do estado mantido antes de trocar de projeto.
      await refresh();
    } catch (e: any) {
      setNotice('Não foi possível atualizar os documentos salvos: ' + (e?.message || 'erro desconhecido'));
    }
  }
  useEffect(() => {
    let active = true;
    let authEventReceived = false;

    // Listen for INITIAL_SESSION / SIGNED_IN before reading the persisted session.
    const { data: { subscription } } = auth.onAuthStateChange(u => {
      authEventReceived = true;
      if (active) {
        setUser(u);
        setLoading(false);
      }
    });

    auth.getSessionUser()
      .then(u => {
        // A late initial read must not overwrite a newer OAuth event.
        if (active && !authEventReceived) setUser(u);
      })
      .catch(e => {
        if (active) setNotice('Não foi possível restaurar a sessão: ' + e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh().catch(e =>
      setNotice('Login reconhecido, mas não foi possível carregar os projetos: ' + e.message)
    );
  }, [user?.userId]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !code.trim()) return;
    setBusy(true);
    try {
      const r = await api.post('/api/projects', { name, code, client, phase });
      await refresh();
      openProject(r.data.project);
      setModal(false);
      setName('');
      setCode('');
      setClient('');
      setNotice('Projeto criado e disponível na sua conta.');
    } catch (e: any) {
      setNotice(e.message || 'Falha ao criar projeto.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(
    file: File,
    scope: 'project' | 'library',
    kind: string
  ) {
    if (!file) return;
    if (scope === 'project' && !selected) return;
    setBusy(true);
    setNotice('Preparando arquivo…');
    const fileId = crypto.randomUUID();
    const chunkSize = 700 * 1024;
    const parts = Math.ceil(file.size / chunkSize);
    try {
      for (let i = 0; i < parts; i++) {
        const chunk = file.slice(
          i * chunkSize,
          Math.min(file.size, (i + 1) * chunkSize)
        );
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(chunk);
        });
        await api.post('/api/files/chunk', {
          scope,
          projectId: selected?.id || '',
          fileId,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          partIndex: i,
          totalParts: parts,
          content,
          kind,
        });
      }
      const completed = await api.post('/api/files/complete', {
        scope,
        projectId: selected?.id || '',
        fileId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        totalParts: parts,
        kind,
      });
      await refresh();
      const savedFiles = completed.data.files || (completed.data.file ? [completed.data.file] : []);
      setNotice(savedFiles.length > 1 ? savedFiles.length + ' arquivos extraídos e armazenados do pacote ' + file.name + '.' : file.name + ' armazenado com sucesso.');
      if (kind === 'DXF') {
        for (const saved of savedFiles) await runDxf(saved.id);
        if (savedFiles.length > 1) setNotice(savedFiles.length + ' DXFs extraídos, armazenados e analisados individualmente. Confira os sinais antes de emitir o Excel.');
      }
      if (kind === 'IFC' && savedFiles[0]) await runIfc(savedFiles[0].id);
    } catch (e: any) {
      setNotice(e.message || 'Falha no envio. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  async function analyzeExistingDxfs() {
    if (!selected) return;
    const existingDxfs = Array.from(new Map(
      projectFiles
        .filter(file => file.scope === 'project' && file.projectId === selected.id &&
          (file.kind === 'DXF' || file.name.toLowerCase().endsWith('.dxf')))
        .map(file => [file.id, file])
    ).values());
    if (!existingDxfs.length) {
      setNotice('Este projeto ainda não possui arquivos DXF armazenados.');
      return;
    }
    setBusy(true);
    setDxfResults([]);
    const reports: any[] = [];
    const failures: string[] = [];
    try {
      for (const file of existingDxfs) {
        setNotice('Analisando DXF existente: ' + file.name + '…');
        try {
          const result = await api.post('/api/review/dxf', {
            fileId: file.id,
            projectId: selected.id,
          });
          reports.push(result.data.report);
        } catch (e: any) {
          failures.push(file.name + ': ' + (e?.response?.data?.error || e.message || 'falha na leitura'));
        }
      }
      setDxfResults(reports);
      setNotice(
        reports.length + ' de ' + existingDxfs.length + ' DXF(s) analisado(s).' +
        (failures.length ? ' Falhas: ' + failures.join('; ') :
          ' Agora você pode emitir o Excel consolidado.')
      );
    } catch (e: any) {
      setNotice('Falha ao consultar os DXFs do projeto: ' + (e?.response?.data?.error || e?.message || 'erro desconhecido'));
    } finally {
      setBusy(false);
    }
  }

  async function runDxf(fileId: string) {
    setNotice('Lendo estrutura do DXF e verificando itens objetivos…');
    try {
      const r = await api.post('/api/review/dxf', {
        fileId,
        projectId: selected?.id,
      });
      setDxfResults(prev => [...prev, r.data.report]);
      setNotice(
        'Leitura estrutural concluída. Os sinais são preliminares e precisam ser cruzados com o Checklist BFGS e as referências antes de qualquer classificação.'
      );
    } catch (e: any) {
      setNotice('Não foi possível ler o DXF: ' + e.message);
    }
  }

  async function runIfc(fileId: string) {
    setNotice('Lendo o IFC e identificando os GUIDs dos elementos…');
    setIfcFileId('');
    setIfcElements([]);
    try {
      const r = await api.post('/api/review/ifc', { fileId, projectId: selected?.id });
      setIfcFileId(fileId);
      setIfcProjectGuid(r.data.projectGuid || '');
      setIfcFileName(r.data.fileName || '');
      setIfcElements(r.data.elements || []);
      setIfcTotalElements(Number(r.data.totalElements || 0));
      setNotice('IFC analisado: ' + Number(r.data.totalElements || 0) + ' elementos com GUID identificados.');
    } catch (e: any) {
      setNotice('Não foi possível analisar o IFC: ' + e.message);
    }
  }

  async function addIssue(e: React.FormEvent) {
    e.preventDefault();
    if (!issueDraft.title.trim()) {
      setNotice('Informe o título do apontamento.');
      return;
    }
    if (!ifcFileId) {
      setNotice('Envie e analise o IFC do projeto antes de adicionar apontamentos BCF.');
      return;
    }
    const guid = issueDraft.guid.trim();
    if (!/^[0-9A-Za-z_$]{22}$/.test(guid)) {
      setNotice('Informe um GUID IFC válido com 22 caracteres.');
      return;
    }
    setIssues(prev => [...prev, { ...issueDraft, guid, status: 'Aberto' }]);
    setIssueDraft({
      title: '',
      description: '',
      guid: '',
      discipline: 'Arquitetura',
      severity: 'Média',
      elementName: '',
    });
  }

  async function removeSelectedFiles() {
    const ids = projectFiles
      .filter(file => selectedFileIds.includes(file.id))
      .map(file => file.id);
    if (!ids.length) {
      setNotice('Nenhum arquivo deste projeto está selecionado.');
      return;
    }
    if (!window.confirm('Excluir definitivamente ' + ids.length + ' arquivo(s) selecionado(s)?')) return;
    setBusy(true);
    setNotice('Excluindo arquivos selecionados…');
    try {
      const result = await api.post('/api/files/delete', { ids, projectId: selected?.id });
      setRemovedFileIds(prev => Array.from(new Set([...prev, ...ids])));
      setAssets(prev => prev.filter(file => !ids.includes(file.id)));
      setSelectedFileIds(prev => prev.filter(id => !ids.includes(id)));
      await refresh();
      setNotice(result.data.message || 'Arquivos removidos da lista do projeto.');
    } catch (e: any) {
      try { await refresh(); } catch {}
      setNotice('A exclusão não foi confirmada: ' + (e?.response?.data?.error || e?.response?.data?.message || e.message || 'erro desconhecido'));
    } finally {
      setBusy(false);
    }
  }

  async function generateBcf() {
    if (!selected || !receipt.trim() || !ifcFileId || !issues.length) return;
    const issuesToExport = issues.map(issue => ({ ...issue, guid: issue.guid.trim() }));
    if (issuesToExport.some(issue => !/^[0-9A-Za-z_$]{22}$/.test(issue.guid))) {
      setNotice('Cada apontamento precisa de um GUID IFC válido com 22 caracteres.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post('/api/bcf/generate', {
        projectId: selected.id, receipt, ifcFileId, issues: issuesToExport,
      });
      const blob = new Blob(
        [Uint8Array.from(atob(r.data.zipBase64), c => c.charCodeAt(0))],
        { type: 'application/zip' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selected.code + '-compatibilizacao-BCF21.bcfzip';
      a.click();
      URL.revokeObjectURL(url);
      setNotice('BCF 2.1 gerado com ' + r.data.linkedComponents + ' componentes IFC validados e uma câmera de referência por tópico.');
    } catch (e: any) {
      setNotice('Falha ao gerar BCF: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runIntegratedReview() {
    if (!selected) return;
    setBusy(true);
    setIntegratedReview(null);
    setNotice('Executando revisão documental exclusivamente dos arquivos DXF…');
    try {
      const r = await api.post('/api/review/complete', { projectId: selected.id });
      setIntegratedReview(r.data);
      setNotice(r.data.message || 'Revisão documental dos DXFs concluída.');
    } catch (e: any) {
      setNotice('Não foi possível concluir a revisão documental DXF: ' + (e?.response?.data?.error || e.message || 'erro desconhecido'));
    } finally {
      setBusy(false);
    }
  }

  function downloadIntegratedExcel() {
    if (!selected || !integratedReview?.base64) return;
    const blob = new Blob(
      [Uint8Array.from(atob(integratedReview.base64), c => c.charCodeAt(0))],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (selected.code || 'projeto') + '-revisao-documental-DXF.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportExcel() {
    if (!selected || !dxfResults.length) return;
    setBusy(true);
    try {
      const r = await api.post('/api/review/excel', {
        projectId: selected.id,
        reports: dxfResults,
      });
      const blob = new Blob(
        [Uint8Array.from(atob(r.data.base64), c => c.charCodeAt(0))],
        {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selected.code + '-relatorio-revisao.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      setNotice('Planilha Excel emitida.');
    } catch (e: any) {
      setNotice('Falha ao emitir Excel: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(
    () =>
      projects.filter(p =>
        (p.name + p.code + p.client)
          .toLowerCase()
          .includes(search.toLowerCase())
      ),
    [projects, search]
  );
  const projectFiles = assets.filter(
    a => a.scope === 'project' && a.projectId === selected?.id && !removedFileIds.includes(a.id)
  );
  const libraryFiles = assets.filter(a => a.scope === 'library');
  const nav = [
    { id: 'overview', label: 'Visão geral', icon: Building2 },
    { id: 'projects', label: 'Projetos', icon: Files },
    { id: 'library', label: 'Nuvem de referências', icon: Cloud },
  ];

  if (loading)
    return (
      <div className="loading">
        <LoaderCircle className="spin" /> Preparando ambiente BFGS…
      </div>
    );
  if (!user)
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="brand-mark">B</div>
          <div className="eyebrow">AMBIENTE INTERNO</div>
          <h1>
            Projetos mais
            <br />
            <em>coordenados.</em>
          </h1>
          <p>
            Portal de revisão documental e compatibilização BIM do escritório
            BFGS.
          </p>
          <button
            className="primary wide"
            onClick={async () => {
              setNotice('');
              try {
                await auth.signInWithRedirect();
              } catch (e: any) {
                setNotice('Falha ao iniciar login com Google: ' + (e?.message || 'erro desconhecido'));
              }
            }}
          >
            Entrar no portal <ArrowRight size={17} />
          </button>
          <small>Acesso autenticado ao portal.</small>
          {notice && <p role="alert" className="muted">{notice}</p>}
        </div>
        <div className="login-side">
          <span>BUILDING BETTER PROJECTS</span>
          <div className="line-art">
            <div />
            <div />
            <div />
            <div />
          </div>
          <p>PADRÃO · PROCESSO · PRECISÃO</p>
        </div>
      </div>
    );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <b>BFGS</b>
            <small>PROJECT INTELLIGENCE</small>
          </div>
        </div>
        <div className="side-label">WORKSPACE</div>
        <nav>
          {nav.map(n => (
            <button
              key={n.id}
              className={active === n.id ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setActive(n.id);
                setSelected(null);
              }}
            >
              <n.icon size={17} />
              {n.label}
              {n.id === 'library' && (
                <span className="nav-count">{libraryFiles.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="secure">
            <ShieldCheck size={16} />
            <span>
              <b>Ambiente protegido</b>
              <small>Conta autenticada</small>
            </span>
          </div>
          <button className="profile" onClick={() => auth.signOut()}>
            <div className="avatar">
              {(user.name || user.email || 'B').slice(0, 1).toUpperCase()}
            </div>
            <span>
              <b>{user.name || 'Equipe BFGS'}</b>
              <small>{user.email || 'Sessão ativa'}</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span className="crumb">BFGS / </span>
            <b>
              {selected
                ? selected.code
                : nav.find(n => n.id === active)?.label || 'Projeto'}
            </b>
          </div>
          <div className="top-right">
            <span className="live-dot" /> SISTEMA OPERACIONAL{' '}
            <span className="top-date">
              {new Date().toLocaleDateString('pt-BR')}
            </span>
          </div>
        </header>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {active === 'overview' && !selected && (
          <section className="page">
            <div className="hero">
              <div>
                <div className="eyebrow">CENTRAL DE COORDENAÇÃO · 01 / 03</div>
                <h1>
                  Da documentação
                  <br />à <em>compatibilização.</em>
                </h1>
                <p>
                  Um fluxo único para revisar, registrar e coordenar os projetos
                  BFGS — com critérios claros e rastreabilidade.
                </p>
                <button className="primary" onClick={() => setModal(true)}>
                  <Plus size={17} /> Iniciar projeto
                </button>
              </div>
              <div className="hero-art">
                <div className="art-square s1" />
                <div className="art-square s2" />
                <div className="art-square s3" />
                <div className="art-center">
                  BFGS
                  <br />
                  <small>PROCESSO</small>
                </div>
                <span className="art-tag">DESIGN × ENGINEERING</span>
              </div>
            </div>
            <div className="stats">
              <div>
                <span>PROJETOS CADASTRADOS</span>
                <b>{projects.length.toString().padStart(2, '0')}</b>
                <small>Na sua conta</small>
              </div>
              <div>
                <span>ARQUIVOS DE REFERÊNCIA</span>
                <b>{libraryFiles.length.toString().padStart(2, '0')}</b>
                <small>Biblioteca compartilhada</small>
              </div>
              <div>
                <span>EM ANDAMENTO</span>
                <b>
                  {projects
                    .filter(p => p.status !== 'Concluído')
                    .length.toString()
                    .padStart(2, '0')}
                </b>
                <small>Projetos ativos</small>
              </div>
            </div>
            <div className="section-head">
              <div>
                <div className="eyebrow">ACOMPANHAMENTO</div>
                <h2>Projetos recentes</h2>
              </div>
              <button
                className="text-button"
                onClick={() => setActive('projects')}
              >
                Ver todos <ArrowRight size={15} />
              </button>
            </div>
            {projects.length ? (
              <div className="project-list">
                {projects.slice(0, 5).map(p => (
                  <button
                    className="project-row"
                    key={p.id}
                    onClick={() => {
                      void openProject(p);
                    }}
                  >
                    <div className="project-icon">
                      <Building2 size={19} />
                    </div>
                    <div className="project-main">
                      <b>{p.name}</b>
                      <small>
                        {p.code} · {p.client || 'Cliente não informado'}
                      </small>
                    </div>
                    <span className="phase">{p.phase}</span>
                    <span className="status">
                      <i />
                      {p.status}
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty">
                <FolderPlus size={26} />
                <b>Nenhum projeto iniciado</b>
                <span>
                  Crie o primeiro projeto para começar o processo de revisão.
                </span>
              </div>
            )}
            <div className="process-grid">
              <div className="process-card">
                <span>ETAPA 01</span>
                <FileSpreadsheet />
                <h3>Revisão documental</h3>
                <p>
                  DXFs por disciplina → leitura técnica → planilha Excel
                  consolidada de apontamentos.
                </p>
                <small>ENTREGA DOCUMENTAL</small>
              </div>
              <div className="process-card">
                <span>ETAPA 02</span>
                <Boxes />
                <h3>Compatibilização BIM</h3>
                <p>
                  IFC → GUIDs reais → recibo de revisão → arquivo BCF 2.1 para
                  Archicad 29.
                </p>
                <small>ENTREGA BIM</small>
              </div>
              <div className="process-card">
                <span>BASE DE REFERÊNCIAS</span>
                <Cloud />
                <h3>Biblioteca de referências</h3>
                <p>
                  PDFs executivos finalizados ficam organizados na nuvem
                  para consulta posterior.
                </p>
                <small>ARQUIVOS DA CONTA</small>
              </div>
            </div>
          </section>
        )}
        {active === 'projects' && !selected && (
          <section className="page">
            <div className="page-title">
              <div>
                <div className="eyebrow">GESTÃO DE PROJETOS</div>
                <h1>Projetos</h1>
                <p>Histórico de análises, documentos e entregas da sua conta.</p>
              </div>
              <button className="primary" onClick={() => setModal(true)}>
                <Plus size={17} /> Novo projeto
              </button>
            </div>
            <div className="toolbar">
              <div className="search">
                <Search size={16} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar por projeto, código ou cliente…"
                />
              </div>
              <span>{filtered.length} registros</span>
            </div>
            <div className="project-list">
              {filtered.map(p => (
                <button
                  className="project-row"
                  key={p.id}
                  onClick={() => {
                    void openProject(p);
                  }}
                >
                  <div className="project-icon">
                    <Building2 size={19} />
                  </div>
                  <div className="project-main">
                    <b>{p.name}</b>
                    <small>
                      {p.code} · {p.client || 'Cliente não informado'}
                    </small>
                  </div>
                  <span className="phase">{p.phase}</span>
                  <span className="status">
                    <i />
                    {p.status}
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
            {!filtered.length && (
              <div className="empty">Nenhum projeto encontrado.</div>
            )}
          </section>
        )}
        {active === 'project' && selected && (
          <section className="page">
            <button
              className="back"
              onClick={() => {
                setSelected(null);
                setActive('projects');
              }}
            >
              ← Voltar aos projetos
            </button>
            <div className="page-title">
              <div>
                <div className="eyebrow">
                  {selected.code} · {selected.phase}
                </div>
                <h1>{selected.name}</h1>
                <p>
                  {selected.client || 'Cliente não informado'} · Criado em{' '}
                  {date(selected.createdAt)}
                </p>
              </div>
              <span className="status large">
                <i />
                {selected.status}
              </span>
            </div>
            <div className="steps">
              <div className="step done">
                <b>01</b>
                <span>Revisão documental</span>
                <small>DXF + Excel</small>
              </div>
              <div className="step">
                <b>02</b>
                <span>Compatibilização BIM</span>
                <small>IFC + BCF 2.1</small>
              </div>
            </div>
            <div className="work-grid">
              <div className="work-card">
                <div className="card-heading">
                  <div>
                    <div className="eyebrow">ENTREGA 01</div>
                    <h2>Revisão documental</h2>
                  </div>
                  <span className="badge">DXF</span>
                </div>
                <p>
                  Envie somente a documentação técnica em DXF das disciplinas.
                  A revisão documental considera exclusivamente os arquivos DXF;
                  modelos IFC não são utilizados nesta etapa.
                </p>
                <label className="upload-zone">
                  <Upload />
                  <b>Adicionar documentação DXF</b>
                  <span>Selecione um ou vários arquivos .dxf; ZIP com DXFs das disciplinas também é aceito</span>
                  <input
                    type="file"
                    accept=".dxf,.zip"
                    multiple
                    disabled={busy}
                    onChange={async e => {
                      const files = Array.from(e.target.files || []);
                      for (const file of files) {
                        await uploadFile(file, 'project', 'DXF');
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
                {dxfResults.length > 0 && (
                  <div className="report-box">
                    <div className="report-top">
                      <b>
                        <CheckCircle2 size={16} /> {dxfResults.length} disciplina(s) analisada(s)
                      </b>
                      <span>
                        {dxfResults.reduce((sum, report) => sum + (report.findings?.length || 0), 0)} apontamentos
                      </span>
                    </div>
                    {dxfResults.map((report, index) => (
                      <div className="finding" key={report.fileName + index}>
                        <b>{report.fileName}</b>
                        <small>
                          {report.entityCount} entidades · {report.layerCount} layers · {report.dimensionCount} cotas nativas
                        </small>
                        {(report.findings || []).map((f: Finding, i: number) => (
                          <div className="finding" key={i}>
                            <span className="finding-severity">{f.severity}</span>
                            <b>{f.title}</b>
                            <small>{f.source}</small>
                            <p>{f.recommendation}</p>
                            <button className="text-button" type="button" onClick={() => {
                              setIssueDraft({
                                title: f.title,
                                description: f.recommendation + '\n\nEvidência DXF: ' + f.source,
                                guid: '',
                                discipline: 'Arquitetura',
                                severity: f.severity === 'Informativo' ? 'Baixa' : f.severity,
                                elementName: '',
                              });
                              setNotice('Apontamento preparado. Selecione o elemento correspondente no IFC antes de adicionar ao BCF.');
                            }}>
                              Preparar apontamento BCF
                            </button>
                          </div>
                        ))}
                      </div>
                    ))}
                    <button
                      className="primary wide"
                      onClick={exportExcel}
                      disabled={busy}
                    >
                      <Download size={16} /> Emitir Excel consolidado
                    </button>
                  </div>
                )}
              </div>
              <div className="work-card">
                <div className="card-heading">
                  <div>
                    <div className="eyebrow">ENTREGA 02</div>
                    <h2>Compatibilização BIM</h2>
                  </div>
                  <span className="badge">IFC / BCF</span>
                </div>
                <p>
                  Envie o IFC para registrar a versão analisada. Associe cada
                  apontamento ao GUID do elemento e informe o recibo da revisão
                  antes de gerar o BCF.
                </p>
                <label className="upload-zone compact">
                  <Upload />
                  <b>Selecionar IFCs</b>
                  <span>Selecione um ou vários arquivos .ifc ou .ifczip</span>
                  <input
                    type="file"
                    accept=".ifc,.ifczip,.zip"
                    multiple
                    disabled={busy}
                    onChange={async e => {
                      const files = Array.from(e.target.files || []);
                      for (const file of files) {
                        await uploadFile(file, 'project', 'IFC');
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
                <div className="field">
                  <label>RECIBO / IDENTIFICAÇÃO DA REVISÃO</label>
                  <input
                    value={receipt}
                    onChange={e => setReceipt(e.target.value)}
                    placeholder="Ex.: REC-2026-014 · revisão recebida em 06/11"
                  />
                </div>
                <div className="divider-line" />
                <div className="eyebrow">ANÁLISE E GERAÇÃO DE APONTAMENTOS</div>
                <p>Use “Preparar apontamento BCF” em cada alerta DXF para preencher o título e a evidência. Depois, selecione o elemento correspondente na lista do IFC ou informe o GUID original. O portal valida o GUID no IFC enviado, mas não deduz automaticamente a correspondência geométrica entre DXF e IFC.</p>
                {ifcFileId && (
                  <div className="report-box">
                    <div className="report-top">
                      <b><CheckCircle2 size={16} /> IFC analisado</b>
                      <span>{ifcTotalElements} elementos</span>
                    </div>
                    <small>{ifcFileName} · IfcProject GUID: {ifcProjectGuid || 'não identificado'}</small>
                  </div>
                )}
                <form onSubmit={addIssue} className="issue-form">
                  <input
                    required
                    placeholder="Título do apontamento"
                    value={issueDraft.title}
                    onChange={e =>
                      setIssueDraft({ ...issueDraft, title: e.target.value })
                    }
                  />
                  <textarea
                    placeholder="Descrição objetiva da incompatibilidade…"
                    value={issueDraft.description}
                    onChange={e =>
                      setIssueDraft({
                        ...issueDraft,
                        description: e.target.value,
                      })
                    }
                  />
                  {ifcElements.length > 0 && (
                    <div className="field">
                      <label>LOCALIZAR ELEMENTO NO IFC</label>
                      <input value={ifcSearch} onChange={e => setIfcSearch(e.target.value)} placeholder="Buscar por classe, nome ou GUID…" />
                      <select value={issueDraft.guid} onChange={e => {
                        const element = ifcElements.find((item: any) => item.guid === e.target.value);
                        setIssueDraft({ ...issueDraft, guid: e.target.value, elementName: element?.name || '' });
                      }}>
                        <option value="">Selecionar elemento identificado no IFC…</option>
                        {ifcElements
                          .filter((element: any) => (element.ifcClass + ' ' + element.name + ' ' + element.guid).toLowerCase().includes(ifcSearch.toLowerCase()))
                          .slice(0, 100)
                          .map((element: any) => <option key={element.guid} value={element.guid}>{element.ifcClass} · {element.name || 'Sem nome'} · {element.guid}</option>)}
                      </select>
                      {ifcTotalElements > ifcElements.length && <small>O seletor mostra os primeiros 2.000 elementos; a validação final consulta o IFC completo.</small>}
                    </div>
                  )}
                  <div className="two-fields">
                    <input
                      required
                      maxLength={22}
                      placeholder="GUID IFC do elemento (22 caracteres)"
                      value={issueDraft.guid}
                      onChange={e =>
                        setIssueDraft({ ...issueDraft, guid: e.target.value })
                      }
                    />
                    <input
                      placeholder="Nome do elemento"
                      value={issueDraft.elementName}
                      onChange={e =>
                        setIssueDraft({
                          ...issueDraft,
                          elementName: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="two-fields">
                    <select
                      value={issueDraft.discipline}
                      onChange={e =>
                        setIssueDraft({
                          ...issueDraft,
                          discipline: e.target.value,
                        })
                      }
                    >
                      <option>Arquitetura</option>
                      <option>Estrutura</option>
                      <option>Elétrica</option>
                      <option>Hidráulica</option>
                      <option>Ar-condicionado</option>
                      <option>Outros</option>
                    </select>
                    <select
                      value={issueDraft.severity}
                      onChange={e =>
                        setIssueDraft({
                          ...issueDraft,
                          severity: e.target.value,
                        })
                      }
                    >
                      <option>Baixa</option>
                      <option>Média</option>
                      <option>Alta</option>
                      <option>Crítica</option>
                    </select>
                  </div>
                  <button className="secondary wide" type="submit">
                    <Plus size={15} /> Adicionar apontamento
                  </button>
                </form>
                {issues.length > 0 && (
                  <div className="issue-list">
                    {issues.map((it, i) => (
                      <div className="issue-item" key={i}>
                        <div>
                          <b>{it.title}</b>
                          <small>{it.guid}</small>
                        </div>
                        <button
                          onClick={() =>
                            setIssues(issues.filter((_, j) => i !== j))
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className="primary wide"
                  onClick={generateBcf}
                  disabled={busy || !receipt.trim() || !ifcFileId || !issues.length}
                >
                  <Boxes size={16} /> Gerar pacote BCF 2.1 <ArrowRight size={15} />
                </button>
                <small className="hint">
                  Cada tópico só é exportado quando o GUID foi encontrado no IFC enviado. O viewpoint BCF 2.1 contém o componente selecionado, a origem Archicad e uma câmera de referência; a posição da câmera ainda não é capturada da vista atual do Archicad.
                </small>
              </div>
            </div>
            <div className="file-section">
              <div className="section-head">
                <div>
                  <div className="eyebrow">ARQUIVOS DO PROJETO</div>
                  <h2>Documentos recebidos</h2>
                </div>
                <span>{projectFiles.length} arquivos</span>
              </div>
              <div className="toolbar">
                <button className="primary" type="button" disabled={busy || !projectFiles.some(f => f.kind === 'DXF' || f.name.toLowerCase().endsWith('.dxf'))} onClick={runIntegratedReview}>
                  <ClipboardCheck size={15} /> Executar revisão documental dos DXFs
                </button>
              </div>
              {integratedReview && (
                <div className="report-box">
                  <div className="report-top">
                    <b><CheckCircle2 size={16} /> Revisão documental DXF concluída</b>
                    <span>{integratedReview.findings?.length || 0} apontamentos</span>
                  </div>
                  <p>{integratedReview.dxfCount} DXF(s) analisados · {integratedReview.dimensions} cotas nativas reconhecidas</p>
                  {(integratedReview.findings || []).map((item: any, index: number) => (
                    <div className="finding" key={index}>
                      <span className="finding-severity">{item.severity}</span>
                      <b>{item.title || item.analysis}</b>
                      <small>{item.source} · {item.status}</small>
                      <p>{item.evidence}</p>
                      <small>{item.action}</small>
                    </div>
                  ))}
                  {(integratedReview.limitations || []).map((item: string, index: number) => (
                    <small key={index}>Limitação: {item}</small>
                  ))}
                  <button className="primary wide" type="button" onClick={downloadIntegratedExcel}>
                    <Download size={16} /> Baixar Excel da revisão documental
                  </button>
                </div>
              )}
              {projectFiles.some(file => file.kind === 'DXF' || file.name.toLowerCase().endsWith('.dxf')) && (
                <div className="toolbar">
                  <button
                    className="primary"
                    type="button"
                    disabled={busy}
                    onClick={analyzeExistingDxfs}
                  >
                    <ClipboardCheck size={15} /> Analisar DXFs existentes
                  </button>
                  {dxfResults.length > 0 && (
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={exportExcel}
                    >
                      <FileSpreadsheet size={15} /> Emitir Excel consolidado
                    </button>
                  )}
                </div>
              )}
              {projectFiles.length > 0 && <div className="toolbar">
                <label><input type="checkbox" checked={projectFiles.every(f => selectedFileIds.includes(f.id))} onChange={e => setSelectedFileIds(e.target.checked ? Array.from(new Set([...selectedFileIds, ...projectFiles.map(f => f.id)])) : selectedFileIds.filter(id => !projectFiles.some(f => f.id === id)))} /> Selecionar todos</label>
                <button className="secondary" disabled={busy || !selectedFileIds.some(id => projectFiles.some(f => f.id === id))} onClick={removeSelectedFiles}><Trash2 size={14} /> Excluir selecionados ({selectedFileIds.filter(id => projectFiles.some(f => f.id === id)).length})</button>
              </div>}
              {projectFiles.map(f => (
                <div className="file-row" key={f.id}>
                  <input type="checkbox" aria-label={'Selecionar ' + f.name} checked={selectedFileIds.includes(f.id)} onChange={e => setSelectedFileIds(prev => e.target.checked ? [...prev, f.id] : prev.filter(id => id !== f.id))} />
                  <FileText />
                  <div>
                    <b>{f.name}</b>
                    <small>
                      {f.kind} · {fmt(f.size)} · {date(f.createdAt)}
                    </small>
                  </div>
                  <span>{ext(f.name)}</span>
                </div>
              ))}
              {!projectFiles.length && (
                <p className="muted">
                  Os arquivos enviados para este projeto aparecerão aqui.
                </p>
              )}
            </div>
          </section>
        )}
        {active === 'library' && (
          <section className="page">
            <div className="page-title">
              <div>
                <div className="eyebrow">BIBLIOTECA DA CONTA</div>
                <h1>Nuvem de referências</h1>
                <p>
                  Reúna PDFs executivos finalizados e documentos de referência.
                  Nesta versão, os arquivos são armazenados, mas ainda não são
                  interpretados automaticamente pela IA.
                </p>
              </div>
            </div>
            <div className="library-banner">
              <Cloud />
              <div>
                <b>Repositório de referências da sua conta</b>
                <p>
                  Envie arquivos de diferentes formatos. A biblioteca os
                  organiza por tipo para consulta; a extração automática de
                  critérios e a comparação técnica ainda não estão ativas.
                </p>
              </div>
            </div>
            <label className="upload-zone library-upload">
              <Upload />
              <b>Adicionar referência à nuvem</b>
              <span>
                PDF, DXF, DWG, IFC, XLSX, DOCX e imagens · até 40 MB por arquivo
              </span>
              <input
                type="file"
                multiple
                accept=".pdf,application/pdf,.dxf,.dwg,.ifc,.ifczip,.zip,.xlsx,.xls,.csv,.docx,.doc,.png,.jpg,.jpeg,.webp"
                disabled={busy}
                onChange={async e => {
                  const files = Array.from(e.target.files || []);
                  for (const file of files) {
                    await uploadFile(file, 'library', referenceKind(file));
                  }
                  e.target.value = '';
                }}
              />
            </label>
            <div className="toolbar">
              <div className="search">
                <Search size={16} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar na biblioteca…"
                />
              </div>
              <span>{libraryFiles.length} documentos</span>
            </div>
            <div className="reference-grid">
              {libraryFiles
                .filter(f =>
                  f.name.toLowerCase().includes(search.toLowerCase())
                )
                .map(f => (
                  <div className="reference-card" key={f.id}>
                    <div className="pdf-icon">
                      <FileText />
                    </div>
                    <div className="ref-meta">
                      <span>{f.kind || 'REFERÊNCIA BFGS'}</span>
                      <b>{f.name}</b>
                      <small>
                        {fmt(f.size)} · {date(f.createdAt)}
                      </small>
                    </div>
                    <span className="ref-tag">{ext(f.name)}</span>
                  </div>
                ))}
            </div>
            {!libraryFiles.length && (
              <div className="empty">
                <Cloud size={27} />
                <b>A biblioteca ainda está vazia</b>
                <span>
                  Adicione o primeiro PDF executivo para começar a formar a base
                  de referência.
                </span>
              </div>
            )}
            <div className="library-note">
              <AlertCircle size={16} />
              <span>
                Os arquivos ficam visíveis apenas para a conta que os enviou.
                O compartilhamento entre membros ainda não está ativado. A
                leitura técnica automática, a extração de diretrizes e a
                comparação semântica entre projetos também ainda não estão
                ativas; o envio não significa que o conteúdo já foi interpretado
                pela IA.
              </span>
            </div>
          </section>
        )}
      </main>
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(false)}>
          <form
            className="modal"
            onSubmit={createProject}
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              onClick={() => setModal(false)}
            >
              <X />
            </button>
            <div className="eyebrow">NOVO WORKSPACE</div>
            <h2>Iniciar projeto</h2>
            <p>Cadastre os dados principais para abrir o fluxo de revisão.</p>
            <div className="field">
              <label>NOME DO PROJETO *</label>
              <input
                required
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Ex.: Edifício Alameda"
              />
            </div>
            <div className="two-fields">
              <div className="field">
                <label>CÓDIGO *</label>
                <input
                  required
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="BFGS-026"
                />
              </div>
              <div className="field">
                <label>FASE</label>
                <select value={phase} onChange={e => setPhase(e.target.value)}>
                  <option>Estudo preliminar</option>
                  <option>Anteprojeto</option>
                  <option>Projeto legal</option>
                  <option>Executivo</option>
                  <option>As built</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>CLIENTE / CONTRATANTE</label>
              <input
                value={client}
                onChange={e => setClient(e.target.value)}
                placeholder="Nome do cliente"
              />
            </div>
            <button className="primary wide" disabled={busy}>
              {busy ? <LoaderCircle className="spin" /> : <Plus size={16} />}{' '}
              Criar projeto
            </button>
          </form>
        </div>
      )}
      {busy && (
        <div className="busy-pill">
          <LoaderCircle className="spin" /> Processando arquivo…
        </div>
      )}
    </div>
  );
}
