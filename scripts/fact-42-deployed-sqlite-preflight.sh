#!/usr/bin/env bash
set -euo pipefail

# One-time cutover evidence. This opens the still-deployed legacy SQLite file
# read-only. It is not an OrbitFlow runtime dependency.
project="4f5a32f8-9e9d-448e-9762-06552d8b8825"
service="app"
environment="production"
legacy_path="/app/data/orbitfactory.db"

railway ssh -p "$project" -s "$service" -e "$environment" -- "node -e 'const fs=require(\"node:fs\"); const path=\"$legacy_path\"; if(!fs.existsSync(path)) throw new Error(\"legacy SQLite file is absent at \"+path); const Database=require(\"better-sqlite3\"); const db=new Database(path,{readonly:true,fileMustExist:true}); try { const result={path,projects:db.prepare(\"SELECT count(*) AS count FROM projects\").get().count,issues:db.prepare(\"SELECT count(*) AS count FROM issues\").get().count,dependencies:db.prepare(\"SELECT count(*) AS count FROM dependencies\").get().count}; process.stdout.write(JSON.stringify(result)+\"\\n\"); if(result.issues!==0||result.dependencies!==0) process.exitCode=2; } finally { db.close(); }'"
