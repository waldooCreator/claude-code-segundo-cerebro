import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { EstadoCerebro } from '../types'

/** Lo más que puede tardar graphify (incluida la espera si otra sesión lo está corriendo). */
const LIMITE_MS = 10 * 60 * 1000
const LIMITE_INSTALAR_MS = 5 * 60 * 1000

/** Cómo se instala graphify (paquete «graphifyy» de PyPI), del más limpio al último recurso. */
const INSTALADORES: string[][] = [
  ['uv', 'tool', 'install', '--upgrade', 'graphifyy'],
  ['pipx', 'install', '--force', 'graphifyy'],
  ['python3', '-m', 'pip', 'install', '--user', '--upgrade', 'graphifyy'],
  ['python', '-m', 'pip', 'install', '--user', '--upgrade', 'graphifyy'],
  ['py', '-m', 'pip', 'install', '--user', '--upgrade', 'graphifyy'],
]

/** Abrir un archivo con el programa del sistema: Linux, macOS, Windows. */
const ABRIDORES: string[][] = [['xdg-open'], ['open'], ['cmd', '/c', 'start', '']]

/** Las extensiones que graphify update lee sin IA: cambiar una de estas deja el grafo atrasado. */
const CODIGO = new Set(
  ('py ts tsx js jsx mjs cjs go rs java kt kts cs c h cc cpp hpp cxx rb php swift scala lua vue svelte ' +
    'dart ex exs erl hs ml clj sh bash ps1 r jl zig nim sol').split(' '),
)

const INICIAL: EstadoCerebro = {
  graphify: 'revisando',
  programa: null,
  version: null,
  raiz: null,
  tieneGrafo: false,
  archivos: null,
  actualizadoMs: null,
  revisadoMs: null,
  tarea: null,
  fallo: null,
  forzable: false,
  pendiente: false,
  descartado: false,
  auto: true,
}

const estado = atom({ plugin: 'segundo-cerebro', key: 'estado' } as const, INICIAL)
/** Sube cada minuto para que «hace X min» no se quede viejo. */
const minuto = atom({ plugin: 'segundo-cerebro', key: 'minuto' } as const, 0)

/** Una sola corrida a la vez dentro de esta sesión (doble clic, o el botón y /cerebro juntos). */
let enCurso = false
/** La carpeta de la sesión con la que se buscó el proyecto por última vez. */
let ultimaCarpeta: string | null = null

type Resultado = { fallo: string | null; aviso: string; forzable: boolean; alDia: boolean }

const dentroDe = (ruta: string, base: string) => ruta === base || ruta.startsWith(`${base}/`)
const padre = (ruta: string) => ruta.slice(0, Math.max(ruta.lastIndexOf('/'), 0))
const nombre = (ruta: string) => ruta.slice(ruta.lastIndexOf('/') + 1) || ruta
const miles = (cifra: string | number) => String(cifra).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const extension = (ruta: string) => {
  const archivo = nombre(ruta)
  const punto = archivo.lastIndexOf('.')
  return punto > 0 ? archivo.slice(punto + 1).toLowerCase() : ''
}

async function correr($: EngineInterface, argv: string[], cwd?: string, timeoutMs = 30_000): Promise<ProcessRunResult | null> {
  try {
    return await $.process.run(argv, { cwd, timeoutMs, env: { GRAPHIFY_NO_TIPS: '1' } })
  } catch {
    // El programa no existe en este equipo.
    return null
  }
}

async function carpetaPersonal($: EngineInterface): Promise<string | null> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? null
}

/** El graphify de este equipo: primero el de ~/.local/bin, que el PATH de Claude Code a veces no trae. */
async function buscarGraphify($: EngineInterface): Promise<{ programa: string; version: string | null } | null> {
  const home = await carpetaPersonal($)
  const candidatos = [home && `${home}/.local/bin/graphify`, home && `${home}/.local/bin/graphify.exe`, 'graphify']
  for (const programa of candidatos) {
    if (!programa) continue
    if (programa !== 'graphify' && !(await $.fs.exists(programa))) continue
    const r = await correr($, [programa, '--version'], undefined, 15_000)
    if (r?.exitCode === 0) {
      return { programa, version: /(\d+\.\d+[\w.]*)/.exec(`${r.stdout} ${r.stderr}`)?.[1] ?? null }
    }
  }
  return null
}

async function revisarGraphify($: EngineInterface): Promise<void> {
  const hallado = await buscarGraphify($)
  await update($, estado, (s): EstadoCerebro =>
    s.graphify === 'instalando'
      ? s
      : { ...s, graphify: hallado ? 'listo' : 'falta', programa: hallado?.programa ?? null, version: hallado?.version ?? null },
  )
}

async function fechaDelGrafo($: EngineInterface, raiz: string): Promise<number | null> {
  const stat = await $.fs.stat(`${raiz}/graphify-out/graph.json`).catch(() => undefined)
  return stat?.mtimeMs ?? null
}

/**
 * El proyecto de la sesión: la carpeta más cercana hacia arriba con un grafo; si no hay,
 * la raíz de git; si no, la carpeta misma. En el HOME o en / no se ofrece nada.
 */
async function buscarProyecto($: EngineInterface, desde: string): Promise<{ raiz: string | null; archivos: number | null }> {
  const home = await carpetaPersonal($)
  for (let dir = desde; dir !== ''; dir = padre(dir)) {
    if (dir === home) break
    if (await $.fs.exists(`${dir}/graphify-out/graph.json`)) return { raiz: dir, archivos: null }
  }
  if (desde === '' || desde === '/' || desde === home) return { raiz: null, archivos: null }
  const git = await correr($, ['git', 'rev-parse', '--show-toplevel'], desde)
  const top = git?.exitCode === 0 ? git.stdout.trim() : ''
  const raiz = top && top !== home ? top : desde
  const lista = await correr($, ['git', 'ls-files'], raiz)
  const archivos =
    lista?.exitCode === 0 && !lista.isStdoutTruncated ? lista.stdout.split('\n').filter(Boolean).length : null
  return { raiz, archivos }
}

async function descartados($: EngineInterface): Promise<string[]> {
  const v = await $.store.get('descartados')
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Mira de nuevo dónde está el proyecto, si tiene grafo y de cuándo es. */
async function refrescar($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  if (cwd !== ultimaCarpeta) {
    ultimaCarpeta = cwd
    const { raiz, archivos } = await buscarProyecto($, cwd)
    const descartado = raiz !== null && (await descartados($)).includes(raiz)
    await update($, estado, (s): EstadoCerebro =>
      s.raiz === raiz
        ? { ...s, archivos, descartado }
        : { ...s, raiz, archivos, descartado, revisadoMs: null, fallo: null, forzable: false, pendiente: false },
    )
  }
  const { raiz } = await read($, estado)
  const actualizadoMs = raiz === null ? null : await fechaDelGrafo($, raiz)
  await update($, estado, s => ({ ...s, tieneGrafo: actualizadoMs !== null, actualizadoMs }))
}

function haceCuanto(ms: number, ahora: number): string {
  const minutos = Math.floor(Math.max(0, ahora - ms) / 60_000)
  if (minutos < 1) return 'hace un momento'
  if (minutos < 60) return `hace ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${horas} h`
  const dias = Math.floor(horas / 24)
  return dias === 1 ? 'hace 1 día' : `hace ${dias} días`
}

/**
 * Lo que dijo graphify en una línea. graphify update sale con 0 también cuando no hay
 * cambios de código y deja graph.json como estaba: eso es «al día», no un fallo. Cuando el
 * grafo nuevo tiene menos nodos se niega a reemplazarlo y sale con 1; eso pide --force.
 */
function resumir(salida: ProcessRunResult, segundos: number, cambio: boolean, creando: boolean): Resultado {
  const texto = `${salida.stdout}\n${salida.stderr}`
  const lineas = texto.split('\n').map(linea => linea.trim()).filter(Boolean)

  const encogido = /new graph has (\d+) nodes but existing graph\.json has (\d+)/.exec(texto)
  if (encogido) {
    const fallo =
      `graphify no reemplazó el grafo: el nuevo tiene ${miles(encogido[1] ?? '')} nodos y el actual ` +
      `${miles(encogido[2] ?? '')}. Si borraste código a propósito, usa Forzar o /cerebro forzar.`
    return { fallo, aviso: fallo, forzable: true, alDia: false }
  }

  if (salida.exitCode !== 0) {
    // La última línea suele ser el genérico «check output above»: se busca la que dice por qué.
    const utiles = lineas.filter(linea => !/check output above/i.test(linea))
    const motivo =
      [...utiles].reverse().find(linea => /error|failed|refusing|not found|traceback/i.test(linea)) ??
      utiles.at(-1) ??
      'sin mensaje'
    const fallo = `graphify falló (código ${salida.exitCode}): ${motivo}`.slice(0, 200)
    return { fallo, aviso: fallo, forzable: false, alDia: false }
  }

  const cifras = /Rebuilt: (\d+) nodes, (\d+) edges/.exec(texto)
  if (cifras || cambio) {
    const detalle = cifras ? `: ${miles(cifras[1] ?? '')} nodos, ${miles(cifras[2] ?? '')} relaciones` : ''
    const aviso = creando
      ? `🧠 Segundo cerebro listo${detalle} (${segundos} s). Claude lo consultará antes de buscar a mano. Para sumar documentos: /cerebro completo.`
      : `🧠 Grafo actualizado${detalle} (${segundos} s).`
    return { fallo: null, aviso, forzable: false, alDia: true }
  }
  if (/changes detected.*left untouched|No code files found|No tracked code files/i.test(texto)) {
    return {
      fallo: null,
      aviso: creando
        ? 'graphify no encontró código en este proyecto. Para documentos, PDFs o imágenes usa /cerebro completo.'
        : `El grafo ya estaba al día: no hay cambios de código desde la última actualización (${segundos} s).`,
      forzable: false,
      alDia: !creando,
    }
  }
  return {
    fallo: null,
    aviso: `graphify terminó en ${segundos} s sin cambiar graph.json: ${lineas.at(-1) ?? 'sin mensaje'}`.slice(0, 200),
    forzable: false,
    alDia: true,
  }
}

type Modo = 'crear' | 'actualizar' | 'forzar'

/** graphify update . en la raíz del proyecto (sin IA): crea el grafo si no hay, o lo pone al día. */
async function actualizar($: EngineInterface, modo: Modo, silencioso = false): Promise<void> {
  if (enCurso) {
    if (!silencioso) $.ui.toast('El grafo ya se está actualizando.')
    return
  }
  enCurso = true
  try {
    const { raiz, programa } = await read($, estado)
    if (raiz === null || programa === null) return
    const creando = !(await read($, estado)).tieneGrafo
    const inicio = await $.clock.now()
    const tarea = creando ? 'Creando el grafo…' : 'Actualizando el grafo…'
    await update($, estado, s => ({ ...s, tarea, fallo: null, forzable: false, pendiente: false }))

    let resultado: Resultado
    const antes = await fechaDelGrafo($, raiz)
    const argv = modo === 'forzar' ? [programa, 'update', '.', '--force'] : [programa, 'update', '.']
    // graphify trae su propio candado por proyecto: si otra sesión lo está corriendo, espera.
    const salida = await correr($, argv, raiz, LIMITE_MS)
    if (salida === null) {
      const fallo = 'No se pudo correr graphify. Prueba /cerebro instalar.'
      resultado = { fallo, aviso: fallo, forzable: false, alDia: false }
    } else {
      const despues = await fechaDelGrafo($, raiz)
      const segundos = Math.round(((await $.clock.now()) - inicio) / 1000)
      resultado = resumir(salida, segundos, despues !== null && despues !== antes, creando)
    }

    const actualizadoMs = await fechaDelGrafo($, raiz)
    const terminado = await $.clock.now()
    await update($, estado, s => ({
      ...s,
      tarea: null,
      tieneGrafo: actualizadoMs !== null,
      actualizadoMs,
      revisadoMs: resultado.alDia ? terminado : s.revisadoMs,
      fallo: resultado.fallo,
      forzable: resultado.forzable,
    }))
    // La actualización sola al terminar un turno solo avisa si algo salió mal.
    if (!silencioso || resultado.fallo !== null) $.ui.toast(resultado.aviso, { timeoutMs: 10_000 })
  } finally {
    enCurso = false
    await update($, estado, s => (s.tarea === null ? s : { ...s, tarea: null })).catch(() => undefined)
  }
}

/** Instala graphify con el primer instalador que exista y deja su skill en Claude Code. */
async function instalar($: EngineInterface): Promise<void> {
  if (enCurso) return
  enCurso = true
  try {
    await update($, estado, (s): EstadoCerebro => ({ ...s, graphify: 'instalando', fallo: null }))
    let ultimo = ''
    let instalado = false
    for (const argv of INSTALADORES) {
      const r = await correr($, argv, undefined, LIMITE_INSTALAR_MS)
      if (r === null) continue
      if (r.exitCode === 0) {
        instalado = true
        break
      }
      ultimo = `${argv.join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}`
    }
    const hallado = instalado ? await buscarGraphify($) : null
    if (hallado === null) {
      const fallo = (
        instalado
          ? 'graphify quedó instalado pero no lo encuentro: abre una terminal nueva o agrega ~/.local/bin al PATH.'
          : `No pude instalar graphify. Instala uv (https://docs.astral.sh/uv) y vuelve a intentarlo.${ultimo ? ` Último error: ${ultimo}` : ''}`
      ).slice(0, 240)
      await update($, estado, (s): EstadoCerebro => ({ ...s, graphify: 'falta', fallo }))
      $.ui.toast(fallo, { timeoutMs: 15_000 })
      return
    }
    // La skill oficial de graphify: /graphify y el grafo completo con IA.
    await correr($, [hallado.programa, 'install', '--platform', 'claude'], undefined, 60_000)
    await update($, estado, (s): EstadoCerebro => ({ ...s, graphify: 'listo', programa: hallado.programa, version: hallado.version, fallo: null }))
    const { tieneGrafo, raiz } = await read($, estado)
    $.ui.toast(
      `🧠 graphify ${hallado.version ?? ''} instalado.${!tieneGrafo && raiz !== null ? ' Ahora crea el grafo del proyecto con un clic.' : ''}`,
      { timeoutMs: 10_000 },
    )
  } finally {
    enCurso = false
  }
}

/** El grafo completo (código, documentos, imágenes) lo construye Claude con la skill de graphify. */
async function completo($: EngineInterface): Promise<void> {
  const { raiz } = await read($, estado)
  const ruta = raiz ?? '.'
  try {
    await $.command.run({ command: 'graphify', args: ruta })
  } catch {
    // La skill recién instalada todavía no aparece como comando: se le pide a Claude con palabras.
    await $.prompt.submit({
      text: `Construye el segundo cerebro completo de este proyecto con la skill graphify (/graphify ${ruta}): código, documentos e imágenes.`,
    })
  }
}

async function abrirMapa($: EngineInterface): Promise<void> {
  const { raiz } = await read($, estado)
  if (raiz === null) return
  const mapa = `${raiz}/graphify-out/graph.html`
  for (const argv of ABRIDORES) {
    const r = await correr($, [...argv, mapa], undefined, 15_000)
    if (r?.exitCode === 0) return
  }
  $.ui.toast(`Abre este archivo en el navegador: ${mapa}`, { timeoutMs: 15_000 })
}

async function ahoraNo($: EngineInterface): Promise<void> {
  const { raiz } = await read($, estado)
  if (raiz === null) return
  const lista = await descartados($)
  if (!lista.includes(raiz)) await $.store.set('descartados', [...lista, raiz])
  await update($, estado, s => ({ ...s, descartado: true }))
  $.ui.toast('Listo, no vuelvo a ofrecerlo en este proyecto. Cuando quieras: /cerebro crear.', { timeoutMs: 8_000 })
}

async function olvidarDescarte($: EngineInterface): Promise<void> {
  const { raiz } = await read($, estado)
  if (raiz === null) return
  const lista = await descartados($)
  if (lista.includes(raiz)) await $.store.set('descartados', lista.filter(r => r !== raiz))
  await update($, estado, s => ({ ...s, descartado: false }))
}

/** Corre una tarea por fuera del clic o del comando, para no dejarlos esperando. */
function lanzar($: EngineInterface, tarea: () => Promise<void>): void {
  $.clock.after(0, () => {
    void tarea()
  })
}

const AYUDA = [
  '🧠 Segundo cerebro: un grafo de conocimiento del proyecto (graphify) que Claude consulta antes de buscar a mano.',
  '',
  '  /cerebro             estado del grafo',
  '  /cerebro crear       crea el grafo del código (rápido, sin IA, gratis)',
  '  /cerebro completo    grafo con código, documentos e imágenes (lo hace Claude: usa tokens)',
  '  /cerebro actualizar  pone el grafo al día con el código',
  '  /cerebro forzar      actualiza aunque el grafo nuevo tenga menos nodos (después de borrar código)',
  '  /cerebro abrir       abre el mapa interactivo en el navegador',
  '  /cerebro auto on|off actualizar solo al terminar cada turno en que Claude cambió código',
  '  /cerebro instalar    instala o actualiza graphify',
].join('\n')

/**
 * Lo que Claude lee en cada sesión con grafo. La skill segundo-cerebro tiene el detalle;
 * esto es lo que tiene que hacer siempre.
 */
function instruccion(raiz: string): string {
  return [
    `Este proyecto tiene un segundo cerebro: un grafo de conocimiento de graphify en ${raiz}/graphify-out (graph.json, GRAPH_REPORT.md, graph.html).`,
    'Antes de buscar archivos a mano para entender el código, consulta el grafo desde esa carpeta:',
    '`graphify query "<palabras>"` para contexto amplio, `graphify path "A" "B"` para ver cómo se conectan dos cosas, `graphify explain "X"` para un nodo y sus vecinos, `graphify affected "X"` para ver qué se rompe al cambiar X y `graphify god-nodes` para las piezas centrales.',
    'query compara palabras literales con los nombres de los nodos (los identificadores del código, casi siempre en inglés): pregúntale con esos nombres, no con la frase de la persona.',
    'Para la visión general (módulos centrales y comunidades) lee GRAPH_REPORT.md. Después confirma en los archivos que el grafo señala antes de afirmar algo.',
    'Las relaciones EXTRACTED salen del código; las INFERRED y AMBIGUOUS son pistas, no hechos.',
    'No reconstruyas el grafo tú: el mod segundo-cerebro lo actualiza solo al terminar cada turno en que cambió código. Si faltan documentos en el grafo, sugiere /cerebro completo.',
    'La skill segundo-cerebro explica el uso en detalle.',
  ].join(' ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cerebro',
      description: 'Segundo cerebro: crea, actualiza o abre el grafo de graphify del proyecto',
      argumentHint: '[crear|completo|actualizar|forzar|abrir|auto on|auto off|instalar|ayuda]',
    })
    ultimaCarpeta = null
    const auto = (await $.store.get('auto')) !== false
    // Una recarga del mod a mitad de una corrida no debe dejar la franja en «actualizando…».
    await update($, estado, (s): EstadoCerebro => ({ ...s, auto, tarea: null, graphify: s.graphify === 'instalando' ? 'revisando' : s.graphify }))
    await refrescar($)
    lanzar($, () => revisarGraphify($))
    $.clock.every(60_000, () => {
      void read($, estado).then(({ tieneGrafo }) => (tieneGrafo ? update($, minuto, n => n + 1) : undefined))
    })
    return next(e)
  })

  // Claude cambió código del proyecto: el grafo queda atrasado hasta el final del turno.
  on('tool.call', async ($, e, next) => {
    const resultado = await next(e)
    const ruta = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : null
    if (ruta) {
      const { raiz } = await read($, estado)
      if (raiz !== null && dentroDe(ruta, raiz) && !dentroDe(ruta, `${raiz}/graphify-out`) && CODIGO.has(extension(ruta))) {
        await update($, estado, s => (s.pendiente ? s : { ...s, pendiente: true }))
      }
    }
    return resultado
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const resultado = await next(e)
    if (e.agentId === undefined) {
      await refrescar($).catch(() => undefined)
      const s = await read($, estado)
      if (s.auto && s.pendiente && s.tieneGrafo && s.graphify === 'listo' && s.tarea === null) {
        lanzar($, () => actualizar($, 'actualizar', true))
      }
    }
    return resultado
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const { raiz, tieneGrafo } = await read($, estado)
    if (raiz === null || !tieneGrafo) return r
    return { sections: [...r.sections, { id: 'segundo-cerebro:grafo', text: instruccion(raiz), scope: 'session' }] }
  })

  on('command.run', { command: 'cerebro' }, async ($, e) => {
    await refrescar($)
    const s = await read($, estado)
    const [orden = '', valor = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (orden === 'ayuda' || orden === 'help') return { text: AYUDA }
    if (orden === 'instalar') {
      if (s.graphify === 'instalando') return { text: 'graphify ya se está instalando.' }
      lanzar($, () => instalar($))
      return { text: 'Instalando graphify (uv, pipx o pip). Aviso al terminar.' }
    }
    if (orden === 'auto') {
      const auto = valor !== 'off' && valor !== 'no'
      await $.store.set('auto', auto)
      await update($, estado, x => ({ ...x, auto }))
      return {
        text: auto
          ? 'Actualización automática encendida: al terminar cada turno en que Claude cambie código, el grafo se pone al día.'
          : 'Actualización automática apagada. Usa el botón o /cerebro actualizar cuando quieras.',
      }
    }
    if (s.raiz === null) {
      return { text: 'Abre Claude Code dentro de la carpeta de un proyecto (no en tu carpeta personal) para crear su segundo cerebro.' }
    }
    if (orden !== '' && orden !== 'estado' && orden !== 'completo' && orden !== 'abrir' && s.graphify !== 'listo') {
      return { text: 'Falta graphify. Instálalo con /cerebro instalar o con el botón de la franja.' }
    }
    if (orden === 'completo') {
      await olvidarDescarte($)
      lanzar($, () => completo($))
      return { text: 'Le pido a Claude el grafo completo con la skill graphify (lee también documentos e imágenes; usa tokens).' }
    }
    if (orden === 'abrir') {
      if (!s.tieneGrafo) return { text: 'Todavía no hay grafo. Créalo con /cerebro crear.' }
      lanzar($, () => abrirMapa($))
      return { text: `Abriendo ${s.raiz}/graphify-out/graph.html` }
    }
    if (orden === 'crear' || orden === 'actualizar' || orden === 'forzar') {
      if (s.tarea !== null || enCurso) return { text: 'El grafo ya se está actualizando.' }
      await olvidarDescarte($)
      const modo: Modo = orden === 'forzar' ? 'forzar' : orden === 'crear' && !s.tieneGrafo ? 'crear' : 'actualizar'
      lanzar($, () => actualizar($, modo))
      return { text: `${s.tieneGrafo ? 'Actualizando' : 'Creando'} el grafo de ${nombre(s.raiz)} (graphify update .). Aviso al terminar.` }
    }

    const ahora = await $.clock.now()
    const lineas = [
      `🧠 Proyecto: ${s.raiz}`,
      s.graphify === 'listo' ? `graphify ${s.version ?? ''} en ${s.programa}` : 'graphify: no está instalado (/cerebro instalar)',
      s.tieneGrafo && s.actualizadoMs !== null
        ? `Grafo actualizado ${haceCuanto(s.actualizadoMs, ahora)}${s.pendiente ? ' · hay cambios de código sin pasar al grafo' : ''}`
        : 'Todavía no hay grafo: /cerebro crear (rápido) o /cerebro completo (con IA)',
      `Actualización automática: ${s.auto ? 'encendida' : 'apagada'}`,
      '',
      AYUDA,
    ]
    return { text: lineas.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, estado)
    await read($, minuto)
    if (e.props.hasSurvey || s.raiz === null || s.graphify === 'revisando') return next(e)
    if (!s.tieneGrafo && s.descartado && s.tarea === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const libre = s.tarea === null && !e.props.isWorking
    const error =
      s.fallo !== null && s.tarea === null ? (
        <Text color="error" wrap="truncate-end">
          {s.fallo}{' '}
        </Text>
      ) : null

    if (s.graphify === 'instalando') {
      return (
        <Box>
          <Text dimColor>🧠 Instalando graphify…</Text>
        </Box>
      )
    }
    if (s.graphify === 'falta') {
      return (
        <Box>
          <Text dimColor wrap="truncate-end">
            🧠 Segundo cerebro: para que Claude recuerde este proyecto falta graphify.{' '}
          </Text>
          {error}
          {libre && <Button key="instalar" label="Instalar graphify" hotkey="i" onPress={() => lanzar($, () => instalar($))} />}
          {libre && !s.tieneGrafo && <Button key="ahora-no" label="Ahora no" onPress={() => lanzar($, () => ahoraNo($))} />}
        </Box>
      )
    }
    if (!s.tieneGrafo) {
      const cuantos = s.archivos !== null ? ` (${miles(s.archivos)} archivos)` : ''
      return (
        <Box>
          <Text dimColor wrap="truncate-end">
            {s.tarea !== null ? `🧠 ${s.tarea}` : `🧠 ${nombre(s.raiz)} aún no tiene segundo cerebro${cuantos}.`}{' '}
          </Text>
          {error}
          {libre && <Button key="crear" label="Crear · rápido" hotkey="c" onPress={() => lanzar($, () => actualizar($, 'crear'))} />}
          {libre && <Button key="completo" label="Completo · con IA" onPress={() => lanzar($, () => completo($))} />}
          {libre && <Button key="ahora-no" label="Ahora no" onPress={() => lanzar($, () => ahoraNo($))} />}
        </Box>
      )
    }

    const ahora = await $.clock.now()
    const revisado =
      s.revisadoMs !== null && (s.actualizadoMs === null || s.revisadoMs > s.actualizadoMs) ? s.revisadoMs : null
    const resumen =
      s.tarea !== null
        ? `🧠 ${s.tarea}`
        : revisado !== null
          ? `🧠 Grafo al día (revisado ${haceCuanto(revisado, ahora)})`
          : `🧠 Grafo actualizado${s.actualizadoMs === null ? '' : ` ${haceCuanto(s.actualizadoMs, ahora)}`}`
    const pendiente = s.pendiente && s.tarea === null ? (s.auto ? ' · se actualiza al terminar' : ' · hay cambios sin pasar') : ''

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {resumen}
          {pendiente}{' '}
        </Text>
        {error}
        {libre && <Button key="actualizar" label="Actualizar grafo" hotkey="g" onPress={() => lanzar($, () => actualizar($, 'actualizar'))} />}
        {libre && s.forzable && <Button key="forzar" label="Forzar" hotkey="f" onPress={() => lanzar($, () => actualizar($, 'forzar'))} />}
        {libre && <Button key="mapa" label="Ver mapa" onPress={() => lanzar($, () => abrirMapa($))} />}
      </Box>
    )
  })
}
