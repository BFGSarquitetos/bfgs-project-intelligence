# Plano de migração independente — BFGS Project Intelligence

## Estado verificado em 12/11/2026
- Projeto Railway: `captivating-radiance`.
- Serviço criado: `bfgs-project-intelligence-api`.
- Repositório GitHub: `BFGSarquitetos/bfgs-project-intelligence`.
- O repositório contém a interface React/Vite original, o backend original, configurações e o checklist BFGS estruturado.
- O backend original ainda importa `@appdeploy/sdk`; a interface importa `@appdeploy/client`. Portanto, a aplicação ainda não é independente nem está pronta para deploy.
- O schema Supabase já existente tem tabelas `organizations`, `profiles`, `organization_members`, `projects`, `project_files`, `issues`, `issue_components`, `reference_documents`. Não substituir esse schema sem migração versionada.

## Contratos HTTP existentes a preservar
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/files`
- `POST /api/files/chunk`
- `POST /api/files/complete`
- `POST /api/files/delete`
- `POST /api/review/dxf`
- `POST /api/review/ifc`
- `POST /api/review/executive`
- `POST /api/review/excel`
- `POST /api/bcf/generate`

## Mapeamento dos serviços AppDeploy para infraestrutura independente
| AppDeploy | Destino | Requisito |
|---|---|---|
| `requireAuth()` | Supabase Auth JWT | validar token no backend e associar usuário/organização |
| `db.list/get/tx.add/tx.delete` | Supabase Postgres | RLS, organização, projeto e trilha de auditoria |
| `storage.read/write/delete` | Supabase Storage | buckets privados, caminhos por organização/projeto e URLs assinadas |
| `ai.extract` | adaptador de provedor de IA | chave em segredo Railway, limites, logs e schema validado |
| `router()` | servidor Node/Express ou Fastify | manter os contratos /api para reduzir mudanças no frontend |

## Regras obrigatórias da análise
1. Problemas de leitura/exportação/codificação/metadados não entram como não conformidade de projeto.
2. Todo apontamento deve ter critério do checklist, documento(s), evidência, localização quando disponível, justificativa e nível de confiança.
3. Status permitidos: Confirmada, Possível — validar, Pendência de informação, Não verificável.
4. Diagnóstico de arquivo é categoria separada e não é contabilizado como erro de projeto.
5. Não classificar geometria como interferência sem transformação de coordenadas conhecida, pavimento identificado e teste espacial reproduzível.
6. Não classificar requisito normativo sem norma/legislação aplicável, jurisdição, versão e fase do projeto.
7. Excel registra auditoria documental e checklist; BCF registra apenas apontamentos BIM com GUID real e viewpoint validado.

## Lacunas técnicas constatadas
- Parser DXF atual faz leitura de pares código/valor e sinais estruturais; não é parser CAD completo.
- Parser IFC atual é baseado em texto STEP e identificação de GUID/classe/nome; não resolve completamente geometria, transformações, relações espaciais, materiais e propriedades.
- BCF atual gera markup e viewpoint com câmera, mas informa `snapshots: 0`; não inventar snapshots.
- Upload original limita chunking a 200 partes; testar limite e arquivos grandes.
- O fluxo atual de ZIP DXF exige exatamente um DXF. A necessidade BFGS é aceitar múltiplos DXFs por projeto; implementar upload em lote sem forçar um único DXF por arquivo compactado.
- RAR não é suportado no backend original; manter diagnóstico claro, não marcar como erro de projeto.

## Plano de implementação
### Fase A — base executável
- Substituir imports AppDeploy por API independente.
- Criar health check, validação de ambiente e tratamento padronizado de erros.
- Conectar Supabase Auth, Postgres e Storage sem expor service-role.
- Implementar controle multi-organização e autorização por projeto.
- Adicionar migrações SQL versionadas e testes.

### Fase B — ingestão e auditoria
- Upload múltiplo DXF/IFC/PDF/XLSX com metadados, hash, versão e histórico.
- Parser DXF com unidades declaradas, extents, UCS, blocos, entidades e coordenadas.
- Parser IFC com unidades, IfcProject, IfcSite/Building/Storey, placements, produtos, GUIDs, propriedades e geometria.
- Normalização espacial explícita; nunca presumir unidade quando ausente.
- Motor de regras ligado ao JSON do checklist BFGS, com rastreabilidade de cada critério.
- Excel com abas de resumo, evidências, checklist, pendências e apontamentos confirmados.

### Fase C — compatibilização e BCF
- Definir pares de disciplinas e pavimentos com origem e transformação documentadas.
- Aplicar testes geométricos com tolerâncias configuráveis e resultados reproduzíveis.
- Exigir revisão humana antes de converter suspeita em apontamento confirmado.
- Gerar BCF 2.1 com GUIDs validados, câmera calculada e snapshot apenas quando imagem real for produzida.
- Validar importação no Archicad 29.

### Fase D — publicação
- Configurar variáveis protegidas no Railway.
- Build, deploy, health check, testes de regressão e teste de carga.
- Manter o AppDeploy ativo até aceite explícito após validação funcional.

## Correção de diagnóstico DXF/IFC
Uma leitura posterior dos cabeçalhos dos 13 DXFs não encontrou a variável `$INSUNITS`. Portanto, a unidade DXF está **não declarada no cabeçalho**, não comprovadamente em milímetros. O IFC declara IFC2X3; a unidade espacial precisa ser extraída das entidades `IFCUNITASSIGNMENT` e da cadeia de unidades do projeto. Não assumir compatibilidade de unidades até concluir essa extração.
