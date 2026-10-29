/** Lo que la franja muestra, lo que /cerebro consulta y lo que se le dice a Claude. */
export type EstadoCerebro = {
  /** Si graphify está en este equipo: se revisa al abrir la sesión. */
  graphify: 'revisando' | 'falta' | 'instalando' | 'listo'
  /** El ejecutable de graphify que respondió, o null si falta. */
  programa: string | null
  /** La versión que dijo graphify --version. */
  version: string | null
  /** Carpeta del proyecto: la que tiene graphify-out/graph.json, si no la raíz de git, si no la de la sesión. Null en el HOME. */
  raiz: string | null
  /** True si raiz/graphify-out/graph.json existe. */
  tieneGrafo: boolean
  /** Archivos que git sigue en el proyecto (para el aviso del primer grafo); null sin git. */
  archivos: number | null
  /** Última modificación de graph.json, en milisegundos desde la época. */
  actualizadoMs: number | null
  /** Cuándo graphify confirmó por última vez, desde esta sesión, que el grafo está al día. */
  revisadoMs: number | null
  /** Lo que graphify está haciendo ahora desde esta sesión («Creando el grafo…»), o null. */
  tarea: string | null
  /** Por qué falló el último intento; null si salió bien o todavía no ha corrido. */
  fallo: string | null
  /** True cuando graphify no reemplazó el grafo por tener menos nodos: --force lo arregla. */
  forzable: boolean
  /** True si Claude cambió código del proyecto desde la última actualización. */
  pendiente: boolean
  /** True si la persona dijo «Ahora no» al primer grafo de este proyecto. */
  descartado: boolean
  /** Actualizar solo al terminar cada turno en que cambió código. */
  auto: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'segundo-cerebro': { estado: EstadoCerebro; minuto: number }
  }
}
