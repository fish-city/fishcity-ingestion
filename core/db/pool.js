import mysql from "mysql2";
import dotenv from "dotenv";

dotenv.config();

let pool = null;

export function getPool() {
  if (pool) return pool;

  const options = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB,
    charset: "utf8mb4",
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    dateStrings: true,
    multipleStatements: true,
    typeCast: (field, next) => {
      if (field.type === "JSON") {
        return JSON.parse(field.string());
      }
      return next();
    }
  };

  pool = mysql.createPool(options);

  // Set timezone on every new connection
  pool.on("connection", (conn) => {
    conn.query(`SET time_zone = '${process.env.TZ_DB || "+00:00"}';`, (error) => {
      if (error) throw error;
    });
  });

  console.log(`[db] Pool created (limit: ${options.connectionLimit})`);
  return pool;
}

export function endPool() {
  return new Promise((resolve) => {
    if (!pool) return resolve();
    pool.end((err) => {
      if (err) console.error("[db] Pool end error:", err.message);
      else console.log("[db] Pool closed.");
      pool = null;
      resolve();
    });
  });
}
