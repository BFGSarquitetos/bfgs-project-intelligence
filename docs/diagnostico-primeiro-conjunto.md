# Primeiro diagnóstico do conjunto DXF/IFC — BFGS

## Escopo
Arquivos recebidos em `DXF.zip`: 13 DXFs e 1 IFC. Esta etapa é triagem técnica e organização de evidências; não declara interferências geométricas confirmadas.

## Integridade e leitura
- Arquivo ZIP passou no teste de integridade.
- 13 arquivos DXF foram extraídos e lidos.
- IFC identificado como schema IFC2X3, aproximadamente 110 MB.
- Leitura encontrou 2.238.811 instâncias STEP no arquivo IFC.
- Foram identificados 4.588 registros com GUID IFC de 22 caracteres, sem duplicidade entre esses registros.

## Organização observada nos DXFs
Os nomes de layers mostram conteúdo misto e recortes/variações de pavimentos, não uma divisão simples em 13 disciplinas independentes. Há layers associados a paredes, portas, pisos/revestimentos, vegetação, mobiliário, louças/metais, veículos, iluminação, cobertura e cotas/anotações. Alguns arquivos incluem conteúdo do térreo e do pavimento superior no mesmo desenho.

## Regras de triagem
1. Falhas de leitura, codificação, exportação ou metadados ausentes são diagnóstico de arquivo, nunca incompatibilidade de projeto por si só.
2. Só abrir apontamento de projeto quando houver evidência ligada a elemento, posição, propriedade, requisito do checklist ou divergência entre documentos.
3. Separar resultado confirmado, possível, pendência de informação e diagnóstico de arquivo.
4. Não declarar clash geométrico com base apenas em nomes de layers, contagens ou presença de GUID.
5. Não converter ausência de informação em não conformidade sem requisito explícito e contexto suficiente.

## Limitações desta etapa
- O IFC tem geometria facetada extensa; a contagem de entidades não demonstra, por si, relações espaciais ou colisões.
- A correspondência DXF–IFC ainda precisa de normalização de coordenadas, identificação de pavimentos e extração de entidades geométricas.
- O PDF de checklist recebido contém 12 páginas; as páginas impressas 3 e 4 não estavam no arquivo. Os critérios legíveis foram estruturados em `config/checklist-bfgs-revisao-02.json` e `docs/checklist-bfgs-revisao-02.md`.

## Próximos passos técnicos
1. Extrair unidades, extents, UCS e blocos de cada DXF, sem presumir unidade quando o metadado não estiver presente.
2. Extrair do IFC unidades, placements, decomposição espacial, tipos, propriedades e representações de produtos.
3. Identificar os pavimentos e as disciplinas a partir de evidências do próprio arquivo.
4. Criar pares de comparação e registrar tolerâncias/transformações explicitamente.
5. Executar regras do checklist apenas quando existirem entradas e evidências suficientes.
6. Exportar Excel de auditoria; gerar BCF apenas para apontamentos de projeto com GUID e viewpoint verificáveis.
