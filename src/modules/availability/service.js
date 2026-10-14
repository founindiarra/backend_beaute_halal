import { query } from '../../config/database.js'
import { getSettings } from '../salon/model.js'

/**
 * Disponibilité réelle du salon.
 *
 * Un créneau n'est plus proposé parce que le salon est ouvert à cette
 * heure-là : il l'est parce qu'IL RESTE QUELQU'UN POUR LE FAIRE. Trois
 * questions sont posées, dans cet ordre, et la première qui échoue ferme le
 * créneau :
 *
 *   1. Le salon est-il ouvert ce jour-là, à cette heure-là ?
 *   2. La prestation se termine-t-elle avant la fermeture ?
 *   3. Reste-t-il au moins un agent libre pendant toute sa durée ?
 *
 * La capacité n'est donc jamais un nombre arbitraire de rendez-vous par
 * jour : elle se déduit des horaires, de la durée demandée et des agents
 * réellement en poste. Deux agents doublent le nombre de créneaux tenables ;
 * une prestation de quatre heures en laisse mécaniquement moins qu'une
 * prestation d'une heure.
 *
 * ⚠️ Un rendez-vous n'occupe un agent que s'il est à un statut qui tient la
 * place. Un refus, une annulation et une absence libèrent le créneau ; une
 * demande encore en attente l'occupe ou non selon le réglage
 * `capacity_include_pending` (paramètres du salon).
 */

/** Délai minimum entre maintenant et un créneau réservable le jour même (minutes). */
const MIN_LEAD_MINUTES = 60

/** Statuts qui occupent effectivement un agent sur le créneau. */
const BLOCKING_STATUSES = ['confirmed', 'arrived', 'in_progress', 'completed']

/** Date locale au format 'AAAA-MM-JJ' (jamais d'UTC, pour éviter tout décalage). */
export function toDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const month = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  return toDateKey(date)
}

/** Jour de la semaine (0 = dimanche) d'une clé 'AAAA-MM-JJ', sans passer par UTC. */
export function weekdayOf(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number)
  return hours * 60 + minutes
}

/* ─────────────────────────── Chargement des règles ──────────────────────── */

/**
 * Charge une fois toutes les règles du planning, agents compris.
 *
 * `works_from` / `works_to` à NULL signifie « suit les horaires du salon » :
 * c'est le cas par défaut, et celui de tous les agents déjà enregistrés.
 */
export async function loadSchedule() {
  const [hours, slots, closureRows, agents, settings] = await Promise.all([
    query('SELECT weekday, is_closed, opens_at, closes_at FROM opening_hours'),
    query('SELECT start_time FROM time_slots WHERE is_active = 1 ORDER BY position, start_time'),
    query('SELECT closure_date, reason FROM closures'),
    query('SELECT id, name, works_from, works_to FROM team_members WHERE is_active = 1'),
    getSettings(),
  ])

  return {
    hoursByWeekday: new Map(hours.map((row) => [Number(row.weekday), row])),
    slots: slots.map((row) => String(row.start_time)),
    closures: new Map(closureRows.map((row) => [row.closure_date, row.reason])),
    agents: agents.map((row) => ({
      id: row.id,
      name: row.name,
      from: row.works_from ? toMinutes(row.works_from) : null,
      to: row.works_to ? toMinutes(row.works_to) : null,
    })),
    windowDays: Number(settings.booking_window_days) || 60,
    includePending: settings.capacity_include_pending !== '0',
    /*
     * Tant qu'aucun agent actif n'est enregistré, la capacité ne peut pas
     * être calculée : elle vaudrait zéro et fermerait TOUTES les dates du
     * site public. Dans ce cas on garde le comportement d'avant — seules
     * les heures d'ouverture décident — et l'API le signale par ce drapeau.
     * Dès qu'une coiffeuse est saisie, le calcul reprend de lui-même.
     */
    hasAgents: agents.length > 0,
  }
}

/**
 * Durée de référence quand l'appelant n'a pas dit quelle prestation il vise.
 *
 * On prend la PLUS COURTE des prestations actives, volontairement : sans
 * information, une date ne doit être déclarée complète que si plus rien du
 * tout n'y tient. Annoncer « complet » à quelqu'un qui n'a pas encore choisi
 * sa prestation serait faux pour la moitié du catalogue.
 */
export async function defaultDuration() {
  const row = await query(
    'SELECT MIN(duration_minutes) AS shortest FROM services WHERE is_active = 1',
  )
  return Number(row?.[0]?.shortest) || 60
}

export async function durationOfService(serviceId) {
  if (!serviceId) return null
  const rows = await query(
    'SELECT duration_minutes FROM services WHERE id = ? AND is_active = 1 LIMIT 1',
    [serviceId],
  )
  return rows.length ? Number(rows[0].duration_minutes) : null
}

/**
 * Rendez-vous qui occupent un agent, sur une plage de dates.
 * Chacun est réduit à ce qui compte pour le calcul : son intervalle en
 * minutes et l'agent auquel il est affecté (`null` = n'importe lequel).
 */
export async function loadBusy(fromKey, toKey, { includePending = true } = {}) {
  const statuses = includePending ? [...BLOCKING_STATUSES, 'pending'] : BLOCKING_STATUSES
  const rows = await query(
    `SELECT appointment_date, appointment_time, duration_minutes, staff_id
     FROM appointments
     WHERE status IN (${statuses.map(() => '?').join(', ')})
       AND appointment_date BETWEEN ? AND ?`,
    [...statuses, fromKey, toKey],
  )

  const byDate = new Map()
  rows.forEach((row) => {
    const start = toMinutes(row.appointment_time)
    const entry = {
      start,
      end: start + Number(row.duration_minutes),
      staffId: row.staff_id ?? null,
    }
    const key = String(row.appointment_date)
    if (!byDate.has(key)) byDate.set(key, [])
    byDate.get(key).push(entry)
  })
  return byDate
}

/** Nombre de demandes par créneau — informatif, n'interdit rien par lui-même. */
export async function loadSlotDemand(fromKey, toKey) {
  const rows = await query(
    `SELECT appointment_date, appointment_time, COUNT(*) AS total
     FROM appointments
     WHERE status IN ('pending', 'confirmed') AND appointment_date BETWEEN ? AND ?
     GROUP BY appointment_date, appointment_time`,
    [fromKey, toKey],
  )
  const demand = new Map()
  rows.forEach((row) =>
    demand.set(`${row.appointment_date} ${String(row.appointment_time)}`, Number(row.total)),
  )
  return demand
}

/** Raison pour laquelle une journée n'est pas ouverte, ou null si elle l'est. */
export function dayClosedReason(dateKey, schedule, todayKey = toDateKey()) {
  if (dateKey < todayKey) return 'past'
  if (dateKey > addDays(todayKey, schedule.windowDays)) return 'out_of_window'
  if (schedule.closures.has(dateKey)) return 'closed_exceptionally'

  const hours = schedule.hoursByWeekday.get(weekdayOf(dateKey))
  if (!hours || Number(hours.is_closed) === 1) return 'closed'

  return null
}

/* ───────────────────────────── Le calcul ────────────────────────────────── */

const overlaps = (a, b) => a.start < b.end && b.start < a.end

/**
 * Combien d'agents peuvent prendre l'intervalle [debut, fin[, et combien sont
 * déjà pris dessus.
 *
 * Les rendez-vous sans agent désigné — c'est le cas de tout ce qui vient du
 * site public — consomment un agent quelconque du vivier. On les compte donc
 * séparément, puis on retire d'abord ceux qui visent un agent précis : un
 * agent nommément occupé ne peut pas absorber en plus un rendez-vous flottant.
 */
export function capacityFor(interval, occupied, agents, hours) {
  const ouverture = hours.opens_at ? toMinutes(hours.opens_at) : 0
  const fermeture = hours.closes_at ? toMinutes(hours.closes_at) : 24 * 60

  // Agents dont la plage de travail couvre tout l'intervalle demandé.
  const disponibles = agents.filter((agent) => {
    const debut = Math.max(agent.from ?? ouverture, ouverture)
    const fin = Math.min(agent.to ?? fermeture, fermeture)
    return debut <= interval.start && interval.end <= fin
  })

  if (!disponibles.length) return { capable: 0, free: 0 }

  /*
   * Chaque rendez-vous qui empiète sur l'intervalle occupe UNE coiffeuse,
   * qu'il en désigne une ou non.
   *
   * On ne cherche pas à savoir laquelle : la plupart des rendez-vous
   * viennent du site public, où la cliente ne choisit personne, et le salon
   * répartit à l'accueil. Compter les agents nommés distincts reviendrait à
   * ne compter qu'une place là où deux rendez-vous auraient été affectés par
   * erreur à la même coiffeuse — et à promettre un créneau qui n'existe pas.
   * Compter les rendez-vous est plus prudent, et c'est ce qui se vérifie sur
   * le terrain : quatre coiffeuses, quatre prestations à la fois.
   */
  const occupes = occupied.filter((item) => overlaps(item, interval)).length

  return { capable: disponibles.length, free: Math.max(disponibles.length - occupes, 0) }
}

/**
 * Créneaux d'une journée, avec la raison exacte de chaque fermeture.
 *
 * `duration` est la durée de la prestation visée. C'est elle qui décide du
 * dernier créneau possible : une prestation de deux heures dans un salon qui
 * ferme à 18 h ne peut pas commencer à 17 h. Le dernier départ acceptable est
 * celui qui permet de finir à 18 h pile, jamais après.
 */
export function buildDaySlots(
  dateKey,
  schedule,
  { demand = new Map(), busy = [], duration = 60, now = new Date() } = {},
) {
  const todayKey = toDateKey(now)
  const closedReason = dayClosedReason(dateKey, schedule, todayKey)

  if (closedReason) {
    return schedule.slots.map((time) => ({
      time: time.slice(0, 5),
      available: false,
      reason: closedReason,
      requests: 0,
      agentsFree: 0,
    }))
  }

  const hours = schedule.hoursByWeekday.get(weekdayOf(dateKey))
  const opensAt = hours.opens_at ? toMinutes(hours.opens_at) : null
  const closesAt = hours.closes_at ? toMinutes(hours.closes_at) : null
  const isToday = dateKey === todayKey
  const nowMinutes = now.getHours() * 60 + now.getMinutes()

  return schedule.slots.map((time) => {
    const start = toMinutes(time)
    const interval = { start, end: start + duration }
    let reason = null
    let agentsFree = 0

    if (opensAt !== null && start < opensAt) reason = 'before_opening'
    else if (closesAt !== null && start >= closesAt) reason = 'after_closing'
    // La prestation doit tenir entièrement avant la fermeture.
    else if (closesAt !== null && interval.end > closesAt) reason = 'not_enough_time'
    else if (isToday && start < nowMinutes + MIN_LEAD_MINUTES) reason = 'too_soon'
    else if (schedule.hasAgents) {
      const { capable, free } = capacityFor(interval, busy, schedule.agents, hours)
      agentsFree = free
      if (!capable) reason = 'no_agent'
      else if (free <= 0) reason = 'full'
    }

    return {
      time: time.slice(0, 5),
      available: reason === null,
      reason,
      requests: demand.get(`${dateKey} ${time}`) ?? 0,
      agentsFree,
    }
  })
}

/* ─────────────────────────────── API ────────────────────────────────────── */

/** Calendrier : pour chaque jour, ouvert ou non, et combien de créneaux tiennent. */
export async function getDays(fromKey, toKey, { serviceId = null } = {}) {
  const schedule = await loadSchedule()
  const duration = (await durationOfService(serviceId)) ?? (await defaultDuration())

  const [demand, busyByDate] = await Promise.all([
    loadSlotDemand(fromKey, toKey),
    loadBusy(fromKey, toKey, { includePending: schedule.includePending }),
  ])
  const now = new Date()

  const days = []
  let cursor = fromKey
  let guard = 0

  while (cursor <= toKey && guard < 400) {
    const slots = buildDaySlots(cursor, schedule, {
      demand,
      busy: busyByDate.get(cursor) ?? [],
      duration,
      now,
    })
    const free = slots.filter((slot) => slot.available).length
    days.push({
      date: cursor,
      weekday: weekdayOf(cursor),
      bookable: free > 0,
      availableSlots: free,
      totalSlots: slots.length,
      reason: free > 0 ? null : dayClosedReason(cursor, schedule, toDateKey(now)) || 'full',
    })
    cursor = addDays(cursor, 1)
    guard += 1
  }

  return {
    days,
    windowDays: schedule.windowDays,
    durationMinutes: duration,
    agents: schedule.agents.length,
    capacityEnabled: schedule.hasAgents,
  }
}

/** Créneaux d'une journée précise. */
export async function getSlots(dateKey, { serviceId = null } = {}) {
  const schedule = await loadSchedule()
  const duration = (await durationOfService(serviceId)) ?? (await defaultDuration())

  const [demand, busyByDate] = await Promise.all([
    loadSlotDemand(dateKey, dateKey),
    loadBusy(dateKey, dateKey, { includePending: schedule.includePending }),
  ])

  const slots = buildDaySlots(dateKey, schedule, {
    demand,
    busy: busyByDate.get(dateKey) ?? [],
    duration,
  })

  return {
    date: dateKey,
    slots,
    bookable: slots.some((slot) => slot.available),
    durationMinutes: duration,
    agents: schedule.agents.length,
    capacityEnabled: schedule.hasAgents,
  }
}

const MESSAGES = {
  past: 'Cette date est déjà passée.',
  out_of_window: 'Cette date est hors de la période de réservation.',
  closed: 'Le salon est fermé ce jour-là.',
  closed_exceptionally: 'Le salon est exceptionnellement fermé ce jour-là.',
  too_soon: 'Ce créneau est trop proche : choisissez un horaire plus tardif.',
  before_opening: 'Ce créneau est avant l’ouverture du salon.',
  after_closing: 'Ce créneau est après la fermeture du salon.',
  not_enough_time: 'Cette prestation ne pourrait pas se terminer avant la fermeture.',
  no_agent: 'Aucune coiffeuse n’est en poste sur cette plage horaire.',
  full: 'Toutes les coiffeuses sont déjà prises sur ce créneau.',
}

/**
 * Vérifie qu'une demande peut être déposée — appelé avant toute création.
 *
 * `serviceId` est attendu ici : c'est la prestation qui décide si le créneau
 * tient avant la fermeture et s'il reste quelqu'un pour la faire.
 */
export async function assertSlotBookable(dateKey, time, { serviceId = null } = {}) {
  const normalized = time.length === 5 ? `${time}:00` : time
  const schedule = await loadSchedule()

  if (!schedule.slots.includes(normalized)) {
    return { ok: false, reason: 'unknown_slot', message: 'Ce créneau n’est pas proposé.' }
  }

  const duration = (await durationOfService(serviceId)) ?? (await defaultDuration())
  const busyByDate = await loadBusy(dateKey, dateKey, { includePending: schedule.includePending })

  const slot = buildDaySlots(dateKey, schedule, {
    busy: busyByDate.get(dateKey) ?? [],
    duration,
  }).find((item) => item.time === normalized.slice(0, 5))

  if (!slot || slot.available) return { ok: true, time: normalized }

  const message =
    slot.reason === 'out_of_window'
      ? `Les réservations sont ouvertes sur ${schedule.windowDays} jours seulement.`
      : (MESSAGES[slot.reason] ?? 'Ce créneau n’est pas disponible.')

  return { ok: false, reason: slot.reason ?? 'unavailable', message }
}
