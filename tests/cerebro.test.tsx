import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const HOME = '/home/prueba'
const RAIZ = `${HOME}/proyectos/tienda`
const GRAFO = `${RAIZ}/graphify-out/graph.json`
const GRAPHIFY = `${HOME}/.local/bin/graphify`
const SALIDA = '[graphify watch] Rebuilt: 1284 nodes, 3010 edges, 41 communities'
const AHORA = 1_800_000_000_000

const BANDA = {
  plugin: 'segundo-cerebro',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Opciones = { instalado?: boolean; conGrafo?: boolean; cwd?: string; sinInstaladores?: boolean }
type Maquina = { corridas: { argv: string[]; cwd?: string }[]; avisos: string[] }

/** Lo que hay debajo del mod: el HOME, un proyecto con git, el grafo y un graphify de mentira. */
function maquina(on: On, opciones: Opciones = {}): Maquina {
  const corridas: { argv: string[]; cwd?: string }[] = []
  const avisos: string[] = []
  let instalado = opciones.instalado ?? true
  let fecha: number | null = opciones.conGrafo ? AHORA - 3 * 60 * 60 * 1000 : null
  const cwd = opciones.cwd ?? `${RAIZ}/src`

  mock.env(on, { HOME })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: (e.path === GRAFO && fecha !== null) || (e.path === GRAPHIFY && instalado) }))
  on('fs.stat', ($, e) =>
    e.path === GRAFO && fecha !== null ? { value: { kind: 'file', size: 1, mtimeMs: fecha, isLink: false } } : { deny: `ENOENT: ${e.path}` },
  )
  on('process.run', ($, e) => {
    corridas.push({ argv: [...e.argv], cwd: e.init?.cwd })
    const [cmd, ...args] = e.argv
    const salir = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (cmd === 'git' && args[0] === 'rev-parse') return salir(0, `${RAIZ}\n`)
    if (cmd === 'git' && args[0] === 'ls-files') return salir(0, 'a.py\nb.py\nREADME.md\n')
    if (cmd === 'uv') {
      if (opciones.sinInstaladores) return { deny: 'ENOENT: uv' }
      instalado = true
      return salir(0)
    }
    if (cmd === GRAPHIFY) {
      if (!instalado) return { deny: `ENOENT: ${cmd}` }
      if (args[0] === '--version') return salir(0, 'graphify 0.9.38\n')
      if (args[0] === 'update') {
        fecha = AHORA
        return salir(0, SALIDA)
      }
      return salir(0)
    }
    return { deny: `ENOENT: ${cmd}` }
  })
  on('ui.toast', ($, e) => {
    avisos.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'del-motor' }) as RenderElement
  })
  return { corridas, avisos }
}

const arrancar = ($: Engine, cwd = `${RAIZ}/src`) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
const textos = async (banda: { find: (q: never) => Promise<unknown> }) =>
  ((await banda.find({ type: 'Text' } as never)) as { text?: string } | undefined)?.text ?? ''
const botones = async (banda: { findAll: (q: never) => Promise<unknown[]> }) =>
  ((await banda.findAll({ type: 'Button' } as never)) as { props: { label: string } }[]).map(b => b.props.label)

test('sin graphify ofrece instalarlo: uv, la skill oficial y queda listo', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const { corridas, avisos } = maquina(on, { instalado: false })
  await arrancar($)
  await reloj.settle()
  const banda = await $.ui.mount(BANDA)
  expect(await textos(banda)).toContain('falta graphify')

  await banda.press({ key: 'instalar' })
  await reloj.settle()

  const argvs = corridas.map(c => c.argv.join(' '))
  expect(argvs).toContain('uv tool install --upgrade graphifyy')
  expect(argvs).toContain(`${GRAPHIFY} install --platform claude`)
  expect(avisos.at(-1)).toContain('graphify 0.9.38 instalado')
  expect(await textos(banda)).toContain('tienda aún no tiene segundo cerebro (3 archivos)')
})

test('sin ningún instalador lo dice y sugiere uv', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const { avisos } = maquina(on, { instalado: false, sinInstaladores: true })
  await arrancar($)
  await reloj.settle()
  const banda = await $.ui.mount(BANDA)
  await banda.press({ key: 'instalar' })
  await reloj.settle()
  expect(avisos.at(-1)).toContain('Instala uv')
})

test('un proyecto sin grafo: «Crear · rápido» corre graphify update . en la raíz de git', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const { corridas, avisos } = maquina(on)
  await arrancar($)
  await reloj.settle()
  const banda = await $.ui.mount(BANDA)
  expect(await botones(banda)).toEqual(['Crear · rápido', 'Completo · con IA', 'Ahora no'])

  await banda.press({ key: 'crear' })
  await reloj.settle()

  expect(corridas.find(c => c.argv[1] === 'update')).toEqual({ argv: [GRAPHIFY, 'update', '.'], cwd: RAIZ })
  expect(avisos.at(-1)).toContain('Segundo cerebro listo: 1.284 nodos, 3.010 relaciones')
  expect(await textos(banda)).toContain('Grafo actualizado hace un momento')
})

test('«Ahora no» se recuerda: la franja deja de ofrecerlo en ese proyecto', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  maquina(on)
  await arrancar($)
  await reloj.settle()
  const banda = await $.ui.mount(BANDA)
  await banda.press({ key: 'ahora-no' })
  await reloj.settle()
  expect(await banda.find({ key: 'del-motor' } as never)).toBeDefined()
  // Una sesión nueva lo lee del almacén: tampoco lo ofrece.
  await arrancar($)
  await reloj.settle()
  expect(await (await $.ui.mount(BANDA)).find({ key: 'del-motor' } as never)).toBeDefined()
})

test('con grafo, Claude recibe la instrucción de consultarlo primero', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  maquina(on, { conGrafo: true })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'hola', scope: 'shared' }] }))
  await arrancar($)
  await reloj.settle()
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const nuestra = sections.find(s => s.id === 'segundo-cerebro:grafo')
  expect(nuestra?.text).toContain(`${RAIZ}/graphify-out`)
  expect(nuestra?.text).toContain('graphify query')
})

test('Claude edita código: al terminar el turno el grafo se actualiza solo; un .md no cuenta', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  const { corridas } = maquina(on, { conGrafo: true })
  on('tool.call', () => ({ result: { ok: true } }) as never)
  on('turn.complete', () => ({ text: '' }))
  await arrancar($)
  await reloj.settle()
  const banda = await $.ui.mount(BANDA)
  expect(await textos(banda)).toContain('Grafo actualizado hace 3 h')
  const fin = { answer: 'listo', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never
  const updates = () => corridas.filter(c => c.argv[1] === 'update').length

  await $.tool.call({ tool: 'Edit', file_path: `${RAIZ}/README.md`, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(fin)
  await reloj.settle()
  expect(updates()).toBe(0)

  await $.tool.call({ tool: 'Edit', file_path: `${RAIZ}/src/ventas.py`, old_string: 'a', new_string: 'b' } as never)
  expect(await textos(banda)).toContain('se actualiza al terminar')
  await $.turn.complete(fin)
  await reloj.settle()
  expect(updates()).toBe(1)
  expect(await textos(banda)).toContain('Grafo actualizado hace un momento')
})

test('en la carpeta personal no ofrece nada', async ($, on) => {
  const reloj = mock.clock(on, { now: AHORA })
  maquina(on, { cwd: HOME })
  await arrancar($, HOME)
  await reloj.settle()
  const banda = await $.ui.mount(BANDA)
  expect(await banda.find({ key: 'del-motor' } as never)).toBeDefined()
})
