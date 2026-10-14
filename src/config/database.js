import mysql from 'mysql2/promise'

import { config } from './env.js'

/**
 * Pool de connexions MySQL / MariaDB.
 * `dateStrings: ['DATE']` garde les dates au format 'AAAA-MM-JJ' (pas d'objet Date,
 * donc aucun décalage de fuseau horaire dans les réponses JSON).
 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: ['DATE'],
  timezone: 'local',
  supportBigNumbers: true,
  decimalNumbers: true,
})

/** Exécute une requête et renvoie toutes les lignes. */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

/** Exécute une requête et renvoie la première ligne (ou null). */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] ?? null
}

/** Exécute un INSERT/UPDATE/DELETE et renvoie le résultat brut (insertId, affectedRows…). */
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params)
  return result
}

/**
 * Exécute une série de requêtes dans une transaction.
 * `callback` reçoit la connexion : await callback(connection)
 */
export async function transaction(callback) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await callback(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

/** Vérifie que la base répond — appelé au démarrage du serveur. */
export async function assertDatabaseConnection() {
  const connection = await pool.getConnection()
  try {
    await connection.ping()
  } finally {
    connection.release()
  }
}

export async function closePool() {
  await pool.end()
}

export default pool
