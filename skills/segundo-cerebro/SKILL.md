---
name: segundo-cerebro
description: "Cómo usar el segundo cerebro del proyecto (el grafo de conocimiento de graphify en graphify-out/) para entender código: qué comando usar para cada pregunta, cómo leer GRAPH_REPORT.md y las etiquetas de confianza, y qué hace el mod segundo-cerebro solo. Úsala cuando el proyecto tenga graphify-out/graph.json y haya que entender la arquitectura, encontrar dónde está algo, ver qué se rompe al cambiar algo o explicarle el proyecto a la persona."
---

# Segundo cerebro

El proyecto tiene un grafo de conocimiento hecho por [graphify](https://pypi.org/project/graphifyy/): cada archivo, clase, función y concepto es un nodo, y sus relaciones (llama a, importa, hereda, usa…) son aristas. Leerlo cuesta muchos menos tokens que abrir archivos uno por uno, y muestra conexiones que una búsqueda de texto no encuentra.

## La regla

Para entender código, **primero el grafo, después los archivos**:

1. Pregúntale al grafo (comandos abajo), desde la carpeta que tiene `graphify-out/`.
2. Abre solo los archivos que el grafo señala (cada nodo trae `source_location`).
3. Confirma en el código antes de afirmar algo. Cita el archivo y la línea.

Busca a mano (Grep/Glob) cuando el grafo no tenga lo que necesitas: texto literal, configuración, mensajes de error o archivos que no son código.

## Qué comando para cada pregunta

| La pregunta | El comando |
| --- | --- |
| ¿Qué es esto y de qué se compone el proyecto? | leer `graphify-out/GRAPH_REPORT.md` |
| ¿Cuáles son las piezas centrales? | `graphify god-nodes --top 10` |
| ¿Qué tiene que ver con X? | `graphify query "X Y Z"` |
| ¿Cómo llega A hasta B? | `graphify path "A" "B"` o `graphify query "A B" --dfs` |
| ¿Qué es X y con qué se conecta? | `graphify explain "X"` |
| Si cambio X, ¿qué se puede romper? | `graphify affected "X"` |

`--budget N` limita la respuesta a N tokens (por defecto 2000).

## Cómo preguntarle bien

`graphify query` **no entiende lenguaje natural**: compara palabras, sin sinónimos ni traducción, contra los nombres de los nodos. Esos nombres son los del código, casi siempre en inglés.

- Mal: `graphify query "¿dónde se valida el inicio de sesión?"`
- Bien: `graphify query "login auth validate session token"`

Si no sabes cómo se llaman las cosas, mira primero `god-nodes` o el informe, y usa esas palabras. Si una consulta no devuelve nada, cambia de palabras antes de concluir que no existe.

## Leer GRAPH_REPORT.md

- **God nodes**: los nodos con más conexiones. Por ahí pasa casi todo; tocarlos tiene mucho alcance.
- **Comunidades**: grupos de nodos muy conectados entre sí. Suelen corresponder a módulos o funciones del negocio.
- **Conexiones sorprendentes**: relaciones entre partes que parecían separadas. Vale la pena mencionarlas.

## Etiquetas de confianza

Cada arista dice de dónde sale:

- **EXTRACTED**: leída del código (una importación, una llamada). Es un hecho.
- **INFERRED**: deducida (por nombres, por contexto o por la IA). Es una pista: confírmala en el archivo.
- **AMBIGUOUS**: podría ser una cosa u otra. No la afirmes sin revisar.

Al explicarle algo a la persona, distingue lo que viene del código de lo que es una inferencia.

## Lo que hace el mod (no lo hagas tú)

- **Actualiza el grafo solo** al terminar cada turno en que se cambió código del proyecto (`graphify update .`, sin IA). No lo reconstruyas por tu cuenta.
- El grafo rápido solo lee **código**. Si la persona pregunta por documentos, PDFs, imágenes o notas que no aparecen en el grafo, sugiérele `/cerebro completo`, que los agrega con la skill `graphify` (usa tokens).
- Si el grafo dice que un nodo existe pero el archivo ya no lo tiene, el grafo está atrasado: sugiere el botón **Actualizar grafo** o `/cerebro actualizar`, y si graphify se niega por tener menos nodos, `/cerebro forzar`.

Comandos de la persona: `/cerebro` (estado), `crear`, `completo`, `actualizar`, `forzar`, `abrir` (mapa interactivo en el navegador), `auto on|off`, `instalar`, `ayuda`.
