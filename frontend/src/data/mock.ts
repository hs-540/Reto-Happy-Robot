import type {
  AgentView,
  FeedItem,
  StateView,
  TopologyView,
} from '@reto/shared'

export const SEGUNDO_ACTUAL = 150

export const topology: TopologyView = {
  crisis: {
    titulo: 'Apagón regional — Getafe, Comunidad de Madrid',
    duracionSegundos: 300,
    momentos: [
      { atSeconds: 0, titulo: 'Apagón inicial en la subestación' },
      { atSeconds: 40, titulo: 'Datacenter se sobrecalienta' },
      { atSeconds: 90, titulo: 'Hospital pierde el generador' },
      { atSeconds: 150, titulo: 'ETA incumplida: replanteamiento' },
      { atSeconds: 240, titulo: 'Subestación reparada' },
    ],
  },
  elementos: [
    {
      id: 'sub-01',
      type: 'subestacion',
      name: 'Subestación Getafe-Sur',
      lat: 40.3057,
      lng: -3.7327,
      criticidad: 70,
    },
    {
      id: 'dc-01',
      type: 'datacenter',
      name: 'CPD Metropolitano Getafe',
      lat: 40.295,
      lng: -3.72,
      criticidad: 60,
    },
    {
      id: 'hosp-01',
      type: 'hospital',
      name: 'Hospital Regional Getafe-Sur',
      lat: 40.31,
      lng: -3.71,
      criticidad: 95,
    },
  ],
  recursos: [
    { id: 'cuadrilla-1', type: 'cuadrilla', lat: 40.302, lng: -3.722 },
    { id: 'generador-1', type: 'generador', lat: 40.302, lng: -3.722 },
    { id: 'generador-2', type: 'generador', lat: 40.302, lng: -3.722 },
  ],
}

export const state: StateView = {
  tick: 42,
  pausado: false,
  relojSimulacion: '2026-09-18T10:02:30.000Z',
  ultimoSeq: 21,
  elementos: [
    {
      id: 'sub-01',
      type: 'subestacion',
      name: 'Subestación Getafe-Sur',
      lat: 40.3057,
      lng: -3.7327,
      status: 'critico',
      severidad: 90,
      sensores: { tension_red: 12, cobertura_red: 20 },
      atencion: {
        estado: 'analizando',
        recursoId: null,
        decisionActivaId: 'dec-006',
      },
      actualizadoEn: '2026-09-18T10:02:30.000Z',
    },
    {
      id: 'dc-01',
      type: 'datacenter',
      name: 'CPD Metropolitano Getafe',
      lat: 40.295,
      lng: -3.72,
      status: 'degradado',
      severidad: 70,
      sensores: { temperatura: 48, carga_ups: 12 },
      atencion: {
        estado: 'recurso_asignado',
        recursoId: 'cuadrilla-1',
        decisionActivaId: 'dec-005',
      },
      actualizadoEn: '2026-09-18T10:02:30.000Z',
    },
    {
      id: 'hosp-01',
      type: 'hospital',
      name: 'Hospital Regional Getafe-Sur',
      lat: 40.31,
      lng: -3.71,
      status: 'critico',
      severidad: 85,
      sensores: { bateria_generador: 18, tension_red: 12 },
      atencion: {
        estado: 'recurso_asignado',
        recursoId: 'generador-2',
        decisionActivaId: 'dec-004',
      },
      actualizadoEn: '2026-09-18T10:02:30.000Z',
    },
  ],
  recursos: [
    {
      id: 'cuadrilla-1',
      type: 'cuadrilla',
      status: 'en_transito',
      assignedElementId: 'dc-01',
      lat: 40.2986,
      lng: -3.7163,
    },
    {
      id: 'generador-1',
      type: 'generador',
      status: 'disponible',
      assignedElementId: null,
      lat: 40.302,
      lng: -3.722,
    },
    {
      id: 'generador-2',
      type: 'generador',
      status: 'asignado',
      assignedElementId: 'hosp-01',
      lat: 40.3089,
      lng: -3.7121,
    },
  ],
}

export const agent: AgentView = {
  tick: 42,
  pausado: false,
  planActual: {
    objetivo: 'Estabilizar el hospital antes de que se agote el generador',
    generadoEn: '2026-09-18T10:02:10.000Z',
    replanDe: 'dec-003',
    pasos: [
      {
        id: 'p1',
        descripcion: 'Asignar generador-2 a hosp-01',
        elementId: 'hosp-01',
        completado: true,
      },
      {
        id: 'p2',
        descripcion: 'Llamar al responsable del hospital',
        elementId: 'hosp-01',
        completado: false,
      },
      {
        id: 'p3',
        descripcion: 'Mantener cuadrilla en dc-01',
        elementId: 'dc-01',
        completado: true,
      },
      {
        id: 'p4',
        descripcion: 'Reevaluar subestación cuando haya cuadrilla libre',
        elementId: 'sub-01',
        completado: false,
      },
    ],
  },
  decisiones: [
    {
      id: 'dec-003',
      timestamp: '2026-09-18T10:02:10.000Z',
      elementId: 'hosp-01',
      prioridad: 1,
      razonamiento:
        'El hospital tiene criticidad 95 y solo 18% de batería. Replanifico: el datacenter puede esperar 5 min, el hospital no. Reasigno generador-2 de inmediato.',
      provocaReplan: true,
      acciones: [],
    },
    {
      id: 'dec-004',
      timestamp: '2026-09-18T10:02:12.000Z',
      elementId: 'hosp-01',
      prioridad: 1,
      razonamiento:
        'Confirmo generador-2 en ruta al hospital. Aviso al responsable por voz para cortar el suministro 10 min durante la conexión.',
      provocaReplan: false,
      acciones: [
        {
          id: 'act-007',
          type: 'llamada_voz',
          targetElementId: 'hosp-01',
          destinatario: 'responsable_hospital',
          status: 'propuesta',
          mensaje:
            'Cortaremos suministro 10 min para conectar el generador portátil. Confirme recepción.',
          timestamp: '2026-09-18T10:02:12.000Z',
        },
      ],
    },
    {
      id: 'dec-005',
      timestamp: '2026-09-18T10:02:20.000Z',
      elementId: 'dc-01',
      prioridad: 2,
      razonamiento:
        'La temperatura del datacenter sube a 48°C. Mantengo cuadrilla en ruta y aviso para cierre preventivo de pasillos calientes.',
      provocaReplan: false,
      acciones: [
        {
          id: 'act-008',
          type: 'mensaje_chat',
          targetElementId: 'dc-01',
          destinatario: 'operador_cpd',
          status: 'ejecutada',
          mensaje: 'Cierre preventivo de pasillos calientes. Mantened UPS por debajo del 80%.',
          timestamp: '2026-09-18T10:02:21.000Z',
        },
      ],
    },
    {
      id: 'dec-006',
      timestamp: '2026-09-18T10:02:28.000Z',
      elementId: 'sub-01',
      prioridad: 3,
      razonamiento:
        'Sin cuadrilla libre, la subestación queda en observación. Es el origen del apagón pero no es recuperable hasta liberar un recurso.',
      provocaReplan: false,
      acciones: [],
    },
  ],
  acciones: [
    {
      id: 'act-007',
      type: 'llamada_voz',
      targetElementId: 'hosp-01',
      destinatario: 'responsable_hospital',
      status: 'propuesta',
      mensaje:
        'Cortaremos suministro 10 min para conectar el generador portátil. Confirme recepción.',
      timestamp: '2026-09-18T10:02:12.000Z',
    },
    {
      id: 'act-008',
      type: 'mensaje_chat',
      targetElementId: 'dc-01',
      destinatario: 'operador_cpd',
      status: 'ejecutada',
      mensaje: 'Cierre preventivo de pasillos calientes. Mantened UPS por debajo del 80%.',
      timestamp: '2026-09-18T10:02:21.000Z',
    },
  ],
}

export const feed: FeedItem[] = [
  {
    seq: 15,
    ts: '2026-09-18T10:02:00.000Z',
    kind: 'alarma',
    elementId: 'hosp-01',
    metric: 'bateria_generador',
    value: 18,
    severidad: 85,
  },
  {
    seq: 16,
    ts: '2026-09-18T10:02:10.000Z',
    kind: 'decision',
    elementId: 'hosp-01',
    decisionId: 'dec-003',
    prioridad: 1,
    razonamiento: 'Replanifico: prioridad absoluta al hospital, el datacenter puede esperar.',
    provocaReplan: true,
  },
  {
    seq: 17,
    ts: '2026-09-18T10:02:12.000Z',
    kind: 'accion',
    elementId: 'hosp-01',
    actionId: 'act-007',
    tipo: 'llamada_voz',
    estado: 'propuesta',
    mensaje: 'Llamada al responsable del hospital pendiente de confirmación.',
  },
  {
    seq: 18,
    ts: '2026-09-18T10:02:20.000Z',
    kind: 'alarma',
    elementId: 'dc-01',
    metric: 'temperatura',
    value: 48,
    severidad: 70,
  },
  {
    seq: 19,
    ts: '2026-09-18T10:02:21.000Z',
    kind: 'decision',
    elementId: 'dc-01',
    decisionId: 'dec-005',
    prioridad: 2,
    razonamiento: 'Mantengo cuadrilla en ruta y activo cierre preventivo de pasillos.',
    provocaReplan: false,
  },
  {
    seq: 20,
    ts: '2026-09-18T10:02:22.000Z',
    kind: 'accion',
    elementId: 'dc-01',
    actionId: 'act-008',
    tipo: 'mensaje_chat',
    estado: 'ejecutada',
    mensaje: 'Mensaje enviado a operador_cpd: cierre preventivo de pasillos calientes.',
  },
  {
    seq: 21,
    ts: '2026-09-18T10:02:28.000Z',
    kind: 'sistema',
    mensaje: 'Replanificación completa: la cuadrilla no cumple su ETA hacia el datacenter.',
  },
]

export const nombresElemento = Object.fromEntries(
  topology.elementos.map((e) => [e.id, e.name]),
)
