#!/usr/bin/env node
// Carga horas en Kimai a partir de notas diarias.
// Requiere Node 18+ (fetch nativo). Sin dependencias.
//
// Uso:
//   node kimai-load.mjs notas.txt            -> dry-run (solo muestra qué cargaría)
//   node kimai-load.mjs notas.txt --apply    -> carga de verdad
//   node kimai-load.mjs notas.txt --apply --force  -> carga aunque el día ya tenga entradas
//   node kimai-load.mjs --list               -> lista proyectos y actividades (para sacar IDs)
//
// Variables de entorno:
//   KIMAI_URL    ej: https://kimai.tuempresa.com
//   KIMAI_TOKEN  token/API key de tu perfil de Kimai
//   KIMAI_LEGACY_HEADER=1  (opcional) usa el header X-AUTH-TOKEN en vez de Bearer

import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadEnvFile();

// ---------- Configuración (editá esto) ----------
const HOURS_PER_DAY = 8;
const START_TIME = "08:00"; // las entradas se encadenan desde acá
const BLOCK_MIN = 5;        // redondeo de cada entrada, en minutos

// Prefijo del ticket -> proyecto/actividad de Kimai (IDs numéricos).
// Sacalos con `--list` o del Swagger de tu instancia.
const CUSTOMER_ID = 15; // cliente en Kimai (se usa para filtrar en --list)
const PREFIX_MAP = {
  CP: { name: "Connect Pacientes", project: 43, activity: 274 },
  MC: { name: "Markey Connect", project: 55, activity: 274 }, // activity 274 = "Task" (confirmar con --list)
};
// ------------------------------------------------

const KIMAI_URL = (process.env.KIMAI_URL || "").replace(/\/$/, "");
const KIMAI_TOKEN = process.env.KIMAI_TOKEN;
const LEGACY = process.env.KIMAI_LEGACY_HEADER === "1";

// Opcional: consulta Kaneo vía el endpoint de chat para incluir el título de la tarea.
const KANEO_CHAT_URL = process.env.KANEO_CHAT_URL || "https://chat.jazusoft.com/api/chat/completions";
const KANEO_TOKEN = process.env.KANEO_TOKEN;
const KANEO_MODEL = process.env.KANEO_MODEL || "kaneo";
const kaneoCache = new Map();

async function ticketDescription(key, taskUrl = `https://kaneo.jazusoft.com/jazusoft/task/${key}`) {
  if (!KANEO_TOKEN) return key;
  if (kaneoCache.has(taskUrl)) return kaneoCache.get(taskUrl);

  let desc = key;
  try {
    const res = await fetch(KANEO_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KANEO_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: KANEO_MODEL,
        messages: [{
          role: "user",
          content: `puedes darme el titulo de esta tarea? Pero SOLO devolver el titulo. Nada mas. ${taskUrl}`,
        }],
        features: {
          image_generation: false,
          code_interpreter: false,
          web_search: false,
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const title = Array.isArray(content)
      ? content.map((part) => part?.text || "").join("")
      : content;
    if (typeof title === "string" && title.trim()) desc = `${key} ${title.trim()}`;
  } catch (e) {
    console.warn(`  (no pude traer el título de ${key}: ${e.message}; uso solo la clave)`);
  }
  kaneoCache.set(taskUrl, desc);
  return desc;
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const LIST = args.includes("--list");
const HELP = args.includes("--help");
const file = args.find((a) => !a.startsWith("--"));

if ((!KIMAI_URL || !KIMAI_TOKEN) && !HELP) {
  console.error("Faltan KIMAI_URL y/o KIMAI_TOKEN en el entorno.");
  process.exit(1);
}

async function api(path, opts = {}) {
  const auth = LEGACY
    ? { "X-AUTH-TOKEN": KIMAI_TOKEN }
    : { Authorization: `Bearer ${KIMAI_TOKEN}` };
  const res = await fetch(KIMAI_URL + path, {
    ...opts,
    headers: { ...auth, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// "28/09/2026 Lunes" -> fecha; cualquier "XX-123" en las líneas siguientes -> ticket
function parseNotes(text) {
  const days = new Map(); // "YYYY-MM-DD" -> [{ key, url }, ...]
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const d = line.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (d) {
      current = `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
      if (!days.has(current)) days.set(current, []);
      continue;
    }
    if (!current) continue;

    const url = line.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, "");
    for (const m of line.matchAll(/\b([A-Z]{2,})-(\d+)\b/g)) {
      const key = `${m[1]}-${m[2]}`;
      const list = days.get(current);
      if (!list.some((ticket) => ticket.key === key)) list.push({ key, url });
    }
  }
  return days;
}

// Reparte el total en n partes múltiplo de BLOCK_MIN; la última absorbe el resto.
function splitMinutes(total, n) {
  const base = Math.floor(total / n / BLOCK_MIN) * BLOCK_MIN;
  const parts = Array(n).fill(base);
  parts[n - 1] = total - base * (n - 1);
  return parts;
}

const hms = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;

const fmtDur = (m) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;

async function listRefs() {
  const projects = await api(`/api/projects?customer=${CUSTOMER_ID}&visible=1`);
  console.log(`PROYECTOS (cliente ${CUSTOMER_ID})`);
  for (const p of projects) console.log(`  ${p.id}\t${p.name}`);

  for (const cfg of Object.values(PREFIX_MAP)) {
    const activities = await api(`/api/activities?project=${cfg.project}`);
    console.log(`ACTIVIDADES de ${cfg.name} (proyecto ${cfg.project})`);
    for (const a of activities) console.log(`  ${a.id}\t${a.name}`);
  }
}

function printHelp(){
	console.log("\n=== COMANDOS ===\n")
	
	console.log("* node kimai-load.mjs --list | Verificar proyecto y actividades");
	console.log("* node kimai-load.mjs notas.txt | Ejecutar un dry-run");
	console.log("* node kimai-load.mjs notas.txt --apply | Cargar las horas");
	console.log("* node kimai-load.mjs notas.txt --apply --force | Forzar la carga\n");
	
	console.log("\n=== Flags ===\n")
	console.log("* node kimai-load.mjs --list | Verificar proyecto y actividades");
	console.log("* El archivo .env se carga automáticamente\n");

}
async function main() {
  if (HELP) return printHelp();
  if (LIST) return listRefs();
  if (!file) {
    console.error("Indicá el archivo de notas. Ej: node kimai-load.mjs notas.txt");
    process.exit(1);
  }

  const days = parseNotes(readFileSync(file, "utf8"));
  const [sh, sm] = START_TIME.split(":").map(Number);
  let errors = 0;

  for (const [date, tickets] of days) {
    if (tickets.length === 0) continue;

    const unknown = tickets.filter(({ key }) => !PREFIX_MAP[key.split("-")[0]]);
    if (unknown.length) {
      console.warn(`[${date}] prefijo desconocido: ${unknown.map(({ key }) => key).join(", ")} -> día omitido`);
      errors++;
      continue;
    }
    const unset = tickets.filter((t) => {
      const c = PREFIX_MAP[t.key.split("-")[0]];
      return !c.project || !c.activity;
    });
    if (unset.length) {
      console.warn(`[${date}] faltan IDs de proyecto/actividad en PREFIX_MAP para: ${unset.map(({ key }) => key).join(", ")}`);
      errors++;
      continue;
    }

    if (APPLY && !FORCE) {
      const existing = await api(
        `/api/timesheets?begin=${date}T00:00:00&end=${date}T23:59:59`
      );
      if (existing.length > 0) {
        console.log(`[${date}] ya tiene ${existing.length} entrada(s), se omite (usá --force para cargar igual)`);
        continue;
      }
    }

    const mins = splitMinutes(HOURS_PER_DAY * 60, tickets.length);
    let cursor = sh * 60 + sm;

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const cfg = PREFIX_MAP[ticket.key.split("-")[0]];
      const body = {
        project: cfg.project,
        activity: cfg.activity,
        begin: `${date}T${hms(cursor)}`,
        end: `${date}T${hms(cursor + mins[i])}`,
        description: await ticketDescription(ticket.key, ticket.url),
      };
      cursor += mins[i];

      const label = `[${date}] ${body.description} (${cfg.name}) ${body.begin.slice(11, 16)}-${body.end.slice(11, 16)} = ${fmtDur(mins[i])}`;
      if (!APPLY) {
        console.log("DRY-RUN", label);
        continue;
      }
      try {
        await api("/api/timesheets", { method: "POST", body: JSON.stringify(body) });
        console.log("OK     ", label);
      } catch (e) {
        errors++;
        console.error("ERROR  ", label, "\n        ", e.message);
      }
    }

    console.log(`[${date}] TOTAL ${fmtDur(mins.reduce((a, b) => a + b, 0))} (${tickets.length} entradas, hasta ${hms(cursor).slice(0, 5)})\n`);
  }

  if (!APPLY) console.log("Dry-run: no se cargó nada. Agregá --apply para cargar.");
  if (errors) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
