# Kimai Load

Script de línea de comandos para cargar horas en [Kimai](https://www.kimai.org/) a partir de notas diarias con tickets de Jira.

El programa:

- Lee fechas y claves de tickets desde un archivo de texto.
- Asigna cada ticket al proyecto y actividad configurados en Kimai.
- Reparte automáticamente las horas del día entre los tickets encontrados.
- Genera las entradas consecutivas desde una hora de inicio configurable.
- Ejecuta un **dry-run por defecto**, por lo que no modifica Kimai salvo que se use `--apply`.
- Opcionalmente consulta Jira para incluir el título del ticket en la descripción.

## Requisitos

- Node.js 18 o superior.
- Una instancia de Kimai accesible por HTTP(S).
- Un token/API key de Kimai con permisos para consultar y crear partes de horas.
- Los IDs de proyectos y actividades de Kimai.

No requiere instalar dependencias: usa el `fetch` nativo de Node.js.

## Configuración

### Variables de entorno

Definí estas variables antes de ejecutar el script:

```bash
export KIMAI_URL="https://kimai.tuempresa.com"
export KIMAI_TOKEN="tu-token-de-kimai"
```

Por defecto, el token se envía como `Authorization: Bearer <token>`. Para instalaciones antiguas que usan `X-AUTH-TOKEN`, agregá:

```bash
export KIMAI_LEGACY_HEADER=1
```

La integración con Jira es opcional. Si se configuran ambas variables, el script consulta el título de cada ticket y lo agrega a la descripción:

```bash
export JIRA_EMAIL="tu-email"
export JIRA_TOKEN="tu-token-de-jira"
export JIRA_URL="https://tu-instancia.atlassian.net" # opcional
```

No guardes tokens directamente en el repositorio. Usá variables de entorno o un gestor de secretos.

### Configuración dentro del script

Antes de usarlo en otro entorno, revisá la sección `Configuración` de [kimai-load.mjs](kimai-load.mjs):

- `HOURS_PER_DAY`: total de horas a cargar por día. Por defecto: `8`.
- `START_TIME`: hora inicial de la primera entrada. Por defecto: `08:00`.
- `BLOCK_MIN`: tamaño mínimo/redondeo de los bloques. Por defecto: `5` minutos.
- `CUSTOMER_ID`: cliente que se usa al listar proyectos.
- `PREFIX_MAP`: relación entre el prefijo del ticket y los IDs de proyecto/actividad.

Ejemplo:

```js
const PREFIX_MAP = {
  CP: { name: "Connect Pacientes", project: 43, activity: 274 },
  MC: { name: "Markey Connect", project: 55, activity: 274 },
};
```

Los IDs son específicos de cada instancia de Kimai. No copies esta configuración sin verificarla.

## Formato del archivo de notas

El parser reconoce una fecha al comienzo de una línea con formato `DD/MM/YYYY`. En las líneas siguientes busca cualquier clave con formato `PREFIJO-NÚMERO`.

Por ejemplo:

```text
31/08/2026 Lunes
  • https://jira.example.com/browse/CP-742
  • https://jira.example.com/browse/CP-749

01/09/2026 Martes
  • CP-738
  • CP-749
```

La fecha actual permanece activa hasta encontrar otra fecha. Las claves repetidas dentro del mismo día se ignoran.

## Uso

### 1. Verificar proyectos y actividades

```bash
node kimai-load.mjs --list
```

Este comando muestra los proyectos visibles del cliente configurado y las actividades de cada proyecto definido en `PREFIX_MAP`.

### 2. Ejecutar un dry-run

```bash
node kimai-load.mjs notas.txt
```

Muestra las entradas que se crearían, pero no realiza cambios en Kimai. Usá esta modalidad para revisar fechas, tickets, horarios y duración.

### 3. Cargar las horas

```bash
node kimai-load.mjs notas.txt --apply
```

Antes de cargar, el script comprueba si cada día ya tiene entradas en Kimai. Si encuentra alguna, omite ese día para evitar duplicados.

### 4. Forzar la carga

```bash
node kimai-load.mjs notas.txt --apply --force
```

Carga las entradas aunque el día ya tenga registros. Usá `--force` con cuidado: puede crear duplicados.

## Ejemplo completo

```bash
export KIMAI_URL="https://kimai.example.com"
export KIMAI_TOKEN="..."

# Primero revisar la configuración y la salida
node kimai-load.mjs notas.txt

# Si todo está correcto, cargar
node kimai-load.mjs notas.txt --apply
```

## Cómo se distribuyen las horas

Para cada día con `n` tickets, el script reparte `HOURS_PER_DAY` entre esos tickets y redondea cada bloque a múltiplos de `BLOCK_MIN`. El último bloque absorbe cualquier diferencia del redondeo.

Con la configuración predeterminada, dos tickets reciben aproximadamente cuatro horas cada uno y las entradas se encadenan desde las `08:00`.

## Comportamiento y errores

- Un prefijo que no existe en `PREFIX_MAP` hace que se omita el día completo.
- Si falta el proyecto o la actividad de un prefijo, también se omite el día.
- Los errores de creación se muestran en pantalla y hacen que el proceso termine con código de salida `1`.
- Si Jira no responde, se utiliza igualmente la clave del ticket como descripción.
- El script utiliza estos endpoints de la API de Kimai:
  - `GET /api/projects`
  - `GET /api/activities`
  - `GET /api/timesheets`
  - `POST /api/timesheets`

## Estructura del proyecto

```text
.
├── kimai-load.mjs  # script principal
├── notas.txt       # ejemplo de entrada con notas diarias
└── README.md       # documentación
```

## Seguridad

- Tratá `KIMAI_TOKEN`, `JIRA_TOKEN` y `JIRA_EMAIL` como secretos.
- No los incluyas en `notas.txt`, commits, capturas de pantalla ni logs.
- Probá siempre primero sin `--apply`.
- Revisá especialmente la configuración de `PREFIX_MAP` antes de cargar datos en una instancia real.
