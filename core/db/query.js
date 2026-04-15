import mysql from "mysql2";
import { getPool } from "./pool.js";

const MAX_RETRIES = 3;
const DEADLOCK_CODES = ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"];

function runQuery(desc, sql, params = []) {
  return new Promise((resolve, reject) => {
    const formatted = mysql.format(sql, params).replace(/(\r\n|\n|\r)/gm, "").replace(/\s+/g, " ");
    getPool().getConnection((err, connection) => {
      if (err) {
        if (connection) connection.release();
        console.error(`[db] ${desc} connection error:`, err.message);
        return reject(err);
      }
      connection.query(formatted, (error, results) => {
        connection.release();
        if (error) return reject(error);
        resolve(results);
      });
    });
  });
}

export async function getSingleRecord(desc, sql, params = []) {
  const results = await runQuery(desc, sql, params);
  if (!results || results.length === 0) return null;
  const row = results[0];
  const values = Object.values(row);
  // If single-column result, return the value directly (matches backend behavior)
  return values.length === 1 ? values[0] : row;
}

export async function getMultiRecords(desc, sql, params = []) {
  const results = await runQuery(desc, sql, params);
  if (!results || results.length === 0) return [];
  return results;
}

export async function insertRecord(desc, sql, params, retries = 1) {
  try {
    const results = await runQuery(desc, sql, params);
    return results.insertId;
  } catch (error) {
    if (DEADLOCK_CODES.includes(error.code) && retries < MAX_RETRIES) {
      console.warn(`[db] ${desc} deadlock, retry ${retries + 1}/${MAX_RETRIES}`);
      return insertRecord(desc, sql, params, retries + 1);
    }
    throw error;
  }
}

export async function updateRecord(desc, sql, params, retries = 1) {
  try {
    const results = await runQuery(desc, sql, params);
    return results.affectedRows;
  } catch (error) {
    if (DEADLOCK_CODES.includes(error.code) && retries < MAX_RETRIES) {
      console.warn(`[db] ${desc} deadlock, retry ${retries + 1}/${MAX_RETRIES}`);
      return updateRecord(desc, sql, params, retries + 1);
    }
    throw error;
  }
}
